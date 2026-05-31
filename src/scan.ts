/**
 * High-level scan pipeline — now an ENSEMBLE.
 *
 * A single token is judged by several independent detectors and their results
 * are fused into one verdict:
 *
 *   - bulletproof-sim : our own anvil fork buy→sell round-trip (the deep, owned
 *                       check) — runs only on chains we can fork.
 *   - goplus          : GoPlus Security static/heuristic analysis — ~40 chains.
 *   - honeypot.is     : independent live buy/sell simulation — major EVM chains.
 *
 * This is what lets Bullet Proof cover essentially any address a user pastes:
 * even when we can't fork the chain ourselves, the external detectors still vote.
 * Each detector is fault-isolated — a dead fork RPC or a provider outage degrades
 * to "one fewer opinion", never a crash or a bogus verdict.
 *
 * Flow:
 *   detect chain (+ numeric id) -> run [sim ‖ goplus ‖ honeypot.is] -> aggregate
 */
import { getAddress, type Address, type PublicClient } from 'viem';
import { AnvilFork } from './anvil.js';
import { config } from './config.js';
import { makePublicClient, makeWalletClient, testAccount } from './clients.js';
import { erc20Abi } from './abi.js';
import { resolveChain, type ChainConfig } from './chains.js';
import { discoverToken, type TokenInfo, type Discovery } from './discover.js';
import { fundWallet } from './wallet.js';
import { captureSnapshotEx } from './snapshot.js';
import { simulateRoundTrip } from './honeypot.js';
import { analyze, diffBalances, diffStorage } from './statediff.js';
import { runExternalProviders, aggregate } from './providers/ensemble.js';
import type { ProviderResult } from './providers/types.js';
import type { Anomaly, BalanceDelta, HoneypotReport, RoundTripResult } from './types.js';

/**
 * Strip credentials/path/query from each comma-separated RPC URL, leaving only
 * the host. FORK_RPC_URL routinely embeds an Alchemy/Infura API key in its path;
 * since the web app persists and returns this report verbatim, the key must NEVER
 * appear here. Falls back to 'redacted' for anything we can't parse.
 */
function sanitizeRpcUrl(raw: string): string {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u).host;
      } catch {
        return 'redacted';
      }
    })
    .join(',');
}

export interface ScanOptions {
  token: string;
  buyEth?: number;
  /** Chain key (e.g. "ethereum", "bsc"). When omitted, the chain is auto-detected. */
  chain?: string;
  /** Pre-computed discovery (from the worker), so we don't look it up twice. */
  discovery?: Discovery;
  /** Reuse an already-running fork instead of spawning a new one. */
  fork?: AnvilFork;
}

/**
 * Confirm the address is an ERC-20 on the forked chain before the heavy pipeline,
 * turning a deep raw viem error ("balanceOf returned no data (0x)…") into a clear
 * message. Auto-detect normally guarantees this, but a manual chain override (or
 * a token that's a contract-but-not-ERC-20) still needs the guard.
 */
async function assertScannableToken(
  client: PublicClient,
  token: Address,
  chainName: string,
): Promise<void> {
  const code = await client.getCode({ address: token });
  if (!code || code === '0x') {
    throw new Error(
      `Not a token contract on ${chainName}. This looks like a wallet address, ` +
        'or a token deployed on a different chain.',
    );
  }
  try {
    await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [testAccount.address],
    });
  } catch {
    throw new Error(
      "This contract doesn't implement the standard ERC-20 balanceOf function, " +
        `so it is not a token Bullet Proof can simulate on ${chainName} (it may be ` +
        'an NFT or a proxy contract).',
    );
  }
}

/** Result of the owned anvil round-trip, packaged for the ensemble + report. */
interface SimOutcome {
  provider: ProviderResult;
  roundTrip: RoundTripResult | null;
  balanceDiff: BalanceDelta[];
  storageDiff: HoneypotReport['storageDiff'];
  blockNumber: string;
  onchainMeta?: Partial<TokenInfo>;
}

/** A non-usable sim result (fork died, not an ERC-20, …) — it abstains from the vote. */
function simErrorProvider(message: string): ProviderResult {
  return {
    source: 'bulletproof-sim',
    label: 'Bullet Proof simulation',
    supported: true,
    ok: false,
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    score: null,
    weight: 1.2,
    signals: [],
    error: message,
  };
}

/** Convert a completed round-trip into a normalized provider vote. */
function simToProvider(roundTrip: RoundTripResult, anomalies: Anomaly[]): ProviderResult {
  // The sim only "votes" if it actually got far enough to test sellability — a
  // token it couldn't even buy is INCONCLUSIVE (never a SAFE signal), so it
  // abstains and lets the external detectors decide (CLAUDE.md §3).
  const usable = roundTrip.canBuy;
  const isHoneypot = roundTrip.canBuy && !roundTrip.canSell ? true : usable ? false : null;
  return {
    source: 'bulletproof-sim',
    label: 'Bullet Proof simulation',
    supported: true,
    ok: usable,
    isHoneypot,
    buyTax: roundTrip.buyTax >= 0 ? roundTrip.buyTax : null,
    sellTax: roundTrip.sellTax >= 0 ? roundTrip.sellTax : null,
    score: null,
    weight: 1.2, // our own live round-trip is the most trusted voice
    signals: anomalies.map((a) => ({ severity: a.severity, code: a.code, message: a.message })),
    ...(usable ? {} : { error: 'token not buyable on the forked DEX — inconclusive' }),
  };
}

/** Run the owned anvil simulation. Throws only on infra failure (caller isolates it). */
async function runSim(
  opts: ScanOptions,
  token: Address,
  buyEth: number,
  chain: ChainConfig,
): Promise<SimOutcome> {
  const ownsFork = !opts.fork;
  const fork = opts.fork ?? new AnvilFork();
  if (ownsFork) await fork.start({ quiet: true, forkUrl: chain.rpcUrl, chainId: chain.chainId });

  try {
    const publicClient = makePublicClient(fork.endpoint, chain.chainId, chain.nativeSymbol);
    const walletClient = makeWalletClient(fork.endpoint, chain.chainId, chain.nativeSymbol);
    const wallet = testAccount.address;

    await assertScannableToken(publicClient, token, chain.name);

    await fundWallet(fork, wallet);

    const beforeCap = await captureSnapshotEx({
      fork,
      client: publicClient,
      wallet,
      token,
      label: 'before-interaction',
      takeEvmSnapshot: true,
      weth: chain.weth,
    });
    const before = beforeCap.snapshot;

    const roundTrip = await simulateRoundTrip({
      publicClient,
      walletClient,
      wallet,
      token,
      buyEth,
      router: chain.router,
      weth: chain.weth,
    });

    const after = (
      await captureSnapshotEx({
        fork,
        client: publicClient,
        wallet,
        token,
        label: 'after-interaction',
        weth: chain.weth,
        ...(beforeCap.slot ? { knownSlot: beforeCap.slot } : {}),
      })
    ).snapshot;

    const onchainMeta = await readOnchainMeta(publicClient, token).catch(() => undefined);

    const balanceDiff = diffBalances(before, after);
    const storageDiff = diffStorage(before, after);
    const { anomalies } = analyze(roundTrip, storageDiff);

    return {
      provider: simToProvider(roundTrip, anomalies),
      roundTrip,
      balanceDiff,
      storageDiff,
      blockNumber: before.blockNumber.toString(),
      ...(onchainMeta ? { onchainMeta } : {}),
    };
  } finally {
    if (ownsFork) await fork.stop();
  }
}

export async function runScan(opts: ScanOptions): Promise<HoneypotReport> {
  const started = Date.now();
  const token = getAddress(opts.token);
  const buyEth = opts.buyEth ?? config.wallet.buyEth;

  // --- Resolve the chain --------------------------------------------------
  // Manual override wins; otherwise auto-detect (DexScreener + RPC probe). We
  // keep BOTH the forkable ChainConfig (if any) and the numeric chain id (which
  // may exist even for chains we can't fork — that's what powers the externals).
  let chain: ChainConfig | undefined;
  let tokenInfo: TokenInfo | undefined;
  let externalChainId: number | undefined;

  if (opts.chain) {
    chain = resolveChain(opts.chain);
    externalChainId = chain.chainId;
    tokenInfo = opts.discovery?.info;
  } else {
    const discovery = opts.discovery ?? (await discoverToken(token));
    tokenInfo = discovery.info;
    externalChainId = discovery.chainId;
    if (discovery.chainKey) chain = resolveChain(discovery.chainKey);
  }

  // --- Run every applicable detector concurrently -------------------------
  const externalP: Promise<ProviderResult[]> = externalChainId
    ? runExternalProviders(token, externalChainId, started)
    : Promise.resolve([]);

  let sim: SimOutcome | null = null;
  if (chain) {
    sim = await runSim(opts, token, buyEth, chain).catch((err) => ({
      provider: simErrorProvider((err as Error).message),
      roundTrip: null,
      balanceDiff: [],
      storageDiff: [],
      blockNumber: '0',
    }));
  }

  const external = await externalP;
  const sources: ProviderResult[] = [];
  if (sim) sources.push(sim.provider);
  sources.push(...external);

  // Fill thin tokenInfo with on-chain name/symbol/decimals from the sim probe.
  if (sim?.onchainMeta && (!tokenInfo || !tokenInfo.symbol)) {
    tokenInfo = {
      detectedVia: tokenInfo?.detectedVia ?? 'rpc-probe',
      ...(chain ? { detectedChainId: chain.dexscreenerId, detectedChainName: chain.name, explorerUrl: `${chain.explorer}/token/${token}` } : {}),
      ...sim.onchainMeta,
      ...tokenInfo,
    };
  }

  // --- Aggregate ----------------------------------------------------------
  const agg = aggregate(sources);
  const chainName = chain?.name ?? tokenInfo?.detectedChainName;

  if (agg.usableCount === 0) {
    // No detector could judge it — return a helpful info-only ERROR (no verdict).
    const msg = noVerdictMessage(tokenInfo, chainName);
    return errorReport(token, msg, chain, tokenInfo, started, sources, chainName, externalChainId);
  }

  const roundTrip = sim?.roundTrip ?? null;
  return {
    target: token,
    verdict: agg.verdict,
    riskScore: agg.riskScore,
    summary: summarize(agg, sources, roundTrip),
    ...(chain ? { chain: chain.key } : {}),
    ...(chainName ? { chainName } : {}),
    ...(tokenInfo ? { tokenInfo } : {}),
    sources,
    roundTrip,
    balanceDiff: sim?.balanceDiff ?? [],
    storageDiff: sim?.storageDiff ?? [],
    anomalies: agg.anomalies,
    fork: {
      rpcUrl: chain ? sanitizeRpcUrl(chain.rpcUrl) : '',
      blockNumber: sim?.blockNumber ?? '0',
      chainId: chain?.chainId ?? externalChainId ?? 0,
    },
    durationMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}

/** Build a structured ERROR report without a usable verdict. */
function errorReport(
  token: Address,
  message: string,
  chain: ChainConfig | undefined,
  tokenInfo: TokenInfo | undefined,
  started: number,
  sources: ProviderResult[],
  chainName: string | undefined,
  externalChainId: number | undefined,
): HoneypotReport {
  return {
    target: token,
    verdict: 'ERROR',
    riskScore: 0,
    summary: `Scan could not complete: ${message}`,
    ...(chain ? { chain: chain.key } : {}),
    ...(chainName ? { chainName } : {}),
    ...(tokenInfo ? { tokenInfo } : {}),
    sources,
    roundTrip: null,
    balanceDiff: [],
    storageDiff: [],
    anomalies: [{ severity: 'critical', code: 'SCAN_ERROR', message }],
    fork: {
      rpcUrl: chain ? sanitizeRpcUrl(chain.rpcUrl) : '',
      blockNumber: '0',
      chainId: chain?.chainId ?? externalChainId ?? 0,
    },
    durationMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}

/** Message for the no-usable-verdict case (non-EVM chain, not found, all providers down). */
function noVerdictMessage(tokenInfo: TokenInfo | undefined, chainName: string | undefined): string {
  if (!tokenInfo || tokenInfo.detectedVia === 'none') {
    return (
      "Couldn't find this token on any supported network. Make sure it's a token " +
      'contract address (not a wallet) on an EVM chain.'
    );
  }
  if (chainName) {
    return (
      `This token was detected on ${chainName}, but none of our detectors could ` +
      'analyze it right now (the chain may be non-EVM or temporarily unavailable). ' +
      'The info below is what we could gather.'
    );
  }
  return 'No security detector could analyze this token right now. The info below is what we could gather.';
}

/** Lightweight on-chain ERC-20 read used to fill tokenInfo when discovery was thin. */
async function readOnchainMeta(client: PublicClient, token: Address): Promise<Partial<TokenInfo>> {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }).catch(() => undefined),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => undefined),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => undefined),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => undefined),
  ]);
  return {
    ...(name !== undefined ? { name: String(name) } : {}),
    ...(symbol !== undefined ? { symbol: String(symbol) } : {}),
    ...(decimals !== undefined ? { decimals: Number(decimals) } : {}),
    ...(totalSupply !== undefined ? { totalSupply: String(totalSupply) } : {}),
  };
}

function summarize(
  agg: ReturnType<typeof aggregate>,
  sources: ProviderResult[],
  rt: RoundTripResult | null,
): string {
  if (agg.verdict === 'ERROR') return 'Scan could not complete.';
  const parts = [`Verdict: ${agg.verdict} (risk ${agg.riskScore}/100).`];
  if (rt && rt.canBuy && !rt.canSell) parts.push('Our live simulation could BUY but NOT sell this token.');
  if (agg.sellTax != null) parts.push(`Sell tax ~${(agg.sellTax * 100).toFixed(1)}%.`);
  const checked = sources.filter((s) => s.ok).map((s) => s.label);
  if (checked.length) parts.push(`Checked by ${checked.join(', ')}.`);
  return parts.join(' ');
}

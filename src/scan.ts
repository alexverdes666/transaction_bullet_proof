/**
 * High-level scan pipeline. Wires the whole sandbox together for a single
 * target token and returns a fully-formed {@link HoneypotReport}.
 *
 * Flow:
 *   detect chain (if not given) -> start fork -> fund wallet -> snapshot(before)
 *   -> buy/sell round-trip -> snapshot(after) -> state diff -> analyze -> report
 *
 * The interaction is the deterministic on-chain buy/sell round-trip — the
 * bulletproof core. No browser required.
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
import type { HoneypotReport, RoundTripResult } from './types.js';

/**
 * Strip credentials/path/query from each comma-separated RPC URL, leaving only
 * the host. FORK_RPC_URL routinely embeds an Alchemy/Infura API key in its path
 * (e.g. https://eth-mainnet.g.alchemy.com/v2/<KEY>); since the web app persists
 * and returns this report verbatim, the key must NEVER appear here. Falls back
 * to 'redacted' for anything we can't parse.
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
        `so it is not a token Bullet Proof can scan on ${chainName} (it may be an ` +
        'NFT or a proxy contract).',
    );
  }
}

/** Build a structured ERROR report without running (or needing) a fork. */
function errorReport(
  token: Address,
  message: string,
  chain: ChainConfig | undefined,
  tokenInfo: TokenInfo | undefined,
  started: number,
): HoneypotReport {
  return {
    target: token,
    verdict: 'ERROR',
    riskScore: 0,
    summary: `Scan could not complete: ${message}`,
    ...(chain ? { chain: chain.key, chainName: chain.name } : {}),
    ...(tokenInfo ? { tokenInfo } : {}),
    roundTrip: null,
    balanceDiff: [],
    storageDiff: [],
    anomalies: [{ severity: 'critical', code: 'SCAN_ERROR', message }],
    fork: {
      rpcUrl: chain ? sanitizeRpcUrl(chain.rpcUrl) : '',
      blockNumber: '0',
      chainId: chain?.chainId ?? 0,
    },
    durationMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}

export async function runScan(opts: ScanOptions): Promise<HoneypotReport> {
  const started = Date.now();
  const token = getAddress(opts.token);
  const buyEth = opts.buyEth ?? config.wallet.buyEth;

  // --- Resolve the chain --------------------------------------------------
  // Manual override wins; otherwise auto-detect (DexScreener + RPC probe).
  let chain: ChainConfig;
  let tokenInfo: TokenInfo | undefined;
  if (opts.chain) {
    chain = resolveChain(opts.chain);
    tokenInfo = opts.discovery?.info;
  } else {
    const discovery = opts.discovery ?? (await discoverToken(token));
    tokenInfo = discovery.info;
    if (!discovery.chainKey) {
      // Detected somewhere we can't simulate, or not found at all — return a
      // helpful info-only ERROR (no fork spun).
      const where = discovery.info.detectedChainName;
      const msg =
        discovery.info.detectedVia === 'none'
          ? "Couldn't find this token on any supported network. Make sure it's a " +
            'token contract address on Ethereum, BNB Chain, Polygon, Base, Arbitrum or Avalanche.'
          : `This token was detected on ${where}, which Bullet Proof can't simulate trades ` +
            'on yet. The info below is what we could gather; the buy/sell honeypot test ' +
            'is only available on Ethereum, BNB Chain, Polygon, Base, Arbitrum and Avalanche.';
      return errorReport(token, msg, undefined, tokenInfo, started);
    }
    chain = resolveChain(discovery.chainKey);
  }

  const ownsFork = !opts.fork;
  const fork = opts.fork ?? new AnvilFork();
  if (ownsFork) await fork.start({ quiet: true, forkUrl: chain.rpcUrl, chainId: chain.chainId });

  try {
    const publicClient = makePublicClient(fork.endpoint, chain.chainId, chain.nativeSymbol);
    const walletClient = makeWalletClient(fork.endpoint, chain.chainId, chain.nativeSymbol);
    const wallet = testAccount.address;

    await assertScannableToken(publicClient, token, chain.name);

    // a. Fund the mock retail wallet with local native gas.
    await fundWallet(fork, wallet);

    // b. Record the "before" snapshot (and a revertible EVM checkpoint).
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

    // c. Drive the deterministic on-chain buy/sell round-trip.
    const roundTrip: RoundTripResult = await simulateRoundTrip({
      publicClient,
      walletClient,
      wallet,
      token,
      buyEth,
      router: chain.router,
      weth: chain.weth,
    });

    // After-interaction snapshot (reuse the discovered balance slot — PERF-1).
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

    // Enrich tokenInfo with on-chain name/symbol/decimals when discovery didn't
    // already provide them (e.g. manual chain override with no DexScreener data).
    if (!tokenInfo || !tokenInfo.symbol) {
      const onchain = await readOnchainMeta(publicClient, token);
      tokenInfo = {
        detectedVia: tokenInfo?.detectedVia ?? 'rpc-probe',
        detectedChainId: chain.dexscreenerId,
        detectedChainName: chain.name,
        explorerUrl: `${chain.explorer}/token/${token}`,
        ...onchain,
        ...tokenInfo,
      };
    }

    // d. Strict state diff.
    const balanceDiff = diffBalances(before, after);
    const storageDiff = diffStorage(before, after);
    const { anomalies, riskScore, verdict } = analyze(roundTrip, storageDiff);

    const report: HoneypotReport = {
      target: token,
      verdict,
      riskScore,
      summary: summarize(verdict, riskScore, roundTrip),
      chain: chain.key,
      chainName: chain.name,
      ...(tokenInfo ? { tokenInfo } : {}),
      roundTrip,
      balanceDiff,
      storageDiff,
      anomalies,
      fork: {
        rpcUrl: sanitizeRpcUrl(chain.rpcUrl),
        blockNumber: before.blockNumber.toString(),
        chainId: chain.chainId,
      },
      durationMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
    return report;
  } catch (err) {
    return errorReport(token, (err as Error).message, chain, tokenInfo, started);
  } finally {
    if (ownsFork) await fork.stop();
  }
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
  verdict: HoneypotReport['verdict'],
  score: number,
  rt: RoundTripResult | null,
): string {
  if (verdict === 'ERROR') return 'Scan could not complete.';
  const parts = [`Verdict: ${verdict} (risk ${score}/100).`];
  if (rt) {
    parts.push(rt.canBuy ? 'Token is buyable.' : 'Token is NOT buyable on the configured router.');
    if (rt.canBuy) {
      parts.push(rt.canSell ? 'Token is sellable.' : 'Token is NOT sellable (sell reverts).');
    }
    if (rt.canSell && rt.sellTax >= 0) parts.push(`Sell tax ~${(rt.sellTax * 100).toFixed(1)}%.`);
  }
  return parts.join(' ');
}

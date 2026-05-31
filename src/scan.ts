/**
 * High-level scan pipeline. Wires the whole sandbox together for a single
 * target token and returns a fully-formed {@link HoneypotReport}.
 *
 * Flow:
 *   start fork -> fund wallet -> snapshot(before) -> buy/sell round-trip ->
 *   snapshot(after) -> state diff -> analyze -> report
 *
 * The interaction is the deterministic on-chain buy/sell round-trip — the
 * bulletproof core. No browser required.
 */
import { getAddress, type Address, type PublicClient } from 'viem';
import { AnvilFork } from './anvil.js';
import { config } from './config.js';
import { makePublicClient, makeWalletClient, testAccount } from './clients.js';
import { erc20Abi } from './abi.js';
import { resolveChain } from './chains.js';
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
  /** Chain key (e.g. "ethereum", "bsc"). Defaults to Ethereum. */
  chain?: string;
  /** Reuse an already-running fork instead of spawning a new one. */
  fork?: AnvilFork;
}

/**
 * Fail fast with a plain-English reason when the address isn't a scannable ERC-20
 * on the selected chain, instead of surfacing a raw viem error ("balanceOf
 * returned no data (0x)…") deep from captureSnapshot. The two common cases: a
 * non-contract address (a wallet, or a token that lives on a DIFFERENT chain than
 * the one selected), and a contract that doesn't implement ERC-20 balanceOf (an
 * NFT, a proxy, etc.). Thrown errors flow through runScan's catch into a clean
 * ERROR report. `chainName` names the chain we actually forked, so the message
 * tells the user where we looked.
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
        'or a token deployed on a different chain. Pick the correct network for ' +
        'this address (Bullet Proof supports Ethereum, BNB Chain, Polygon, Base, ' +
        'Arbitrum and Avalanche).',
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
        'NFT, a proxy contract, or a token on another chain).',
    );
  }
}

export async function runScan(opts: ScanOptions): Promise<HoneypotReport> {
  const started = Date.now();
  const token = getAddress(opts.token);
  const buyEth = opts.buyEth ?? config.wallet.buyEth;
  // Resolve the target chain (throws on an unsupported key). All chain-specific
  // values — fork RPC, DEX router, wrapped-native, reported chainId — come from here.
  const chain = resolveChain(opts.chain);

  const ownsFork = !opts.fork;
  // When we own the fork, point it at the resolved chain's RPC. When the caller
  // supplies a fork (worker path) it was already started for this chain.
  const fork = opts.fork ?? new AnvilFork();
  if (ownsFork) await fork.start({ quiet: true, forkUrl: chain.rpcUrl, chainId: chain.chainId });

  try {
    const publicClient = makePublicClient(fork.endpoint, chain.chainId, chain.nativeSymbol);
    const walletClient = makeWalletClient(fork.endpoint, chain.chainId, chain.nativeSymbol);
    const wallet = testAccount.address;

    // Reject wrong-chain / non-ERC-20 addresses up front with a clear message,
    // rather than letting balanceOf fail with a raw viem dump mid-pipeline.
    await assertScannableToken(publicClient, token, chain.name);

    // a. Fund the mock retail wallet with local ETH.
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

    // After-interaction snapshot. PERF-1: if the before-snapshot already located
    // the balance slot (the wallet held the token pre-trade), reuse it so we skip
    // a second brute-force discovery. The mapping base slot is immutable, so this
    // is exact. When the before-snapshot found nothing (the usual case: balance
    // was zero pre-buy, so the slot is undiscoverable then), we fall through to a
    // fresh discovery here — preserving the original behaviour.
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

    // d. Strict state diff.
    const balanceDiff = diffBalances(before, after);
    const storageDiff = diffStorage(before, after);
    const { anomalies, riskScore, verdict } = analyze(roundTrip, storageDiff);

    const report: HoneypotReport = {
      target: token,
      verdict,
      riskScore,
      summary: summarize(verdict, riskScore, roundTrip),
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
    // Surface infra failures as a structured ERROR report rather than throwing.
    return {
      target: token,
      verdict: 'ERROR',
      riskScore: 0,
      summary: `Scan failed: ${(err as Error).message}`,
      roundTrip: null,
      balanceDiff: [],
      storageDiff: [],
      anomalies: [
        { severity: 'critical', code: 'SCAN_ERROR', message: (err as Error).message },
      ],
      fork: {
        rpcUrl: sanitizeRpcUrl(chain.rpcUrl),
        blockNumber: '0',
        chainId: chain.chainId,
      },
      durationMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    if (ownsFork) await fork.stop();
  }
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

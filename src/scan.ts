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
import { getAddress } from 'viem';
import { AnvilFork } from './anvil.js';
import { config } from './config.js';
import { makePublicClient, makeWalletClient, testAccount } from './clients.js';
import { fundWallet } from './wallet.js';
import { captureSnapshot } from './snapshot.js';
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
  /** Reuse an already-running fork instead of spawning a new one. */
  fork?: AnvilFork;
}

export async function runScan(opts: ScanOptions): Promise<HoneypotReport> {
  const started = Date.now();
  const token = getAddress(opts.token);
  const buyEth = opts.buyEth ?? config.wallet.buyEth;

  const ownsFork = !opts.fork;
  const fork = opts.fork ?? new AnvilFork();
  if (ownsFork) await fork.start({ quiet: true });

  try {
    const publicClient = makePublicClient(fork.endpoint);
    const walletClient = makeWalletClient(fork.endpoint);
    const wallet = testAccount.address;

    // a. Fund the mock retail wallet with local ETH.
    await fundWallet(fork, wallet);

    // b. Record the "before" snapshot (and a revertible EVM checkpoint).
    const before = await captureSnapshot({
      fork,
      client: publicClient,
      wallet,
      token,
      label: 'before-interaction',
      takeEvmSnapshot: true,
    });

    // c. Drive the deterministic on-chain buy/sell round-trip.
    const roundTrip: RoundTripResult = await simulateRoundTrip({
      publicClient,
      walletClient,
      wallet,
      token,
      buyEth,
    });

    // After-interaction snapshot.
    const after = await captureSnapshot({
      fork,
      client: publicClient,
      wallet,
      token,
      label: 'after-interaction',
    });

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
        rpcUrl: sanitizeRpcUrl(config.fork.rpcUrl),
        blockNumber: before.blockNumber.toString(),
        chainId: config.fork.chainId,
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
        rpcUrl: sanitizeRpcUrl(config.fork.rpcUrl),
        blockNumber: '0',
        chainId: config.fork.chainId,
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

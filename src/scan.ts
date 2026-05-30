/**
 * High-level scan pipeline. Wires the whole sandbox together for a single
 * target token and returns a fully-formed {@link HoneypotReport}.
 *
 * Flow:
 *   start fork -> fund wallet -> snapshot(before) -> [interaction] ->
 *   snapshot(after) -> state diff -> analyze -> report
 *
 * Two interaction modes:
 *   - 'simulate' (default): the deterministic on-chain buy/sell round-trip. No
 *      browser required; this is the bulletproof core.
 *   - 'external': skip the built-in swap and instead wait for an outside actor
 *      (the Python/Camoufox layer driving a dApp frontend) to push transactions
 *      to the fork. The diff still runs over whatever state changed.
 */
import { type Address, getAddress } from 'viem';
import { AnvilFork } from './anvil.js';
import { config } from './config.js';
import { makePublicClient, makeWalletClient, testAccount } from './clients.js';
import { fundWallet } from './wallet.js';
import { captureSnapshot } from './snapshot.js';
import { simulateRoundTrip } from './honeypot.js';
import { analyze, diffBalances, diffStorage } from './statediff.js';
import type { HoneypotReport, RoundTripResult } from './types.js';

export interface ScanOptions {
  token: string;
  buyEth?: number;
  mode?: 'simulate' | 'external';
  /** For 'external' mode: async fn that performs the off-engine interaction
   *  (e.g. spawn Camoufox) and resolves once transactions are mined. */
  externalInteraction?: (ctx: ExternalContext) => Promise<void>;
  /** Reuse an already-running fork instead of spawning a new one. */
  fork?: AnvilFork;
}

export interface ExternalContext {
  rpcUrl: string;
  wallet: Address;
  token: Address;
}

export async function runScan(opts: ScanOptions): Promise<HoneypotReport> {
  const started = Date.now();
  const token = getAddress(opts.token);
  const mode = opts.mode ?? 'simulate';
  const buyEth = opts.buyEth ?? config.wallet.buyEth;

  const ownsFork = !opts.fork;
  const fork = opts.fork ?? new AnvilFork();
  if (ownsFork) await fork.start({ quiet: true });

  try {
    const publicClient = makePublicClient();
    const walletClient = makeWalletClient();
    const wallet = testAccount.address;

    // a. Fund the mock retail wallet with local ETH.
    await fundWallet(fork, wallet);

    // c. Record the "before" snapshot (and a revertible EVM checkpoint).
    const before = await captureSnapshot({
      fork,
      client: publicClient,
      wallet,
      token,
      label: 'before-interaction',
      takeEvmSnapshot: true,
    });

    // d. Drive the interaction.
    let roundTrip: RoundTripResult | null = null;
    if (mode === 'simulate') {
      roundTrip = await simulateRoundTrip({ publicClient, walletClient, wallet, token, buyEth });
    } else {
      if (!opts.externalInteraction) {
        throw new Error("mode 'external' requires an externalInteraction callback");
      }
      await opts.externalInteraction({ rpcUrl: fork.endpoint, wallet, token });
    }

    // After-interaction snapshot.
    const after = await captureSnapshot({
      fork,
      client: publicClient,
      wallet,
      token,
      label: 'after-interaction',
    });

    // e. Strict state diff.
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
        rpcUrl: config.fork.rpcUrl,
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
        rpcUrl: config.fork.rpcUrl,
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

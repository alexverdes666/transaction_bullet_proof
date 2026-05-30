/**
 * The State Diff engine.
 *
 * Given two snapshots (before / after an interaction) plus the round-trip swap
 * result, it produces:
 *   1. A per-asset balance delta table.
 *   2. A raw storage-slot delta (catches balance rewrites that skip events).
 *   3. A list of scored anomalies that explain *why* a token looks malicious.
 *
 * --- How this catches malicious contracts ----------------------------------
 * A legitimate token behaves symmetrically: the ETH you pay to buy is, minus a
 * small honest LP fee + price impact, recoverable when you sell. Honeypots break
 * that symmetry in one of a few measurable ways, each mapped to an anomaly code:
 *
 *   SELL_REVERTED   The sell transaction reverts. The contract lets you buy but
 *                   blocks transfers from non-whitelisted addresses — the single
 *                   strongest honeypot signal.
 *   ZERO_TOKENS     The buy "succeeds" but no tokens actually land in the wallet
 *                   (a fee-on-transfer set to ~100%, or a no-op transfer).
 *   HIGH_SELL_TAX   The sell succeeds but returns far less ETH than an honest
 *                   pool would (getAmountsOut) — a hidden/asymmetric sell tax.
 *   HIGH_BUY_TAX    Large gap between tokens received and tokens quoted.
 *   TAX_ASYMMETRY   Sell tax >> buy tax: the contract is cheap to enter, punishing
 *                   to exit. Classic "you can check in but never leave" design.
 *   ROUNDTRIP_LOSS  End-to-end you recovered far less ETH than you put in.
 *   STORAGE_GHOST   The wallet's token balance storage slot changed in a way the
 *                   ERC-20 balance read does not corroborate (silent rebasing).
 */
import type { Address, Hash } from 'viem';
import type {
  Anomaly,
  BalanceDelta,
  HoneypotReport,
  RoundTripResult,
  StateSnapshot,
} from './types.js';

/** Thresholds (fractions) above which a tax is considered abusive. */
const SELL_TAX_WARN = 0.1; // 10%
const SELL_TAX_CRIT = 0.5; // 50%
const BUY_TAX_WARN = 0.1;
const ROUNDTRIP_LOSS_WARN = 0.15; // 15% total slippage+tax is suspicious
const ROUNDTRIP_LOSS_CRIT = 0.6;
const ASYMMETRY_WARN = 0.2; // sellTax - buyTax exceeding 20pp

export function diffBalances(before: StateSnapshot, after: StateSnapshot): BalanceDelta[] {
  const keyOf = (token: Address | null) => (token ? token.toLowerCase() : 'eth');
  const map = new Map<string, BalanceDelta>();

  for (const b of before.balances) {
    map.set(keyOf(b.token), {
      token: b.token,
      symbol: b.symbol,
      decimals: b.decimals,
      before: b.raw,
      after: b.raw,
      delta: 0n,
    });
  }
  for (const a of after.balances) {
    const k = keyOf(a.token);
    const existing = map.get(k);
    if (existing) {
      existing.after = a.raw;
      existing.delta = a.raw - existing.before;
    } else {
      map.set(k, {
        token: a.token,
        symbol: a.symbol,
        decimals: a.decimals,
        before: 0n,
        after: a.raw,
        delta: a.raw,
      });
    }
  }
  return [...map.values()];
}

export function diffStorage(
  before: StateSnapshot,
  after: StateSnapshot,
): HoneypotReport['storageDiff'] {
  const out: HoneypotReport['storageDiff'] = [];
  for (const a of after.storage) {
    const b = before.storage.find((x) => x.slot === a.slot && x.account === a.account);
    const beforeVal = (b?.value ?? ('0x' + '0'.repeat(64))) as Hash;
    if (beforeVal !== a.value) {
      out.push({
        label: a.label,
        account: a.account,
        slot: a.slot,
        before: beforeVal,
        after: a.value,
      });
    }
  }
  return out;
}

/**
 * Convert a round-trip result + diffs into a list of scored anomalies and an
 * overall risk score (0..100). This is the policy layer — all heuristics live
 * here so they are easy to audit and tune.
 */
export function analyze(
  rt: RoundTripResult | null,
  storageDiff: HoneypotReport['storageDiff'],
): { anomalies: Anomaly[]; riskScore: number; verdict: HoneypotReport['verdict'] } {
  const anomalies: Anomaly[] = [];
  let score = 0;

  if (!rt) {
    anomalies.push({
      severity: 'warning',
      code: 'NO_SIMULATION',
      message: 'Round-trip simulation did not run; verdict is inconclusive.',
    });
    return { anomalies, riskScore: 0, verdict: 'ERROR' };
  }

  if (!rt.canBuy) {
    anomalies.push({
      severity: 'warning',
      code: 'NO_LIQUIDITY',
      message:
        'Token could not be bought on the configured router (no V2 pair / no liquidity / non-standard routing).',
    });
    score += 20;
  }

  if (rt.canBuy && rt.tokensReceived === 0n) {
    anomalies.push({
      severity: 'critical',
      code: 'ZERO_TOKENS',
      message:
        'Buy transaction succeeded but zero tokens were received — fee-on-transfer near 100% or a no-op transfer.',
    });
    score += 70;
  }

  if (rt.canBuy && !rt.canSell) {
    anomalies.push({
      severity: 'critical',
      code: 'SELL_REVERTED',
      message: `Tokens are buyable but the sell reverted: "${rt.revertReason ?? 'unknown'}". This is the defining behaviour of a honeypot.`,
    });
    score += 90;
  }

  if (rt.buyTax >= BUY_TAX_WARN && rt.buyTax >= 0) {
    anomalies.push({
      severity: 'warning',
      code: 'HIGH_BUY_TAX',
      message: `Effective buy tax ~${pct(rt.buyTax)} (tokens received well below the honest quote).`,
    });
    score += Math.min(20, Math.round(rt.buyTax * 40));
  }

  if (rt.canSell && rt.sellTax >= 0) {
    if (rt.sellTax >= SELL_TAX_CRIT) {
      anomalies.push({
        severity: 'critical',
        code: 'HIGH_SELL_TAX',
        message: `Effective sell tax ~${pct(rt.sellTax)} — exiting the position destroys most of its value.`,
      });
      score += 60;
    } else if (rt.sellTax >= SELL_TAX_WARN) {
      anomalies.push({
        severity: 'warning',
        code: 'ELEVATED_SELL_TAX',
        message: `Effective sell tax ~${pct(rt.sellTax)} — above the ${pct(SELL_TAX_WARN)} comfort threshold.`,
      });
      score += 25;
    }
  }

  if (rt.canSell && rt.buyTax >= 0 && rt.sellTax >= 0) {
    const asym = rt.sellTax - rt.buyTax;
    if (asym >= ASYMMETRY_WARN) {
      anomalies.push({
        severity: 'warning',
        code: 'TAX_ASYMMETRY',
        message: `Sell tax exceeds buy tax by ${pct(asym)} — cheap to enter, expensive to exit.`,
      });
      score += 20;
    }
  }

  if (rt.canSell && rt.roundTripLoss >= 0) {
    if (rt.roundTripLoss >= ROUNDTRIP_LOSS_CRIT) {
      anomalies.push({
        severity: 'critical',
        code: 'ROUNDTRIP_LOSS',
        message: `Round-trip recovered only ${pct(1 - rt.roundTripLoss)} of the ETH spent — economically a trap.`,
      });
      score += 40;
    } else if (rt.roundTripLoss >= ROUNDTRIP_LOSS_WARN) {
      anomalies.push({
        severity: 'warning',
        code: 'ROUNDTRIP_LOSS',
        message: `Round-trip lost ${pct(rt.roundTripLoss)} of input value (tax + price impact).`,
      });
      score += 15;
    }
  }

  if (storageDiff.length > 0) {
    anomalies.push({
      severity: 'info',
      code: 'STORAGE_DELTA',
      message: `${storageDiff.length} watched storage slot(s) changed; cross-checked against ERC-20 balances.`,
    });
  }

  score = Math.max(0, Math.min(100, score));

  let verdict: HoneypotReport['verdict'];
  if (score >= 70) verdict = 'HONEYPOT';
  else if (score >= 30) verdict = 'SUSPICIOUS';
  else verdict = 'SAFE';

  return { anomalies, riskScore: score, verdict };
}

function pct(frac: number): string {
  return `${(frac * 100).toFixed(1)}%`;
}

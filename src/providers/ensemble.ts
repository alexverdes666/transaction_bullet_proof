/**
 * Ensemble aggregator.
 *
 * Runs every applicable detector for a token and fuses their normalized
 * {@link ProviderResult}s into one verdict + 0..100 risk score, plus the merged
 * flag list. The philosophy is "actions don't lie, and more independent eyes are
 * safer": a live simulation that fails to sell is decisive, and any single
 * credible honeypot vote pulls the verdict into the danger zone rather than being
 * averaged away.
 *
 * Verdict thresholds match the original engine: <30 SAFE, 30–69 SUSPICIOUS,
 * ≥70 HONEYPOT. ERROR only when NO provider could produce a usable result.
 */
import type { Anomaly } from '../types.js';
import type { ProviderResult } from './types.js';
import { goplusCheck } from './goplus.js';
import { honeypotisCheck, honeypotisMaybeSupports } from './honeypotis.js';

/** Live-simulation sources whose honeypot verdict is treated as decisive. */
const SIM_SOURCES = new Set(['bulletproof-sim', 'honeypot.is']);

/** Per-provider 0..100 risk score from its normalized signals. */
export function scoreProvider(r: ProviderResult): number | null {
  if (!r.ok) return null;
  let s = 0;
  if (r.isHoneypot === true) s = Math.max(s, 90);
  if (r.sellTax != null) {
    if (r.sellTax >= 0.4) s = Math.max(s, 85);
    else if (r.sellTax >= 0.1) s = Math.max(s, 30 + (r.sellTax - 0.1) * 100); // 30..60
  }
  if (r.buyTax != null && r.buyTax >= 0.4) s = Math.max(s, 60);
  for (const sig of r.signals) {
    if (sig.severity === 'critical') s = Math.max(s, 80);
    else if (sig.severity === 'warning') s = Math.max(s, 45);
  }
  return Math.min(100, Math.round(s));
}

export interface Aggregate {
  verdict: 'SAFE' | 'SUSPICIOUS' | 'HONEYPOT' | 'ERROR';
  riskScore: number;
  anomalies: Anomaly[];
  /** Highest sell tax any provider reported (fraction), or null. */
  sellTax: number | null;
  /** Highest buy tax any provider reported (fraction), or null. */
  buyTax: number | null;
  /** Number of providers that produced a usable result. */
  usableCount: number;
  /** Did at least one LIVE-simulation detector (our sim / honeypot.is) run? */
  hadLiveSim: boolean;
}

export function aggregate(results: ProviderResult[]): Aggregate {
  // Fill per-provider scores in place so the UI can show them.
  for (const r of results) r.score = scoreProvider(r);

  const usable = results.filter((r) => r.ok);
  if (usable.length === 0) {
    return { verdict: 'ERROR', riskScore: 0, anomalies: [], sellTax: null, buyTax: null, usableCount: 0, hadLiveSim: false };
  }

  const hadLiveSim = usable.some((r) => SIM_SOURCES.has(r.source));
  const honeypotVotes = usable.filter((r) => r.isHoneypot === true);
  const simHoneypot = honeypotVotes.some((r) => SIM_SOURCES.has(r.source));

  const scored = usable
    .map((r) => ({ score: r.score ?? 0, weight: r.weight }))
    .filter((x) => x.weight > 0);
  const totalW = scored.reduce((a, b) => a + b.weight, 0) || 1;
  const weightedAvg = scored.reduce((a, b) => a + b.score * b.weight, 0) / totalW;
  const maxScore = usable.reduce((m, r) => Math.max(m, r.score ?? 0), 0);

  // Lean toward caution: blend the consensus average with the worst single
  // finding, then let any credible honeypot vote force the danger zone.
  let risk = Math.round((weightedAvg + maxScore) / 2);
  if (honeypotVotes.length > 0 && (simHoneypot || honeypotVotes.length >= 2)) {
    risk = Math.max(risk, 75);
  }
  risk = Math.max(0, Math.min(100, risk));

  const verdict = risk >= 70 ? 'HONEYPOT' : risk >= 30 ? 'SUSPICIOUS' : 'SAFE';

  // Merge signals across providers, de-duped by code, prefixed with the source.
  const seen = new Set<string>();
  const anomalies: Anomaly[] = [];
  for (const r of usable) {
    for (const sig of r.signals) {
      const key = `${r.source}:${sig.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anomalies.push({ severity: sig.severity, code: sig.code, message: `[${r.label}] ${sig.message}` });
    }
  }

  const sellTax = usable.reduce<number | null>(
    (m, r) => (r.sellTax == null ? m : m == null ? r.sellTax : Math.max(m, r.sellTax)),
    null,
  );
  const buyTax = usable.reduce<number | null>(
    (m, r) => (r.buyTax == null ? m : m == null ? r.buyTax : Math.max(m, r.buyTax)),
    null,
  );

  return { verdict, riskScore: risk, anomalies, sellTax, buyTax, usableCount: usable.length, hadLiveSim };
}

/**
 * Run the EXTERNAL detectors (GoPlus + honeypot.is) for a token on a numeric
 * EVM chain id, in parallel. Each is fault-isolated: a failure/timeout becomes a
 * `ok:false` result, never an exception. The caller adds our own anvil sim
 * result (when the chain is forkable) before aggregating.
 */
export async function runExternalProviders(
  address: string,
  chainId: number,
  now: number,
): Promise<ProviderResult[]> {
  const tasks: Promise<ProviderResult>[] = [goplusCheck(address, chainId, now)];
  if (honeypotisMaybeSupports(chainId)) tasks.push(honeypotisCheck(address, chainId));
  return Promise.all(tasks);
}

/**
 * Shared types for the ensemble detector layer.
 *
 * Bullet Proof no longer relies on a single check. Each "provider" is an
 * independent honeypot / sell-tax detector — our own anvil simulation, plus
 * external APIs (GoPlus, honeypot.is). Every provider returns a normalized
 * {@link ProviderResult}; {@link ./ensemble.js | ensemble} aggregates them into
 * one verdict with a per-source breakdown the UI surfaces.
 *
 * Normalization rules every provider MUST follow:
 *   - `buyTax`/`sellTax` are FRACTIONS in [0,1] (0.1 = 10%), or null if unknown.
 *     (GoPlus reports fractions already; honeypot.is reports percentages and is
 *     divided by 100 at the boundary; our sim already produces fractions.)
 *   - `isHoneypot` is a hard boolean only when the provider is confident; null
 *     means "no opinion" and must not sway the vote.
 *   - `supported=false` means the provider doesn't cover this chain — it's
 *     excluded from the vote, NOT counted as a "safe" signal.
 */

export interface ProviderSignal {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
}

export interface ProviderResult {
  /** Stable id, e.g. 'bulletproof-sim' | 'goplus' | 'honeypot.is'. */
  source: string;
  /** Human label for the UI. */
  label: string;
  /** Did the provider cover this chain? If false it's not counted in the vote. */
  supported: boolean;
  /** Did it run and return usable data? */
  ok: boolean;
  /** Confident honeypot determination, or null for "no opinion". */
  isHoneypot: boolean | null;
  /** Buy tax as a fraction [0,1], or null. */
  buyTax: number | null;
  /** Sell tax as a fraction [0,1], or null. */
  sellTax: number | null;
  /** Per-provider risk contribution 0..100, filled by the ensemble. */
  score: number | null;
  /** Vote weight (real simulations weigh more than static analysis). */
  weight: number;
  /** Flags this provider raised (mintable, pausable, blacklist, …). */
  signals: ProviderSignal[];
  /** Set when the provider errored or timed out. */
  error?: string;
  /** Wall-clock for this provider, ms. */
  durationMs?: number;
}

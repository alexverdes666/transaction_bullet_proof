/**
 * honeypot.is — live simulation provider.
 *
 * Like our own engine, honeypot.is actually SIMULATES a buy and a sell (on its
 * own infrastructure) and reports real buy/sell/transfer taxes plus a honeypot
 * verdict. It's an independent second opinion on the chains it covers (the major
 * EVM chains). Taxes come back as PERCENTAGES and are normalized to fractions
 * here.
 *
 * Docs: https://docs.honeypot.is/
 */
import type { ProviderResult, ProviderSignal } from './types.js';

const BASE = 'https://api.honeypot.is/v2';
const TIMEOUT_MS = 15_000;

/**
 * Chains honeypot.is is known to support. We still ATTEMPT others and only mark
 * unsupported when the response says so — but this avoids a pointless round-trip
 * for chains it definitely doesn't cover.
 */
const KNOWN_SUPPORTED = new Set([1, 56, 8453]);

export function honeypotisMaybeSupports(chainId: number): boolean {
  // Optimistic: try known chains for sure; for others, let the API decide.
  return KNOWN_SUPPORTED.has(chainId) || chainId > 0;
}

async function fetchJson(url: string, ms: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const pctToFraction = (v: unknown): number | null => {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n / 100));
};

interface HpResponse {
  honeypotResult?: { isHoneypot?: boolean };
  simulationResult?: { buyTax?: number; sellTax?: number; transferTax?: number };
  simulationSuccess?: boolean;
  flags?: string[];
  summary?: { risk?: string; riskLevel?: number; flags?: { flag?: string; description?: string }[] };
}

export async function honeypotisCheck(address: string, chainId: number): Promise<ProviderResult> {
  const base: ProviderResult = {
    source: 'honeypot.is',
    label: 'honeypot.is',
    supported: true,
    ok: false,
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    score: null,
    weight: 1.0, // live simulation -> full weight, like our own engine
    signals: [],
  };
  try {
    const json = (await fetchJson(
      `${BASE}/IsHoneypot?address=${address}&chainID=${chainId}`,
      TIMEOUT_MS,
    )) as HpResponse & { error?: string };

    if (json.error) return { ...base, supported: false, error: String(json.error) };

    const hr = json.honeypotResult ?? {};
    const sr = json.simulationResult ?? {};
    const isHoneypot = typeof hr.isHoneypot === 'boolean' ? hr.isHoneypot : null;
    const buyTax = pctToFraction(sr.buyTax);
    const sellTax = pctToFraction(sr.sellTax);

    // Usable if it either returned a honeypot verdict or a successful simulation.
    const ok = isHoneypot !== null || json.simulationSuccess === true;
    if (!ok) return { ...base, error: 'no simulation result (likely unsupported chain or no liquidity)' };

    const signals: ProviderSignal[] = [];
    if (isHoneypot) signals.push({ severity: 'critical', code: 'HP_HONEYPOT', message: 'honeypot.is simulation could not sell the token.' });
    for (const f of json.summary?.flags ?? []) {
      if (f?.description) signals.push({ severity: 'warning', code: f.flag ?? 'HP_FLAG', message: f.description });
    }

    return { ...base, ok: true, isHoneypot, buyTax, sellTax, signals };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : 'honeypot.is error' };
  }
}

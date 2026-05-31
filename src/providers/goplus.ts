/**
 * GoPlus Security — token-security provider.
 *
 * Free, key-less (rate-limited) API that statically + heuristically analyzes a
 * token across ~40 chains and returns a rich flag set (honeypot, taxes, mintable,
 * pausable, blacklist, owner-can-change-balance, hidden owner, …). It's the
 * BREADTH provider: the set of chains it covers is fetched at runtime from
 * `/supported_chains`, so coverage grows without code changes.
 *
 * Docs: https://docs.gopluslabs.io/reference/response-details
 */
import type { ProviderResult, ProviderSignal } from './types.js';

const BASE = 'https://api.gopluslabs.io/api/v1';
const TIMEOUT_MS = 12_000;
const CHAINS_TTL_MS = 60 * 60 * 1000; // refresh supported-chain list hourly

let chainCache: { ids: Set<string>; at: number } | null = null;

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

/** Numeric chain ids GoPlus currently supports (cached). Empty set on failure. */
export async function goplusSupportedChainIds(now: number): Promise<Set<string>> {
  if (chainCache && now - chainCache.at < CHAINS_TTL_MS) return chainCache.ids;
  try {
    const json = (await fetchJson(`${BASE}/supported_chains`, 8_000)) as {
      result?: { id?: string | number }[];
    };
    const ids = new Set((json.result ?? []).map((r) => String(r.id)));
    chainCache = { ids, at: now };
    return ids;
  } catch {
    // Don't cache failures; fall back to "assume supported" so a transient
    // outage of the chain-list endpoint doesn't silently drop the provider.
    return new Set();
  }
}

export async function goplusSupportsChain(chainId: number, now: number): Promise<boolean> {
  const ids = await goplusSupportedChainIds(now);
  return ids.size === 0 ? true : ids.has(String(chainId));
}

const flag = (v: unknown) => v === '1' || v === 1 || v === true;
const numOrNull = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Build the human-readable flag list from a GoPlus token record. */
function buildSignals(t: Record<string, unknown>): ProviderSignal[] {
  const s: ProviderSignal[] = [];
  const crit = (code: string, message: string) => s.push({ severity: 'critical', code, message });
  const warn = (code: string, message: string) => s.push({ severity: 'warning', code, message });
  const info = (code: string, message: string) => s.push({ severity: 'info', code, message });

  if (flag(t.is_honeypot)) crit('GP_HONEYPOT', 'GoPlus flags this as a honeypot (cannot sell).');
  if (flag(t.cannot_sell_all)) crit('GP_CANNOT_SELL_ALL', 'You may not be able to sell your entire balance.');
  if (flag(t.cannot_buy)) crit('GP_CANNOT_BUY', 'Buying appears to be blocked.');
  if (flag(t.owner_change_balance)) crit('GP_OWNER_BALANCE', 'The owner can arbitrarily change balances.');
  if (flag(t.selfdestruct)) crit('GP_SELFDESTRUCT', 'The contract can self-destruct.');

  if (flag(t.transfer_pausable)) warn('GP_PAUSABLE', 'Transfers can be paused by the owner.');
  if (flag(t.trading_cooldown)) warn('GP_COOLDOWN', 'Trading has a cooldown between transactions.');
  if (flag(t.is_blacklisted)) warn('GP_BLACKLIST', 'The contract has a blacklist that can block addresses.');
  if (flag(t.is_mintable)) warn('GP_MINTABLE', 'The owner can mint new tokens (supply inflation).');
  if (flag(t.slippage_modifiable)) warn('GP_TAX_MODIFIABLE', 'The owner can change the trading tax.');
  if (flag(t.personal_slippage_modifiable)) warn('GP_PERSONAL_TAX', 'The owner can set a custom tax per address.');
  if (flag(t.hidden_owner)) warn('GP_HIDDEN_OWNER', 'The contract has a hidden owner.');
  if (flag(t.can_take_back_ownership)) warn('GP_RECLAIM_OWNERSHIP', 'Ownership can be reclaimed after being renounced.');
  if (flag(t.honeypot_with_same_creator)) warn('GP_CREATOR_HISTORY', 'The creator has deployed honeypots before.');
  if (t.is_open_source === '0') warn('GP_CLOSED_SOURCE', 'The contract source code is not verified.');

  if (flag(t.is_proxy)) info('GP_PROXY', 'Upgradeable proxy contract (logic can change).');
  if (flag(t.is_whitelisted)) info('GP_WHITELIST', 'The contract has a whitelist.');
  if (flag(t.is_anti_whale)) info('GP_ANTIWHALE', 'Anti-whale max transaction/holding limit.');
  if (flag(t.external_call)) info('GP_EXTERNAL_CALL', 'The contract makes external calls during transfers.');
  return s;
}

/**
 * Query GoPlus for a token on a chain. Never throws — returns a ProviderResult
 * with `ok:false` on error so the ensemble can proceed on the other providers.
 */
export async function goplusCheck(
  address: string,
  chainId: number,
  now: number,
): Promise<ProviderResult> {
  const base: ProviderResult = {
    source: 'goplus',
    label: 'GoPlus Security',
    supported: true,
    ok: false,
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    score: null,
    weight: 0.8, // mostly static analysis -> a bit below the live simulations
    signals: [],
  };
  const start = now;
  try {
    if (!(await goplusSupportsChain(chainId, now))) {
      return { ...base, supported: false, error: 'chain not supported by GoPlus' };
    }
    const json = (await fetchJson(
      `${BASE}/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
      TIMEOUT_MS,
    )) as { result?: Record<string, Record<string, unknown>> };
    const rec = json.result?.[address.toLowerCase()];
    if (!rec || Object.keys(rec).length === 0) {
      return { ...base, error: 'token not indexed by GoPlus' };
    }
    const buyTax = numOrNull(rec.buy_tax);
    const sellTax = numOrNull(rec.sell_tax);
    return {
      ...base,
      ok: true,
      // GoPlus only sets is_honeypot when confident; treat absent as "no opinion".
      isHoneypot: rec.is_honeypot === undefined ? null : flag(rec.is_honeypot),
      buyTax, // already a fraction
      sellTax,
      signals: buildSignals(rec),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : 'goplus error' };
  } finally {
    // best-effort timing (now passed in; refine in caller if needed)
    void start;
  }
}

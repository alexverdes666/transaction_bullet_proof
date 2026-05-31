/**
 * Token discovery + enrichment.
 *
 * Two jobs, both BEFORE any fork is spun up (plain HTTP/RPC, cheap):
 *
 *  1. Auto-detect which chain a pasted address lives on, so the user never picks
 *     a network manually. We try DexScreener first (it also tells us the most
 *     liquid chain + rich metadata); if the token has no DexScreener pairs — many
 *     fresh/low-liquidity tokens don't — we fall back to probing each supported
 *     chain's RPC for contract bytecode.
 *
 *  2. Gather everything we can about the token for a rich result card: image,
 *     name/symbol, price, liquidity, FDV/market-cap, "trading since" (pair
 *     creation), links, and on-chain total supply.
 *
 * The honeypot SIMULATION still only runs on chains in CHAINS (those with a
 * curated V2 router). When a token is detected on a chain we can't simulate, we
 * return its info with `chainKey: undefined` so the caller can show "detected on
 * X, simulation unavailable" rather than a bare error.
 */
import { createPublicClient, http, getAddress, type Address } from 'viem';
import { erc20Abi } from './abi.js';
import {
  CHAINS,
  chainKeyFromDexscreener,
  chainIdFromDexscreener,
  displayChainName,
  type ChainConfig,
} from './chains.js';

export interface TokenInfo {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  imageUrl?: string;
  priceUsd?: string;
  liquidityUsd?: number;
  fdv?: number;
  marketCap?: number;
  /** Pair creation time (ms epoch) — "trading since", a free proxy for age. */
  pairCreatedAt?: number;
  dexId?: string;
  pairUrl?: string;
  websites?: string[];
  socials?: { type: string; url: string }[];
  /** Friendly name of the chain we detected (may be a chain we can't simulate). */
  detectedChainName?: string;
  /** Raw DexScreener chain id, when detection came from there. */
  detectedChainId?: string;
  /** How we found the chain. */
  detectedVia: 'dexscreener' | 'rpc-probe' | 'none';
  /** Block explorer link to the token, when known. */
  explorerUrl?: string;
  /** Every chain the token trades on (DexScreener), highest-liquidity first. */
  tradesOn?: { chain: string; chainName: string; liquidityUsd: number }[];
}

export interface Discovery {
  /** Our registry key for the chain to simulate on, or undefined if we can't. */
  chainKey?: string;
  /**
   * Numeric EVM chain id of where the token was detected (even on chains we don't
   * fork), so the external detectors (GoPlus / honeypot.is) can still run.
   * Undefined for non-EVM chains or when detection failed.
   */
  chainId?: number;
  info: TokenInfo;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  baseToken?: { address?: string; name?: string; symbol?: string };
  info?: {
    imageUrl?: string;
    websites?: { url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
}

const DEXSCREENER_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 6_000;

/** Query DexScreener for all pairs of a token across all chains. */
async function fetchDexScreener(address: string): Promise<DexPair[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEXSCREENER_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { pairs?: DexPair[] | null };
    // Only pairs where THIS address is the base token (not the quote token).
    const addr = address.toLowerCase();
    return (json.pairs ?? []).filter(
      (p) => (p.baseToken?.address ?? '').toLowerCase() === addr,
    );
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** Read on-chain ERC-20 metadata (name/symbol/decimals/totalSupply) for a token. */
async function readOnchainMeta(
  chain: ChainConfig,
  token: Address,
): Promise<Partial<TokenInfo>> {
  const rpc = chain.rpcUrl.split(',')[0]!.trim();
  const client = createPublicClient({ transport: http(rpc) });
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

/** Probe a single chain: does the address have contract bytecode there? */
async function hasBytecode(chain: ChainConfig, token: Address): Promise<boolean> {
  const rpc = chain.rpcUrl.split(',')[0]!.trim();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [token, 'latest'],
      }),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as { result?: string };
    return typeof json.result === 'string' && json.result !== '0x' && json.result.length > 2;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Detect the chain for an address and gather rich info. Never throws — on total
 * failure returns `{ chainKey: undefined, info: { detectedVia: 'none' } }`.
 */
export async function discoverToken(address: string): Promise<Discovery> {
  const token = getAddress(address);

  // --- 1. DexScreener: best signal (liquidity-ranked chain + rich metadata) ---
  const pairs = await fetchDexScreener(token);
  if (pairs.length > 0) {
    // Aggregate liquidity per chain.
    const byChain = new Map<string, number>();
    for (const p of pairs) {
      const c = p.chainId ?? '';
      byChain.set(c, (byChain.get(c) ?? 0) + (p.liquidity?.usd ?? 0));
    }
    const tradesOn = [...byChain.entries()]
      .map(([chain, liquidityUsd]) => ({
        chain,
        chainName: displayChainName(chain),
        liquidityUsd,
      }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    // Best pair overall (most liquid), for price/image/links/age.
    const best = pairs.reduce((a, b) =>
      (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
    );
    const bestDexChain = best.chainId ?? '';
    // Prefer a SIMULATABLE chain: the most-liquid chain we actually support. If
    // the top chain isn't supported, fall back to the highest-liquidity one that is.
    const supportedRanked = tradesOn.find((x) => chainKeyFromDexscreener(x.chain));
    const chainKey = supportedRanked ? chainKeyFromDexscreener(supportedRanked.chain) : undefined;
    const detectedDexChain = chainKey
      ? CHAINS[chainKey]!.dexscreenerId
      : bestDexChain;

    const info: TokenInfo = {
      detectedVia: 'dexscreener',
      detectedChainId: detectedDexChain,
      detectedChainName: displayChainName(detectedDexChain),
      name: best.baseToken?.name,
      symbol: best.baseToken?.symbol,
      priceUsd: best.priceUsd,
      liquidityUsd: best.liquidity?.usd,
      fdv: best.fdv,
      marketCap: best.marketCap,
      pairCreatedAt: best.pairCreatedAt,
      dexId: best.dexId,
      pairUrl: best.url,
      imageUrl: best.info?.imageUrl,
      websites: (best.info?.websites ?? []).map((w) => w.url).filter((u): u is string => !!u),
      socials: (best.info?.socials ?? [])
        .filter((s) => s.type && s.url)
        .map((s) => ({ type: s.type as string, url: s.url as string })),
      tradesOn,
    };
    if (chainKey) {
      info.explorerUrl = `${CHAINS[chainKey]!.explorer}/token/${token}`;
      // Enrich with on-chain totals/decimals (DexScreener omits these).
      try {
        Object.assign(info, await readOnchainMeta(CHAINS[chainKey]!, token), {
          // keep DexScreener name/symbol if present (nicer casing), else on-chain
          name: info.name ?? (await readOnchainMeta(CHAINS[chainKey]!, token)).name,
        });
      } catch {
        /* enrichment is best-effort */
      }
    }
    return { chainKey, chainId: chainIdFromDexscreener(detectedDexChain), info };
  }

  // --- 2. RPC probe fallback: which supported chain has bytecode? -------------
  const ordered = Object.values(CHAINS); // registry order = our preference
  const results = await Promise.all(
    ordered.map(async (c) => ({ c, has: await hasBytecode(c, token) })),
  );
  const hit = results.find((r) => r.has);
  if (hit) {
    const meta = await readOnchainMeta(hit.c, token).catch(() => ({}));
    return {
      chainKey: hit.c.key,
      chainId: hit.c.chainId,
      info: {
        detectedVia: 'rpc-probe',
        detectedChainId: hit.c.dexscreenerId,
        detectedChainName: hit.c.name,
        explorerUrl: `${hit.c.explorer}/token/${token}`,
        ...meta,
      },
    };
  }

  // --- 3. Nothing found ------------------------------------------------------
  return { chainKey: undefined, info: { detectedVia: 'none' } };
}

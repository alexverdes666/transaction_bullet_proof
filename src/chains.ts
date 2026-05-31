/**
 * Supported-chain registry.
 *
 * The honeypot simulation forks a chain and drives a buy→sell round-trip through
 * a Uniswap-V2-style router. That needs three things per chain that no library
 * bundles together: a working RPC, the V2 router address, and the wrapped-native
 * token. viem/chains carries chain metadata (id, native coin, explorer) but NOT
 * the DEX router — so this table is curated. Only chains with a well-known
 * V2-compatible router are listed; a wrong router would make every token look
 * "not buyable", so we keep this conservative and explicit.
 *
 * Each scan resolves its own ChainConfig and threads it through (fork RPC,
 * router, wrapped-native), so the worker can run concurrent scans on DIFFERENT
 * chains without any shared global state.
 */
import { type Address, getAddress } from 'viem';

export interface ChainConfig {
  /** Stable lowercase key used in the API / UI (e.g. "bsc"). */
  key: string;
  /** Human-readable name. */
  name: string;
  /** EVM chain id. */
  chainId: number;
  /** Comma-separated RPC URLs; the fork uses the first, the rest are failover. */
  rpcUrl: string;
  /** Uniswap-V2-style router (getAmountsOut + swap*SupportingFeeOnTransfer). */
  router: Address;
  /** Wrapped native token (WETH/WBNB/WMATIC/WAVAX). */
  weth: Address;
  /** Native gas-token symbol. */
  nativeSymbol: string;
  /** Block explorer base URL (for the UI). */
  explorer: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    key: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    rpcUrl:
      'https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com,https://rpc.ankr.com/eth',
    router: getAddress('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'), // Uniswap V2
    weth: getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    nativeSymbol: 'ETH',
    explorer: 'https://etherscan.io',
  },
  bsc: {
    key: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    rpcUrl:
      'https://bsc-rpc.publicnode.com,https://binance.llamarpc.com,https://bsc-dataseed.bnbchain.org',
    router: getAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E'), // PancakeSwap V2
    weth: getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'), // WBNB
    nativeSymbol: 'BNB',
    explorer: 'https://bscscan.com',
  },
  polygon: {
    key: 'polygon',
    name: 'Polygon',
    chainId: 137,
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com,https://polygon.llamarpc.com',
    router: getAddress('0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'), // QuickSwap V2
    weth: getAddress('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'), // WMATIC/WPOL
    nativeSymbol: 'POL',
    explorer: 'https://polygonscan.com',
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://base-rpc.publicnode.com,https://base.llamarpc.com',
    router: getAddress('0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'), // Uniswap V2 (Base)
    weth: getAddress('0x4200000000000000000000000000000000000006'),
    nativeSymbol: 'ETH',
    explorer: 'https://basescan.org',
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arbitrum-one-rpc.publicnode.com,https://arbitrum.llamarpc.com',
    router: getAddress('0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'), // Uniswap V2 (Arbitrum)
    weth: getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'),
    nativeSymbol: 'ETH',
    explorer: 'https://arbiscan.io',
  },
  avalanche: {
    key: 'avalanche',
    name: 'Avalanche C-Chain',
    chainId: 43114,
    rpcUrl: 'https://avalanche-c-chain-rpc.publicnode.com,https://avax.meowrpc.com',
    router: getAddress('0x60aE616a2155Ee3d9A68541Ba4544862310933d4'), // Trader Joe V1 (V2-style)
    weth: getAddress('0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'), // WAVAX
    nativeSymbol: 'AVAX',
    explorer: 'https://snowtrace.io',
  },
};

export const DEFAULT_CHAIN = 'ethereum';

/** Resolve a chain key to its config, defaulting to Ethereum; throws if unknown. */
export function resolveChain(key?: string): ChainConfig {
  const k = (key ?? DEFAULT_CHAIN).toLowerCase();
  const c = CHAINS[k];
  if (!c) {
    throw new Error(
      `Unsupported chain "${key}". Supported chains: ${Object.keys(CHAINS).join(', ')}.`,
    );
  }
  return c;
}

export function isSupportedChain(key: string): boolean {
  return key.toLowerCase() in CHAINS;
}

/** Public list (key + display name + native symbol) for the UI selector. */
export function chainList(): { key: string; name: string; nativeSymbol: string }[] {
  return Object.values(CHAINS).map((c) => ({
    key: c.key,
    name: c.name,
    nativeSymbol: c.nativeSymbol,
  }));
}

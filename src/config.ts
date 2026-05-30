/**
 * Centralised, type-safe configuration loaded from environment variables.
 *
 * Everything that varies between chains / environments lives here so the rest
 * of the codebase never reads `process.env` directly.
 */
import 'dotenv/config';
import { type Address, getAddress } from 'viem';

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function num(name: string, fallback?: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} is not a number: ${v}`);
  return n;
}

function addr(name: string, fallback?: string): Address {
  return getAddress(str(name, fallback));
}

function optionalBigint(name: string): bigint | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return BigInt(v);
}

export const config = {
  fork: {
    rpcUrl: str('FORK_RPC_URL', 'https://eth.llamarpc.com'),
    blockNumber: optionalBigint('FORK_BLOCK_NUMBER'),
    anvilPort: num('ANVIL_PORT', 8545),
    anvilBin: str('ANVIL_BIN', 'anvil'),
    chainId: num('CHAIN_ID', 1),
  },
  dex: {
    router: addr('ROUTER_ADDRESS', '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'),
    weth: addr('WETH_ADDRESS', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  },
  wallet: {
    // Anvil deterministic account #0. Safe to commit — it is a public dev key.
    privateKey: str(
      'TEST_PRIVATE_KEY',
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    ) as `0x${string}`,
    fundEth: num('FUND_ETH', 100),
    buyEth: num('BUY_ETH', 1),
  },
  control: {
    port: num('CONTROL_PORT', 8645),
    mockDappPort: num('MOCK_DAPP_PORT', 8700),
  },
  python: {
    bin: str('PYTHON_BIN', 'python'),
    headless: str('HEADLESS', 'true') !== 'false',
  },
} as const;

export function rpcUrl(): string {
  return `http://127.0.0.1:${config.fork.anvilPort}`;
}

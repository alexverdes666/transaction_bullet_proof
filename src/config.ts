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

/**
 * CFG-3: are we running in a deployed (production) environment?
 *
 * Render and most container/PaaS hosts inject `PORT`; we also honour the
 * conventional `NODE_ENV=production`. Local CLI/dev runs have neither.
 */
export function isProductionEnv(): boolean {
  return Boolean(process.env.PORT) || process.env.NODE_ENV === 'production';
}

/**
 * CFG-3: fail CLOSED in production. The shared secret is the ONLY thing that
 * keeps the /scan worker behind the SaaS paywall — if it is missing/empty in a
 * deployment the worker would run OPEN and let anyone obtain free scans. Refuse
 * to boot in that case. Local dev (no PORT, no NODE_ENV=production) is allowed to
 * run open, with the existing warning emitted by src/server.ts.
 */
function assertWorkerSecretInProd(): void {
  if (isProductionEnv() && !(process.env.WORKER_SHARED_SECRET ?? '').trim()) {
    throw new Error(
      'WORKER_SHARED_SECRET is required in production (PORT is set or ' +
        'NODE_ENV=production) but is missing/empty. Refusing to start the scan ' +
        'worker OPEN — that would bypass the SaaS paywall. Set ' +
        'WORKER_SHARED_SECRET (it must match the web app).',
    );
  }
}

assertWorkerSecretInProd();

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
    // In a container (Render) PORT is injected; locally fall back to CONTROL_PORT.
    port: num('PORT', num('CONTROL_PORT', 8645)),
    // Bind public when containerised, loopback-only for local dev.
    host: process.env.PORT ? '0.0.0.0' : '127.0.0.1',
    // Shared secret gating POST /scan. Empty = dev mode (open) — only permitted
    // outside production; production is enforced by assertWorkerSecretInProd()
    // above (CFG-3). See src/server.ts.
    workerSecret: str('WORKER_SHARED_SECRET', ''),
  },
} as const;

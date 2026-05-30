/**
 * Server-only environment configuration. Importing this from client code will
 * throw (the values are secrets). Every consumer reads from here, never from
 * `process.env` directly.
 */
import 'server-only';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} not a number`);
  return n;
}

export const env = {
  mongoUri: req('MONGODB_URI'),

  // 32+ byte random secret used to sign session cookies (HMAC).
  sessionSecret: req('SESSION_SECRET'),
  sessionTtlDays: int('SESSION_TTL_DAYS', 7),

  // Scan worker (Render). The shared secret gates every call; users never see it.
  workerUrl: req('WORKER_URL'),
  workerSecret: req('WORKER_SHARED_SECRET'),

  // Admin panel: obfuscated path + hard access controls.
  adminPath: opt('ADMIN_PATH', 'ctrl-9f3a7c21'), // non-obvious default; override in prod
  adminAccessKey: opt('ADMIN_ACCESS_KEY'), // second factor beyond the admin role
  adminIpAllowlist: opt('ADMIN_IP_ALLOWLIST') // comma-separated; empty = allow any
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Crypto payments: on-chain verification config.
  pay: {
    rpcUrl: opt('PAY_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
    chainId: int('PAY_CHAIN_ID', 1),
    tokenAddress: opt('PAY_TOKEN_ADDRESS', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), // USDC
    tokenDecimals: int('PAY_TOKEN_DECIMALS', 6),
    tokenSymbol: opt('PAY_TOKEN_SYMBOL', 'USDC'),
    treasury: opt('PAY_TREASURY_ADDRESS', ''), // where users send funds
    minConfirmations: int('PAY_MIN_CONFIRMATIONS', 6),
    orderTtlMinutes: int('PAY_ORDER_TTL_MINUTES', 60),
  },

  isProd: process.env.NODE_ENV === 'production',
} as const;

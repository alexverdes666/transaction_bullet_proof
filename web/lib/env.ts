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
interface IntOpts {
  min?: number;
}

function int(name: string, fallback: number, opts: IntOpts = {}): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  // Require a clean integer string: reject fractional/garbage input.
  if (!/^-?\d+$/.test(v.trim())) throw new Error(`Env ${name} must be an integer`);
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Env ${name} must be an integer`);
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`Env ${name} must be >= ${opts.min}`);
  }
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

const PAY_RPC_DEFAULT = 'https://ethereum-rpc.publicnode.com';

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
    rpcUrl: opt('PAY_RPC_URL', PAY_RPC_DEFAULT),
    chainId: int('PAY_CHAIN_ID', 1, { min: 1 }),
    tokenAddress: opt('PAY_TOKEN_ADDRESS', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), // USDC
    tokenDecimals: int('PAY_TOKEN_DECIMALS', 6, { min: 0 }),
    tokenSymbol: opt('PAY_TOKEN_SYMBOL', 'USDC'),
    treasury: opt('PAY_TREASURY_ADDRESS', ''), // where users send funds
    minConfirmations: int('PAY_MIN_CONFIRMATIONS', 6, { min: 1 }),
    orderTtlMinutes: int('PAY_ORDER_TTL_MINUTES', 60, { min: 1 }),
  },

  isProd,
} as const;

// --- Production fail-closed checks ------------------------------------------
// In prod, certain security-critical settings must not silently fall back to a
// weak/shared default — fail closed at runtime rather than running insecurely.
//
// IMPORTANT: `next build` always runs with NODE_ENV=production and evaluates
// route modules (page-data collection), but the build host has no secrets. So
// skip these checks during the build PHASE (NEXT_PHASE=phase-production-build);
// they still fire when the real server boots (phase-production-server/undefined)
// and on the worker process. This preserves fail-closed behavior in production
// without breaking the build.
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
if (env.isProd && !isBuildPhase) {
  // SEC-7: payment verification must use a dedicated RPC, not the shared public
  // default (rate-limited / untrusted → unreliable settlement).
  if (!process.env.PAY_RPC_URL || env.pay.rpcUrl === PAY_RPC_DEFAULT) {
    throw new Error('PAY_RPC_URL must be set to a dedicated RPC endpoint in production');
  }
  // CFG-6: the admin second factor (access key) must not be disabled in prod.
  if (!env.adminAccessKey) {
    throw new Error('ADMIN_ACCESS_KEY must be set in production');
  }
}

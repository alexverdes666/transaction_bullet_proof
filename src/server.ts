/**
 * HTTP control / IPC layer.
 *
 * A tiny zero-dependency JSON API so other processes (CI or a dashboard) can
 * request scans without re-implementing the pipeline.
 *
 *   GET  /health              -> { ok: true }
 *   POST /scan { token, buyEth?, mode? }  -> HoneypotReport (JSON)
 *
 * Each scan spins up and tears down its own isolated fork, so concurrent
 * requests never share state. Run:  npm run server
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAddress } from 'viem';
import { config } from './config.js';
import { runScan } from './scan.js';
import { stopAllForks } from './anvil.js';
import { isSupportedChain, resolveChain, CHAINS } from './chains.js';
import { jsonSafe } from './util.js';

// Shared secret gating /scan. Set in production (Render); when present it is
// REQUIRED on every scan request so end users can never call the worker
// directly to obtain free scans. Unset only for local CLI/dev convenience.
const WORKER_SECRET = config.control.workerSecret;

/** Reject request bodies larger than this — a /scan payload is tiny. */
const MAX_BODY_BYTES = 16 * 1024;
/** Max scans running at once. Each spawns its own anvil fork (heavy); cap to
 *  protect the box from OOM / port exhaustion under a request burst. */
const MAX_CONCURRENT_SCANS = 3;
/**
 * REL-1: hard ceiling for the ENTIRE scan, fork.start() INCLUDED. Previously the
 * 90s timer started only after the fork was up, so total worker time was
 * spawn + 90s + teardown and could blow past the client/platform 120s budget.
 * We now race start()+runScan() against this single deadline so the whole request
 * is bounded well under 120s.
 */
const SCAN_TIMEOUT_MS = 75_000;
/** SEC-9: clamp the optional per-request buy size. The SaaS never sends buyEth,
 *  but the worker must be defensive: an unbounded value could try to fund/spend
 *  an absurd amount on the fork. Accept only a finite number in (0, MAX_BUY_ETH]. */
const MAX_BUY_ETH = 100;

/** Thrown by readJson when a body exceeds MAX_BODY_BYTES. */
class PayloadTooLargeError extends Error {}
/** Thrown by readJson when the body is not valid JSON. */
class BadJsonError extends Error {}

// In-process semaphore: a simple counter is enough since Node is single-threaded
// for our purposes (the await points are the only interleaving). No deps.
let activeScans = 0;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(jsonSafe(body));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** Constant-time check of the worker secret header. */
function authorized(req: IncomingMessage): boolean {
  if (!WORKER_SECRET) return true; // dev mode (no secret configured)
  const provided = (req.headers['x-worker-secret'] as string | undefined) ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(WORKER_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new PayloadTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new BadJsonError('request body is not valid JSON');
  }
}

/**
 * Run a scan but never let the WHOLE operation exceed SCAN_TIMEOUT_MS — the
 * deadline now covers fork.start() too (REL-1), not just runScan(). We own the
 * fork via an explicit AnvilFork so that, on timeout, we can still tear it down
 * (otherwise a stuck scan/spawn would orphan an anvil process). The fork is
 * stopped on every exit path, including the timeout branch where start() may not
 * even have completed (stop() is a safe no-op on a fork that never started).
 */
async function runScanWithTimeout(
  token: string,
  buyEth: number | undefined,
  chain: string | undefined,
) {
  const { AnvilFork } = await import('./anvil.js');
  // Resolve the chain (defaults to Ethereum); its RPC + chainId drive the fork.
  const resolved = resolveChain(chain);
  const fork = new AnvilFork();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`scan timed out after ${SCAN_TIMEOUT_MS}ms`)),
      SCAN_TIMEOUT_MS,
    );
  });

  // start() + runScan() as one awaitable so the single deadline bounds the lot.
  const work = (async () => {
    await fork.start({ quiet: true, forkUrl: resolved.rpcUrl, chainId: resolved.chainId });
    return runScan({
      token,
      fork,
      ...(chain !== undefined ? { chain } : {}),
      ...(buyEth !== undefined ? { buyEth } : {}),
    });
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // We own the fork, so we always stop it — including on the timeout path,
    // where start()/runScan never reach their own teardown. If start() is still
    // in flight when we time out, let it settle first so stop() can reap a child
    // that finished spawning after the deadline (avoid a leaked anvil process).
    await work.catch(() => {});
    await fork.stop();
  }
}

/**
 * REL-2: readiness check. Unlike the cheap /health liveness stub, this verifies
 * the worker can actually perform a scan: (a) the anvil binary resolves, and
 * (b) at least one configured upstream RPC answers `eth_blockNumber`. The result
 * is cached briefly so a load balancer polling /ready can't hammer the RPCs.
 */
const READY_CACHE_MS = 30_000;
const READY_PROBE_TIMEOUT_MS = 5_000;
let readyCache: { at: number; result: { ready: boolean; anvil: boolean; rpc: boolean } } | null =
  null;

/** True if ANVIL_BIN resolves to an existing file, or is a bare command name
 *  (resolved from PATH at spawn time — we can't cheaply stat that, so accept). */
function anvilBinResolves(): boolean {
  const bin = config.fork.anvilBin;
  // A path-like value (contains a separator) must exist on disk; a bare name
  // like "anvil" is resolved via PATH by spawn, so we optimistically accept it.
  if (/[\\/]/.test(bin)) return existsSync(bin);
  return true;
}

/** Probe configured upstream RPCs; true once one answers eth_blockNumber. */
async function anyRpcHealthy(): Promise<boolean> {
  const candidates = config.fork.rpcUrl
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), READY_PROBE_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const json = (await res.json()) as { result?: string };
      if (res.ok && typeof json.result === 'string') return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

async function checkReadiness(): Promise<{ ready: boolean; anvil: boolean; rpc: boolean }> {
  const now = Date.now();
  if (readyCache && now - readyCache.at < READY_CACHE_MS) return readyCache.result;
  const anvil = anvilBinResolves();
  const rpc = await anyRpcHealthy();
  const result = { ready: anvil && rpc, anvil, rpc };
  readyCache = { at: now, result };
  return result;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      return send(res, 200, { ok: true, service: 'honeypot-sandbox' });
    }

    if (req.method === 'GET' && req.url?.startsWith('/ready')) {
      const r = await checkReadiness();
      return send(res, r.ready ? 200 : 503, {
        ready: r.ready,
        checks: { anvilBin: r.anvil, upstreamRpc: r.rpc },
      });
    }

    if (req.method === 'POST' && req.url?.startsWith('/scan')) {
      if (!authorized(req)) {
        return send(res, 401, { error: 'unauthorized' });
      }

      // Concurrency cap: reject (don't queue) when at capacity so callers can
      // back off rather than the box thrashing under a fork-per-request burst.
      if (activeScans >= MAX_CONCURRENT_SCANS) {
        res.setHeader('Retry-After', '5');
        return send(res, 503, { error: 'server busy, retry shortly' });
      }

      const body = await readJson(req);
      const token = String(body['token'] ?? '');
      if (!isAddress(token)) {
        return send(res, 400, { error: 'invalid or missing "token" address' });
      }
      // Validate the optional chain against the supported registry; default = ethereum.
      let chain: string | undefined;
      if (body['chain'] !== undefined && body['chain'] !== '') {
        chain = String(body['chain']).toLowerCase();
        if (!isSupportedChain(chain)) {
          return send(res, 400, {
            error: `unsupported "chain". Supported: ${Object.keys(CHAINS).join(', ')}`,
          });
        }
      }
      // SEC-9: validate/clamp buyEth to a sane positive range; 400 otherwise.
      let buyEth: number | undefined;
      if (body['buyEth'] !== undefined) {
        buyEth = Number(body['buyEth']);
        if (!Number.isFinite(buyEth) || buyEth <= 0 || buyEth > MAX_BUY_ETH) {
          return send(res, 400, { error: `"buyEth" must be a number in (0, ${MAX_BUY_ETH}]` });
        }
      }

      console.log(`[server] scan request: ${token} on ${chain ?? 'ethereum'}`);
      activeScans++;
      try {
        const report = await runScanWithTimeout(token, buyEth, chain);
        return send(res, 200, report);
      } finally {
        activeScans--;
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    // Map known request-shape errors to 4xx; everything else is a generic 500.
    if (e instanceof PayloadTooLargeError) {
      return send(res, 413, { error: 'request body too large' });
    }
    if (e instanceof BadJsonError) {
      return send(res, 400, { error: 'invalid JSON body' });
    }
    // Never leak internal error text (it can carry RPC URLs / keys / stack
    // details) to the client; log the full error server-side instead.
    console.error('[server] request failed:', e);
    send(res, 500, { error: 'internal error' });
  }
});

// In a container (Render sets PORT) bind 0.0.0.0; locally stay on loopback.
const PORT = config.control.port;
const HOST = config.control.host;

server.listen(PORT, HOST, () => {
  console.log(`[server] honeypot control API listening on http://${HOST}:${PORT}`);
  console.log(`[server]   GET  /health`);
  console.log(`[server]   POST /scan  { "token": "0x..." }  (requires X-Worker-Secret in prod)`);
  if (!WORKER_SECRET) console.warn('[server] WARNING: WORKER_SHARED_SECRET not set — /scan is OPEN (dev only).');
});

// Graceful shutdown: on a Render redeploy (SIGTERM) or Ctrl-C (SIGINT), stop
// accepting connections and tear down every live anvil fork so no child process
// is orphaned (which would otherwise squat on a port for the next deploy).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — shutting down gracefully…`);
  server.close(() => console.log('[server] HTTP server closed'));

  // REL-4: drain in-flight scans before tearing down forks, so a redeploy
  // (SIGTERM) doesn't kill an anvil mid-transaction and produce a bogus verdict.
  // Bounded grace: if a scan is genuinely stuck we still proceed (and its own
  // SCAN_TIMEOUT_MS would have bounded it anyway).
  const DRAIN_GRACE_MS = 10_000;
  const DRAIN_POLL_MS = 200;
  const drainDeadline = Date.now() + DRAIN_GRACE_MS;
  if (activeScans > 0) {
    console.log(`[server] waiting for ${activeScans} in-flight scan(s) to finish…`);
    while (activeScans > 0 && Date.now() < drainDeadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    if (activeScans > 0) {
      console.warn(`[server] drain grace elapsed; ${activeScans} scan(s) still running — proceeding`);
    } else {
      console.log('[server] all in-flight scans drained');
    }
  }

  try {
    await stopAllForks();
  } catch (e) {
    console.error('[server] error stopping forks during shutdown:', e);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

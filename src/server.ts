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
import { isAddress } from 'viem';
import { config } from './config.js';
import { runScan } from './scan.js';
import { stopAllForks } from './anvil.js';
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
/** Hard ceiling per scan; on timeout we still tear the fork down (see below). */
const SCAN_TIMEOUT_MS = 90_000;
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
 * Run a scan but never let it exceed SCAN_TIMEOUT_MS. We own the fork via an
 * explicit AnvilFork so that, on timeout, we can still tear it down (otherwise a
 * stuck scan would orphan an anvil process). The losing branch of the race is
 * cleaned up regardless of which side wins.
 */
async function runScanWithTimeout(token: string, buyEth: number | undefined) {
  const { AnvilFork } = await import('./anvil.js');
  const fork = new AnvilFork();
  await fork.start({ quiet: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`scan timed out after ${SCAN_TIMEOUT_MS}ms`)),
      SCAN_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([
      runScan({ token, fork, ...(buyEth !== undefined ? { buyEth } : {}) }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // We started the fork, so we always stop it — including on the timeout path,
    // where runScan never reaches its own teardown.
    await fork.stop();
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      return send(res, 200, { ok: true, service: 'honeypot-sandbox' });
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
      // SEC-9: validate/clamp buyEth to a sane positive range; 400 otherwise.
      let buyEth: number | undefined;
      if (body['buyEth'] !== undefined) {
        buyEth = Number(body['buyEth']);
        if (!Number.isFinite(buyEth) || buyEth <= 0 || buyEth > MAX_BUY_ETH) {
          return send(res, 400, { error: `"buyEth" must be a number in (0, ${MAX_BUY_ETH}]` });
        }
      }

      console.log(`[server] scan request: ${token}`);
      activeScans++;
      try {
        const report = await runScanWithTimeout(token, buyEth);
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
  try {
    await stopAllForks();
  } catch (e) {
    console.error('[server] error stopping forks during shutdown:', e);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

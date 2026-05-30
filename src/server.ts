/**
 * HTTP control / IPC layer.
 *
 * A tiny zero-dependency JSON API so other processes (CI, a dashboard, or the
 * Python layer) can request scans without re-implementing the pipeline.
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
import { jsonSafe } from './util.js';

// Shared secret gating /scan. Set in production (Render); when present it is
// REQUIRED on every scan request so end users can never call the worker
// directly to obtain free scans. Unset only for local CLI/dev convenience.
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET ?? '';

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
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw) as Record<string, unknown>;
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
      const body = await readJson(req);
      const token = String(body['token'] ?? '');
      if (!isAddress(token)) {
        return send(res, 400, { error: 'invalid or missing "token" address' });
      }
      const mode = body['mode'] === 'external' ? 'external' : 'simulate';
      const buyEth = body['buyEth'] !== undefined ? Number(body['buyEth']) : undefined;

      console.log(`[server] scan request: ${token} (mode=${mode})`);
      // Note: 'external' mode over HTTP has no browser callback wired in; it
      // would simply diff a no-op interaction. The orchestrator is the entry
      // point for the full browser-driven flow.
      const report = await runScan({ token, mode: 'simulate', ...(buyEth !== undefined ? { buyEth } : {}) });
      return send(res, 200, report);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
});

// In a container (Render sets PORT) bind 0.0.0.0; locally stay on loopback.
const PORT = process.env.PORT ? Number(process.env.PORT) : config.control.port;
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`[server] honeypot control API listening on http://${HOST}:${PORT}`);
  console.log(`[server]   GET  /health`);
  console.log(`[server]   POST /scan  { "token": "0x..." }  (requires X-Worker-Secret in prod)`);
  if (!WORKER_SECRET) console.warn('[server] WARNING: WORKER_SHARED_SECRET not set — /scan is OPEN (dev only).');
});

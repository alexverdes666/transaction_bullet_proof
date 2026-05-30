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
import { isAddress } from 'viem';
import { config } from './config.js';
import { runScan } from './scan.js';
import { jsonSafe } from './util.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(jsonSafe(body));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
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

server.listen(config.control.port, '127.0.0.1', () => {
  console.log(`[server] honeypot control API listening on http://127.0.0.1:${config.control.port}`);
  console.log(`[server]   GET  /health`);
  console.log(`[server]   POST /scan  { "token": "0x...", "buyEth": 1 }`);
});

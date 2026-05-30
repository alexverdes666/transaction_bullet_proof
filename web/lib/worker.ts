/**
 * Client for the internal scan worker (Render). The shared secret is sent in a
 * header and is held only on the server, so end users can neither see it nor
 * call the worker directly to obtain free scans.
 */
import 'server-only';
import { env } from './env';

export interface HoneypotReport {
  target: string;
  verdict: 'SAFE' | 'SUSPICIOUS' | 'HONEYPOT' | 'ERROR';
  riskScore: number;
  summary: string;
  roundTrip: unknown;
  balanceDiff: unknown[];
  storageDiff: unknown[];
  anomalies: { severity: string; code: string; message: string }[];
  fork: { rpcUrl: string; blockNumber: string; chainId: number };
  durationMs: number;
  generatedAt: string;
}

export async function runScanOnWorker(token: string): Promise<HoneypotReport> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${env.workerUrl.replace(/\/$/, '')}/scan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': env.workerSecret,
      },
      body: JSON.stringify({ token }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`worker responded ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as HoneypotReport;
  } finally {
    clearTimeout(timeout);
  }
}

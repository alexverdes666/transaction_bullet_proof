/**
 * Client for the internal scan worker (Render). The shared secret is sent in a
 * header and is held only on the server, so end users can neither see it nor
 * call the worker directly to obtain free scans.
 */
import 'server-only';
import { z } from 'zod';
import { env } from './env';

/**
 * Runtime schema for the worker's report. The worker is internal, but the web
 * app stores and surfaces this verbatim and the UI iterates `anomalies`, so a
 * malformed payload must fail fast at this trust boundary rather than crash a
 * page. Matches the engine's HoneypotReport contract (src/types.ts).
 *
 * Lenient where the engine may legitimately vary: `severity` is a plain string
 * (so a new label never rejects a valid report) and nested `roundTrip` /
 * `fork` shapes are passthrough objects.
 */
const tokenInfoSchema = z
  .object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
    totalSupply: z.string().optional(),
    imageUrl: z.string().optional(),
    priceUsd: z.string().optional(),
    liquidityUsd: z.number().optional(),
    fdv: z.number().optional(),
    marketCap: z.number().optional(),
    pairCreatedAt: z.number().optional(),
    dexId: z.string().optional(),
    pairUrl: z.string().optional(),
    websites: z.array(z.string()).optional(),
    socials: z.array(z.object({ type: z.string(), url: z.string() })).optional(),
    detectedChainName: z.string().optional(),
    detectedChainId: z.string().optional(),
    detectedVia: z.string().optional(),
    explorerUrl: z.string().optional(),
    tradesOn: z
      .array(z.object({ chain: z.string(), chainName: z.string(), liquidityUsd: z.number() }))
      .optional(),
  })
  .passthrough();

const reportSchema = z.object({
  target: z.string(),
  verdict: z.enum(['SAFE', 'SUSPICIOUS', 'HONEYPOT', 'ERROR']),
  riskScore: z.number(),
  summary: z.string(),
  // Multi-chain + enrichment (optional so older worker builds still validate).
  chain: z.string().optional(),
  chainName: z.string().optional(),
  tokenInfo: tokenInfoSchema.optional(),
  roundTrip: z.union([z.record(z.unknown()), z.null()]),
  balanceDiff: z.array(z.unknown()),
  storageDiff: z.array(z.unknown()),
  anomalies: z.array(
    z.object({
      severity: z.string(),
      code: z.string(),
      message: z.string(),
    }),
  ),
  fork: z.object({
    rpcUrl: z.string(),
    blockNumber: z.string(),
    chainId: z.number(),
  }),
  durationMs: z.number(),
  generatedAt: z.string(),
});

export type HoneypotReport = z.infer<typeof reportSchema>;

export async function runScanOnWorker(token: string, chain?: string): Promise<HoneypotReport> {
  const controller = new AbortController();
  // Nest under the scan route's maxDuration (120s) and above the worker's own
  // internal budget, so the web side aborts cleanly before the platform kills us.
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${env.workerUrl.replace(/\/$/, '')}/scan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': env.workerSecret,
      },
      body: JSON.stringify({ token, ...(chain ? { chain } : {}) }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`worker responded ${res.status}: ${text.slice(0, 200)}`);
    }
    // Validate at the trust boundary: the web app stores and surfaces this
    // verbatim, so a malformed report must fail fast, not propagate downstream.
    const parsed = reportSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`worker returned a malformed report: ${parsed.error.message}`);
    }
    return parsed.data;
  } finally {
    clearTimeout(timeout);
  }
}

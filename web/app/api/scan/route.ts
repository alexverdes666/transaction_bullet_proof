import type { NextRequest } from 'next/server';
import { connectDb } from '@/lib/db';
import { scanSchema } from '@/lib/validation';
import { requireUser } from '@/lib/auth';
import { reqContext } from '@/lib/request';
import { rateLimit } from '@/lib/ratelimit';
import { audit } from '@/lib/audit';
import { runScanOnWorker } from '@/lib/worker';
import { json, fail, handleError } from '@/lib/api';
import { assertSameOrigin } from '@/lib/csrf';
import { User } from '@/models/User';
import { Scan } from '@/models/Scan';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const ctx = reqContext(req);
  try {
    assertSameOrigin(req);
    const user = await requireUser();

    const rl = await rateLimit(`scan:${user.id}`, 20, 60);
    if (!rl.ok) {
      await audit({ type: 'rate_limited', ctx, userId: user.id, detail: { route: 'scan' } });
      return fail('Slow down — too many scans per minute.', 429);
    }

    // `chain` is accepted (optional) for power users, but the default flow
    // auto-detects the chain on the worker — the UI no longer asks the user.
    const { token, chain } = scanSchema.parse(await req.json());
    await connectDb();

    // PAYWALL: atomically spend one credit. The `credits > 0` guard makes this
    // safe under concurrency — two requests can never both spend the last credit.
    const spent = await User.findOneAndUpdate(
      { _id: user.id, credits: { $gt: 0 }, status: 'active' },
      { $inc: { credits: -1 } },
      { new: true },
    );
    if (!spent) {
      await audit({ type: 'scan_denied', ctx, userId: user.id, detail: { token, reason: 'no_credits' } });
      return fail('You have no scan credits. Please purchase a pack.', 402);
    }

    let report;
    try {
      report = await runScanOnWorker(token, chain);
    } catch (e) {
      // Infra failure is not the user's fault — refund the credit. Mirror the
      // spend's `status: 'active'` guard so a banned user isn't re-credited.
      await User.updateOne({ _id: user.id, status: 'active' }, { $inc: { credits: 1 } });
      // Log a stable code, not the raw error string (avoids leaking internals/PII).
      console.error('scan worker_error', e);
      await audit({ type: 'scan_denied', ctx, userId: user.id, detail: { token, reason: 'worker_error', error: e instanceof Error ? e.name : 'unknown' } });
      return fail('The scan engine is temporarily unavailable. Your credit was not used.', 503);
    }

    // Store the chain the worker actually scanned (auto-detected), falling back
    // to the requested/ default for info-only ERROR reports where none ran.
    const scannedChain = report.chain ?? chain ?? 'ethereum';
    await Scan.create({
      userId: user.id,
      token,
      chain: scannedChain,
      verdict: report.verdict,
      riskScore: report.riskScore,
      summary: report.summary,
      report,
      durationMs: report.durationMs,
    });
    await audit({ type: 'scan', ctx, userId: user.id, detail: { token, chain: scannedChain, verdict: report.verdict, risk: report.riskScore } });

    return json({ ok: true, report, creditsRemaining: spent.credits });
  } catch (e) {
    return handleError(e);
  }
}

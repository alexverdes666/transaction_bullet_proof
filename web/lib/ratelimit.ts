/**
 * Mongo-backed fixed-window rate limiter. Works across serverless instances
 * (unlike an in-memory map), so limits can't be bypassed by hitting a different
 * cold start.
 */
import 'server-only';
import { connectDb, isDuplicateKey } from './db';
import { RateLimit } from '@/models/RateLimit';

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
}

/**
 * @param key    unique bucket, e.g. `login:<ip>` or `scan:<userId>`
 * @param limit  max actions per window
 * @param windowSec window length in seconds
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  await connectDb();
  const now = Date.now();
  const windowStart = new Date(now - (now % (windowSec * 1000)));
  const expiresAt = new Date(windowStart.getTime() + windowSec * 1000);
  const bucketKey = `${key}:${windowStart.getTime()}`;

  let doc;
  try {
    doc = await RateLimit.findOneAndUpdate(
      { key: bucketKey },
      { $inc: { count: 1 }, $setOnInsert: { windowStart, expiresAt } },
      { upsert: true, new: true },
    );
  } catch (e) {
    // Unique-index race: two requests opened the same fresh window at once and
    // both tried to insert. The bucket now exists, so retry as a plain increment.
    if (isDuplicateKey(e)) {
      doc = await RateLimit.findOneAndUpdate({ key: bucketKey }, { $inc: { count: 1 } }, { new: true });
    } else {
      throw e;
    }
  }

  const count = doc?.count ?? 1;
  return { ok: count <= limit, remaining: Math.max(0, limit - count) };
}

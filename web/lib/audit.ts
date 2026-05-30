/** Write an audit-log entry and fold IP/fingerprint sightings onto the user. */
import 'server-only';
import { Types } from 'mongoose';
import { connectDb } from './db';
import { AuditLog } from '@/models/AuditLog';
import { User } from '@/models/User';
import type { ReqContext } from './request';

export type AuditType =
  | 'register'
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'scan'
  | 'scan_denied'
  | 'order_created'
  | 'order_paid'
  | 'order_failed'
  | 'admin_view'
  | 'admin_login'
  | 'admin_denied'
  | 'rate_limited';

interface AuditInput {
  type: AuditType;
  ctx: ReqContext;
  userId?: Types.ObjectId | string | null;
  email?: string;
  detail?: Record<string, unknown>;
}

export async function audit(input: AuditInput): Promise<void> {
  await connectDb();
  try {
    await AuditLog.create({
      type: input.type,
      userId: input.userId ?? null,
      email: input.email,
      ip: input.ctx.ip,
      userAgent: input.ctx.userAgent,
      fingerprint: input.ctx.fingerprint,
      detail: input.detail ?? {},
    });
  } catch {
    // Auditing must never break the main flow.
  }
}

/**
 * Record an IP + fingerprint sighting on the user document (upserting the
 * aggregate arrays and bumping counts). Best-effort.
 */
export async function recordSighting(
  userId: Types.ObjectId | string,
  ctx: ReqContext,
): Promise<void> {
  await connectDb();
  const now = new Date();
  try {
    // Bump existing IP sighting, else push a new one.
    const ipRes = await User.updateOne(
      { _id: userId, 'ips.ip': ctx.ip },
      { $set: { 'ips.$.lastSeen': now, lastIp: ctx.ip, lastUserAgent: ctx.userAgent }, $inc: { 'ips.$.count': 1 } },
    );
    if (ipRes.matchedCount === 0) {
      await User.updateOne(
        { _id: userId },
        { $push: { ips: { ip: ctx.ip, firstSeen: now, lastSeen: now, count: 1 } }, $set: { lastIp: ctx.ip, lastUserAgent: ctx.userAgent } },
      );
    }

    if (ctx.fingerprint && ctx.fingerprint !== 'none') {
      const fpRes = await User.updateOne(
        { _id: userId, 'fingerprints.hash': ctx.fingerprint },
        { $set: { 'fingerprints.$.lastSeen': now, 'fingerprints.$.userAgent': ctx.userAgent }, $inc: { 'fingerprints.$.count': 1 } },
      );
      if (fpRes.matchedCount === 0) {
        await User.updateOne(
          { _id: userId },
          { $push: { fingerprints: { hash: ctx.fingerprint, userAgent: ctx.userAgent, firstSeen: now, lastSeen: now, count: 1 } } },
        );
      }
    }
  } catch {
    /* best-effort */
  }
}

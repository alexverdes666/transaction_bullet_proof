/**
 * Session management: opaque random token in an httpOnly cookie, only its
 * SHA-256 hash persisted server-side. A DB leak therefore yields no usable
 * cookies, and the 256-bit token is unguessable.
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { connectDb } from './db';
import { env } from './env';
import { Session } from '@/models/Session';
import { User, type UserDoc } from '@/models/User';
import type { ReqContext } from './request';

export const SESSION_COOKIE = 'bp_session';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function createSession(
  userId: string,
  ctx: ReqContext,
): Promise<void> {
  await connectDb();
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + env.sessionTtlDays * 86_400_000);
  await Session.create({
    userId,
    tokenHash: sha256(token),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    expiresAt,
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export interface AuthedUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'banned';
  credits: number;
  emailVerified: boolean;
}

function toAuthed(u: UserDoc): AuthedUser {
  return {
    id: String(u._id),
    email: u.email,
    role: u.role as 'user' | 'admin',
    status: u.status as 'active' | 'banned',
    credits: u.credits,
    emailVerified: u.emailVerified,
  };
}

/** Resolve the current user from the session cookie, or null. */
export async function getSessionUser(): Promise<AuthedUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  await connectDb();
  const session = await Session.findOne({ tokenHash: sha256(token) });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  const user = await User.findById(session.userId);
  if (!user || user.status === 'banned') return null;
  return toAuthed(user);
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await connectDb();
    await Session.deleteOne({ tokenHash: sha256(token) });
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Authorization guards used by route handlers and server components.
 * `getSessionUser` is the single source of truth; these add role/access checks.
 */
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from './env';
import { getSessionUser, type AuthedUser } from './session';
import type { ReqContext } from './request';

export const ADMIN_KEY_COOKIE = 'bp_admin_key';

/**
 * Constant-time equality for the admin access key, to avoid leaking the key via
 * response-timing (matches the project's convention in src/server.ts and
 * lib/password.ts). Length-guarded since timingSafeEqual requires equal lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True iff `provided` matches the configured admin access key. Returns false if
 * no key is configured or none was provided.
 */
export function checkAdminKey(provided: string | undefined | null): boolean {
  if (!env.adminAccessKey || !provided) return false;
  return constantTimeEqual(provided, env.adminAccessKey);
}

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Require any logged-in, active user. Throws AuthError(401) otherwise. */
export async function requireUser(): Promise<AuthedUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError(401, 'Not authenticated');
  if (user.status === 'banned') throw new AuthError(403, 'Account suspended');
  return user;
}

export type AdminGate = 'ok' | 'not_admin' | 'ip_blocked' | 'needs_unlock';

/**
 * Evaluate admin access without throwing, so callers can show an unlock form vs
 * a 404 appropriately. Defence in depth: the `admin` role, an optional IP
 * allowlist, AND a second-factor access key (held in an httpOnly cookie set by
 * the unlock step) — the obscure URL is only obfuscation on top of these.
 */
export async function adminGate(ctx: ReqContext): Promise<{ gate: AdminGate; user: AuthedUser | null }> {
  const user = await getSessionUser();
  if (!user || user.role !== 'admin') return { gate: 'not_admin', user: null };
  if (env.adminIpAllowlist.length > 0 && !env.adminIpAllowlist.includes(ctx.ip)) {
    return { gate: 'ip_blocked', user };
  }
  if (env.adminAccessKey) {
    const jar = await cookies();
    if (!checkAdminKey(jar.get(ADMIN_KEY_COOKIE)?.value)) {
      return { gate: 'needs_unlock', user };
    }
  }
  return { gate: 'ok', user };
}

/** Throwing variant for admin API routes. Returns 404 to avoid revealing the panel. */
export async function requireAdmin(ctx: ReqContext): Promise<AuthedUser> {
  const { gate, user } = await adminGate(ctx);
  if (gate !== 'ok' || !user) throw new AuthError(404, 'Not found');
  return user;
}

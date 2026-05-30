/**
 * Helpers for pulling the actor's IP, user-agent and fingerprint out of an
 * incoming request. On Vercel the client IP is in `x-forwarded-for`.
 */
import 'server-only';
import type { NextRequest } from 'next/server';

export const FINGERPRINT_COOKIE = 'bp_fp';

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export function userAgent(req: NextRequest): string {
  return req.headers.get('user-agent') ?? 'unknown';
}

/** Fingerprint is computed client-side and sent via header or cookie. */
export function fingerprint(req: NextRequest): string {
  return (
    req.headers.get('x-bp-fingerprint') ??
    req.cookies.get(FINGERPRINT_COOKIE)?.value ??
    'none'
  );
}

export interface ReqContext {
  ip: string;
  userAgent: string;
  fingerprint: string;
}

export function reqContext(req: NextRequest): ReqContext {
  return { ip: clientIp(req), userAgent: userAgent(req), fingerprint: fingerprint(req) };
}

/**
 * Same context, but built from `next/headers` for use inside Server Components
 * and Server Actions where there is no NextRequest object.
 */
export async function reqContextFromHeaders(): Promise<ReqContext> {
  const { headers, cookies } = await import('next/headers');
  const h = await headers();
  const c = await cookies();
  const xff = h.get('x-forwarded-for');
  return {
    ip: xff ? xff.split(',')[0]!.trim() : (h.get('x-real-ip') ?? 'unknown'),
    userAgent: h.get('user-agent') ?? 'unknown',
    fingerprint: h.get('x-bp-fingerprint') ?? c.get(FINGERPRINT_COOKIE)?.value ?? 'none',
  };
}

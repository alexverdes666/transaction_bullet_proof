/**
 * Helpers for pulling the actor's IP, user-agent and fingerprint out of an
 * incoming request. On Vercel the client IP is in `x-forwarded-for`.
 */
import 'server-only';
import type { NextRequest } from 'next/server';

export const FINGERPRINT_COOKIE = 'bp_fp';

// --- Shared extraction rules (single source of truth for both code paths) ---

/** Client IP: first hop of `x-forwarded-for` (Vercel), else `x-real-ip`. */
function ipFromHeaders(h: Headers): string {
  const xff = h.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return h.get('x-real-ip') ?? 'unknown';
}

function uaFromHeaders(h: Headers): string {
  return h.get('user-agent') ?? 'unknown';
}

/** Fingerprint: header first, then the bp_fp cookie value, else 'none'. */
function fpFromHeaders(h: Headers, cookieFp?: string): string {
  return h.get('x-bp-fingerprint') ?? cookieFp ?? 'none';
}

export function clientIp(req: NextRequest): string {
  return ipFromHeaders(req.headers);
}

export function userAgent(req: NextRequest): string {
  return uaFromHeaders(req.headers);
}

/** Fingerprint is computed client-side and sent via header or cookie. */
export function fingerprint(req: NextRequest): string {
  return fpFromHeaders(req.headers, req.cookies.get(FINGERPRINT_COOKIE)?.value);
}

export interface ReqContext {
  ip: string;
  userAgent: string;
  fingerprint: string;
}

export function reqContext(req: NextRequest): ReqContext {
  return {
    ip: clientIp(req),
    userAgent: userAgent(req),
    fingerprint: fingerprint(req),
  };
}

/**
 * Same context, but built from `next/headers` for use inside Server Components
 * and Server Actions where there is no NextRequest object.
 */
export async function reqContextFromHeaders(): Promise<ReqContext> {
  const { headers, cookies } = await import('next/headers');
  const h = await headers();
  const c = await cookies();
  return {
    ip: ipFromHeaders(h),
    userAgent: uaFromHeaders(h),
    fingerprint: fpFromHeaders(h, c.get(FINGERPRINT_COOKIE)?.value),
  };
}

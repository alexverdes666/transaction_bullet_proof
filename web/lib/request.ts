/**
 * Helpers for pulling the actor's IP, user-agent and fingerprint out of an
 * incoming request. On Vercel the client IP is in `x-forwarded-for`.
 */
import 'server-only';
import type { NextRequest } from 'next/server';

export const FINGERPRINT_COOKIE = 'bp_fp';

// --- Shared extraction rules (single source of truth for both code paths) ---

/**
 * Client IP. SECURITY: the leftmost hop of `x-forwarded-for` is set by the
 * client and is therefore spoofable — trusting it would let an attacker forge
 * any IP, defeating the admin IP allowlist, per-IP rate limits, and audit IPs.
 *
 * Vercel sets `x-vercel-forwarded-for` to the real client IP it observed (the
 * client cannot forge it because Vercel overwrites it at the edge), so prefer
 * that when present. Only when there is no trusted platform header do we fall
 * back to XFF / `x-real-ip`.
 */
function ipFromHeaders(h: Headers): string {
  // Trusted, platform-set header (Vercel). Not client-forgeable.
  const vercel = h.get('x-vercel-forwarded-for');
  if (vercel) return vercel.split(',')[0]!.trim();
  const xff = h.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return h.get('x-real-ip') ?? 'unknown';
}

function uaFromHeaders(h: Headers): string {
  return h.get('user-agent') ?? 'unknown';
}

/**
 * Validate a client-supplied fingerprint. It is attacker-controlled (sent via
 * header or cookie), so cap its length and restrict to a sane charset to stop
 * injection of oversized or garbage values into the DB / audit log.
 */
const FP_MAX_LEN = 128;
const FP_RE = /^[A-Za-z0-9+/=_-]+$/; // hex / base64url-ish
function sanitizeFingerprint(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (v.length === 0 || v.length > FP_MAX_LEN || !FP_RE.test(v)) return undefined;
  return v;
}

/** Fingerprint: header first, then the bp_fp cookie value, else 'none'. */
function fpFromHeaders(h: Headers, cookieFp?: string): string {
  return (
    sanitizeFingerprint(h.get('x-bp-fingerprint')) ??
    sanitizeFingerprint(cookieFp) ??
    'none'
  );
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

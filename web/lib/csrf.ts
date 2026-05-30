/**
 * Lightweight CSRF defence for mutating route handlers.
 *
 * Session cookies are already `SameSite=strict`, which blocks the classic
 * cross-site form/POST attack in modern browsers. This adds a second, explicit
 * layer: for state-changing requests we reject when the request carries an
 * `Origin` header whose host does not match the request's own host.
 *
 * Why "when present": legitimate same-origin browser `fetch`/form POSTs always
 * send a matching `Origin`. Non-browser clients (and the e2e workflow test's
 * Node `fetch`) may omit `Origin` entirely; we don't punish those — the cookie
 * gate (`requireUser`/SameSite) still applies. We only act on a *mismatch*,
 * which is the unambiguous cross-site signal.
 */
import 'server-only';
import type { NextRequest } from 'next/server';

export class CsrfError extends Error {
  status = 403;
  constructor() {
    super('Cross-site request blocked');
    this.name = 'CsrfError';
  }
}

/**
 * Throws {@link CsrfError} if the request looks cross-site. Call at the top of
 * mutating (POST/PUT/PATCH/DELETE) handlers, after parsing nothing else.
 */
export function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get('origin');
  if (!origin) return; // no Origin → not a cross-site browser request we can judge

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new CsrfError(); // malformed Origin is never legitimate
  }

  // Prefer the forwarded host (set by the platform) so we compare against the
  // public host the browser actually used, then fall back to the Host header.
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host || originHost !== host) throw new CsrfError();
}

import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware:
 *  1. Maps the secret admin path (ADMIN_PATH) onto the internal `/__admin` route
 *     and 404s any direct hit on `/__admin`, so the panel's location stays hidden.
 *  2. Applies security headers to every response.
 *
 * Read ADMIN_PATH straight from process.env (not the server-only `env` module,
 * which validates secrets unrelated to the edge runtime).
 */
const ADMIN_PATH = process.env.ADMIN_PATH || 'ctrl-9f3a7c21';
// Internal route the secret path is rewritten to. Must NOT start with "_"
// (Next.js treats `_`-prefixed folders as private/non-routable).
const INTERNAL_ADMIN = '/control-internal';

function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.headers.set('X-DNS-Prefetch-Control', 'off');
  if (process.env.NODE_ENV === 'production') {
    res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  // Conservative CSP: allow same-origin assets; no third-party script origins.
  res.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Block any direct probe of the internal admin route.
  if (pathname === INTERNAL_ADMIN || pathname.startsWith(INTERNAL_ADMIN + '/')) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // Rewrite the secret path to the internal admin route.
  if (pathname === `/${ADMIN_PATH}` || pathname.startsWith(`/${ADMIN_PATH}/`)) {
    const rest = pathname.slice(`/${ADMIN_PATH}`.length);
    const url = req.nextUrl.clone();
    url.pathname = INTERNAL_ADMIN + rest;
    return withSecurityHeaders(NextResponse.rewrite(url));
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  // Run on everything except Next internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)'],
};

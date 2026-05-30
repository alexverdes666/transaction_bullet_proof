import { NextRequest, NextResponse } from "next/server";

/**
 * Admin URL obfuscation.
 *
 * The admin panel lives at a secret, env-configured path (ADMIN_PATH). The
 * proxy rewrites that secret path onto the internal `/control-internal` route so
 * the real route folder name is never exposed. Direct requests to
 * `/control-internal` are 404'd so the internal path can't be hit even if guessed.
 *
 * (Next.js private folders — `_`-prefixed — are not routable, so the real route
 * folder is `control-internal`, mapped here.)
 */
const ADMIN_PATH = process.env.ADMIN_PATH || "";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Block direct access to the internal admin route.
  if (pathname === "/control-internal" || pathname.startsWith("/control-internal/")) {
    return NextResponse.rewrite(new URL("/404", req.url));
  }

  // Rewrite the secret admin path to the internal route.
  if (ADMIN_PATH && (pathname === ADMIN_PATH || pathname.startsWith(ADMIN_PATH + "/"))) {
    return NextResponse.rewrite(new URL("/control-internal", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};

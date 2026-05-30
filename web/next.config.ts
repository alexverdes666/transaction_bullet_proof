import type { NextConfig } from "next";
import path from "node:path";

/**
 * Content-Security-Policy.
 *
 * Pragmatic-but-strict baseline. Next's App Router injects inline bootstrap
 * `<script>` and inline `<style>` without a nonce, so `script-src`/`style-src`
 * need `'unsafe-inline'` for the app to hydrate and render. Everything else is
 * locked to same-origin. `connect-src` allows the app's own origin (the browser
 * only ever talks to our own API; the worker + chain RPC are called server-side,
 * never from the page). We do NOT allow `'unsafe-eval'` — production builds don't
 * need it. `frame-ancestors 'none'` + `X-Frame-Options: DENY` block clickjacking.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // 2 years, include subdomains, preload-eligible. HTTPS-only deploy (Vercel).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  // The repo root also has a package-lock.json (the scan engine). Pin Turbopack's
  // root to this app so it doesn't infer the monorepo root.
  turbopack: {
    root: path.join(__dirname),
  },
  // Mongoose is a server-only dependency; keep it external to the server bundle.
  serverExternalPackages: ["mongoose"],
  // Security headers on EVERY route (pages + API). Unlike proxy.ts this also
  // covers /api responses.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

/** Consistent JSON responses + error mapping for route handlers. */
import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AuthError } from './auth';

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Map thrown errors to safe responses (never leak internals to the client). */
export function handleError(e: unknown): NextResponse {
  if (e instanceof AuthError) return fail(e.message, e.status);
  if (e instanceof ZodError) {
    const first = e.issues[0];
    return fail(first ? `${first.path.join('.')}: ${first.message}` : 'Invalid input', 400);
  }
  console.error('[api] unhandled error:', e);
  return fail('Internal server error', 500);
}

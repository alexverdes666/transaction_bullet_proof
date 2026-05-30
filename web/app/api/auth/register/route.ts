import type { NextRequest } from 'next/server';
import { connectDb } from '@/lib/db';
import { registerSchema } from '@/lib/validation';
import { hashPassword } from '@/lib/password';
import { createSession } from '@/lib/session';
import { reqContext } from '@/lib/request';
import { rateLimit } from '@/lib/ratelimit';
import { audit, recordSighting } from '@/lib/audit';
import { json, fail, handleError } from '@/lib/api';
import { assertSameOrigin } from '@/lib/csrf';
import { User } from '@/models/User';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const ctx = reqContext(req);
  try {
    assertSameOrigin(req);
    const rl = await rateLimit(`register:${ctx.ip}`, 5, 3600);
    if (!rl.ok) {
      await audit({ type: 'rate_limited', ctx, detail: { route: 'register' } });
      return fail('Too many attempts. Try again later.', 429);
    }

    const { email, password } = registerSchema.parse(await req.json());
    await connectDb();

    const existing = await User.findOne({ email }).select('_id');
    if (existing) return fail('An account with that email already exists.', 409);

    const passwordHash = await hashPassword(password);
    const user = await User.create({
      email,
      passwordHash,
      role: 'user',
      credits: 0,
      lastIp: ctx.ip,
      lastUserAgent: ctx.userAgent,
    });

    await createSession(String(user._id), ctx);
    await recordSighting(user._id, ctx);
    await audit({ type: 'register', ctx, userId: user._id, email });

    return json({ ok: true, user: { email: user.email, credits: user.credits } });
  } catch (e) {
    return handleError(e);
  }
}

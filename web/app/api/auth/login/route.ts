import type { NextRequest } from 'next/server';
import { connectDb } from '@/lib/db';
import { loginSchema } from '@/lib/validation';
import { verifyPassword } from '@/lib/password';
import { createSession } from '@/lib/session';
import { reqContext } from '@/lib/request';
import { rateLimit } from '@/lib/ratelimit';
import { audit, recordSighting } from '@/lib/audit';
import { json, fail, handleError } from '@/lib/api';
import { User } from '@/models/User';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const ctx = reqContext(req);
  try {
    // Limit by IP and by account to blunt credential stuffing + targeted attacks.
    const ipRl = await rateLimit(`login:ip:${ctx.ip}`, 10, 900);
    if (!ipRl.ok) {
      await audit({ type: 'rate_limited', ctx, detail: { route: 'login' } });
      return fail('Too many attempts. Try again later.', 429);
    }

    const { email, password } = loginSchema.parse(await req.json());
    const acctRl = await rateLimit(`login:acct:${email}`, 8, 900);
    if (!acctRl.ok) return fail('Too many attempts. Try again later.', 429);

    await connectDb();
    const user = await User.findOne({ email });
    // Always run a verification to keep timing roughly constant, then decide.
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;

    if (!user || !ok) {
      await audit({ type: 'login_failed', ctx, email, userId: user?._id ?? null });
      return fail('Invalid email or password.', 401);
    }
    if (user.status === 'banned') {
      await audit({ type: 'login_failed', ctx, email, userId: user._id, detail: { reason: 'banned' } });
      return fail('Account suspended.', 403);
    }

    await createSession(String(user._id), ctx);
    await recordSighting(user._id, ctx);
    await User.updateOne(
      { _id: user._id },
      { $set: { lastLoginAt: new Date(), lastIp: ctx.ip, lastUserAgent: ctx.userAgent }, $inc: { loginCount: 1 } },
    );
    await audit({ type: 'login', ctx, userId: user._id, email });

    return json({ ok: true, user: { email: user.email, credits: user.credits, role: user.role } });
  } catch (e) {
    return handleError(e);
  }
}

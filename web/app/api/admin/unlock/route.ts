import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { getSessionUser } from '@/lib/session';
import { ADMIN_KEY_COOKIE } from '@/lib/auth';
import { env } from '@/lib/env';
import { reqContext } from '@/lib/request';
import { rateLimit } from '@/lib/ratelimit';
import { audit } from '@/lib/audit';
import { json, fail, handleError } from '@/lib/api';

export const runtime = 'nodejs';

const schema = z.object({ key: z.string().min(1).max(200) });

// Second-factor unlock for the admin panel. Requires an already-authenticated
// admin; sets the access-key cookie only if the key matches.
export async function POST(req: NextRequest) {
  const ctx = reqContext(req);
  try {
    const rl = await rateLimit(`admin_unlock:${ctx.ip}`, 5, 600);
    if (!rl.ok) return fail('Too many attempts.', 429);

    const user = await getSessionUser();
    if (!user || user.role !== 'admin') {
      await audit({ type: 'admin_denied', ctx, userId: user?.id, detail: { step: 'unlock' } });
      return fail('Not found', 404);
    }

    const { key } = schema.parse(await req.json());
    if (!env.adminAccessKey || key !== env.adminAccessKey) {
      await audit({ type: 'admin_denied', ctx, userId: user.id, detail: { step: 'bad_key' } });
      return fail('Invalid key', 401);
    }

    const jar = await cookies();
    jar.set(ADMIN_KEY_COOKIE, key, {
      httpOnly: true,
      secure: env.isProd,
      sameSite: 'strict',
      path: '/',
      maxAge: 3600, // re-unlock hourly
    });
    await audit({ type: 'admin_login', ctx, userId: user.id, email: user.email });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

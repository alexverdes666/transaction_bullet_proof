import type { NextRequest } from 'next/server';
import { destroyCurrentSession, getSessionUser } from '@/lib/session';
import { reqContext } from '@/lib/request';
import { audit } from '@/lib/audit';
import { json, handleError } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const ctx = reqContext(req);
  try {
    const user = await getSessionUser();
    await destroyCurrentSession();
    if (user) await audit({ type: 'logout', ctx, userId: user.id, email: user.email });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

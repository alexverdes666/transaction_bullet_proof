import { getSessionUser } from '@/lib/session';
import { json, handleError } from '@/lib/api';

export const runtime = 'nodejs';

// Lightweight current-user probe for the client UI.
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return json({ user: null });
    return json({ user: { email: user.email, credits: user.credits, role: user.role } });
  } catch (e) {
    return handleError(e);
  }
}

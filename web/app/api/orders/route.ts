import type { NextRequest } from 'next/server';
import { createOrderSchema } from '@/lib/validation';
import { requireUser } from '@/lib/auth';
import { reqContext } from '@/lib/request';
import { rateLimit } from '@/lib/ratelimit';
import { audit } from '@/lib/audit';
import { createOrder, CREDIT_PACKS } from '@/lib/payments';
import { json, fail, handleError } from '@/lib/api';
import { assertSameOrigin } from '@/lib/csrf';

export const runtime = 'nodejs';

// List available packs (public-ish; requires login to keep pricing private to users).
export async function GET() {
  try {
    await requireUser();
    return json({ packs: CREDIT_PACKS });
  } catch (e) {
    return handleError(e);
  }
}

// Create a pending crypto payment order.
export async function POST(req: NextRequest) {
  const ctx = reqContext(req);
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const rl = await rateLimit(`order:${user.id}`, 10, 600);
    if (!rl.ok) return fail('Too many orders. Try again later.', 429);

    const { packId } = createOrderSchema.parse(await req.json());
    const order = await createOrder(user.id, packId);
    await audit({ type: 'order_created', ctx, userId: user.id, detail: { packId, reference: order.reference, amount: order.amount } });

    return json({
      ok: true,
      order: {
        id: String(order._id),
        reference: order.reference,
        credits: order.credits,
        amount: order.amount,
        tokenSymbol: order.tokenSymbol,
        tokenDecimals: order.tokenDecimals,
        tokenAddress: order.tokenAddress,
        chainId: order.chainId,
        treasury: order.treasury,
        expiresAt: order.expiresAt,
        status: order.status,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}

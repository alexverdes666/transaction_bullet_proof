import type { NextRequest } from 'next/server';
import { isValidObjectId } from 'mongoose';
import { connectDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { reqContext } from '@/lib/request';
import { rateLimit } from '@/lib/ratelimit';
import { audit } from '@/lib/audit';
import { verifyOrder } from '@/lib/payments';
import { json, fail, handleError } from '@/lib/api';
import { Order } from '@/models/Order';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Poll an order: checks the chain for a confirmed payment and grants credits.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = reqContext(req);
  try {
    const user = await requireUser();
    const { id } = await params;
    // Guard against a malformed id → Mongoose CastError → 500.
    if (!isValidObjectId(id)) return fail('Order not found.', 404);

    const rl = await rateLimit(`verify:${user.id}`, 30, 60);
    if (!rl.ok) return fail('Too many checks. Slow down.', 429);

    await connectDb();
    const order = await Order.findById(id);
    if (!order || String(order.userId) !== user.id) return fail('Order not found.', 404);

    const result = await verifyOrder(id);
    if (result.status === 'paid' && result.creditsGranted) {
      await audit({ type: 'order_paid', ctx, userId: user.id, detail: { orderId: id, txHash: result.txHash, credits: result.creditsGranted } });
    }

    return json({
      ok: true,
      status: result.status,
      txHash: result.txHash ?? null,
      creditsGranted: result.creditsGranted ?? 0,
    });
  } catch (e) {
    return handleError(e);
  }
}

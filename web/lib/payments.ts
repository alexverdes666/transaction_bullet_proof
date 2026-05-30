/**
 * Crypto payments: server-defined credit packs, order creation, and trustless
 * on-chain verification. The client only ever chooses a `packId`; price, credits
 * and the receiving treasury are decided here and confirmed against the chain.
 */
import 'server-only';
import mongoose from 'mongoose';
import { randomBytes, randomInt } from 'node:crypto';
import { createPublicClient, http, parseAbiItem, getAddress, type Address } from 'viem';
import { connectDb } from './db';
import { env } from './env';
import { Order, type OrderDoc } from '@/models/Order';
import { User } from '@/models/User';

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  /** Human price in whole token units (e.g. USDC). */
  priceTokens: number;
}

/** The single source of truth for pricing. Never trust a client-sent price. */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'starter', name: 'Starter', credits: 10, priceTokens: 5 },
  { id: 'pro', name: 'Pro', credits: 50, priceTokens: 20 },
  { id: 'whale', name: 'Whale', credits: 200, priceTokens: 60 },
] as const;

export function getPack(packId: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === packId);
}

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

function payClient() {
  return createPublicClient({ transport: http(env.pay.rpcUrl) });
}

/** Convert a whole-token price to base units. Exported for unit testing. */
export function baseUnits(whole: number): bigint {
  return BigInt(Math.round(whole * 10 ** env.pay.tokenDecimals));
}

/**
 * Create a pending order. A small random sub-unit offset is added to the amount
 * so two concurrent orders for the same pack get distinguishable totals, letting
 * us attribute an inbound transfer to exactly one order.
 */
export async function createOrder(userId: string, packId: string): Promise<OrderDoc> {
  const pack = getPack(packId);
  if (!pack) throw new Error('Unknown pack');
  if (!env.pay.treasury) throw new Error('Payments are not configured (no treasury address)');

  await connectDb();
  const client = payClient();
  const fromBlock = Number(await client.getBlockNumber());

  const offset = BigInt(randomInt(1, 10_000)); // up to 9999 base units of dust
  const amount = (baseUnits(pack.priceTokens) + offset).toString();
  const reference = randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + env.pay.orderTtlMinutes * 60_000);

  return Order.create({
    userId,
    reference,
    packId: pack.id,
    credits: pack.credits,
    amount,
    tokenAddress: getAddress(env.pay.tokenAddress),
    tokenSymbol: env.pay.tokenSymbol,
    tokenDecimals: env.pay.tokenDecimals,
    chainId: env.pay.chainId,
    treasury: getAddress(env.pay.treasury),
    fromBlock,
    expiresAt,
    status: 'pending',
  });
}

export interface VerifyResult {
  status: OrderDoc['status'];
  txHash?: string;
  creditsGranted?: number;
}

/**
 * Check the chain for a confirmed transfer that settles this order. Idempotent
 * and replay-safe: credits are granted exactly once (atomic pending→paid flip)
 * and a given txHash (unique index) can settle only one order.
 */
export async function verifyOrder(orderId: string): Promise<VerifyResult> {
  await connectDb();
  const order = await Order.findById(orderId);
  if (!order) throw new Error('Order not found');
  if (order.status === 'paid') {
    // Idempotent safety net: if a prior settle flipped status but crashed before
    // crediting (or pre-dates the creditsGranted guard), finish the grant now.
    await grantCreditsOnce(order._id, order.userId, order.credits);
    return { status: 'paid', txHash: order.txHash ?? undefined, creditsGranted: order.credits };
  }

  if (order.expiresAt.getTime() < Date.now()) {
    await Order.updateOne({ _id: order._id, status: 'pending' }, { $set: { status: 'expired' } });
    return { status: 'expired' };
  }

  const client = payClient();
  const latest = await client.getBlockNumber();
  const maxConfirmedBlock = latest - BigInt(env.pay.minConfirmations);
  if (maxConfirmedBlock < BigInt(order.fromBlock)) return { status: 'pending' }; // nothing confirmed yet

  const logs = await client.getLogs({
    address: order.tokenAddress as Address,
    event: TRANSFER_EVENT,
    args: { to: order.treasury as Address },
    fromBlock: BigInt(order.fromBlock),
    toBlock: maxConfirmedBlock,
  });

  const want = BigInt(order.amount);
  for (const log of logs) {
    if (log.args.value !== want) continue;
    const txHash = log.transactionHash;
    // Atomic settle: only the first caller flips pending→paid and grants credits.
    try {
      const settled = await Order.findOneAndUpdate(
        { _id: order._id, status: 'pending' },
        { $set: { status: 'paid', txHash, paidAt: new Date() } },
        { new: true },
      );
      if (!settled) {
        // Lost the settle race; make sure credits landed for the winner's order.
        await grantCreditsOnce(order._id, order.userId, order.credits);
        return { status: 'paid', txHash: order.txHash ?? undefined };
      }
      // Grant credits exactly once — atomically with the flag flip (see helper).
      await grantCreditsOnce(settled._id, settled.userId, settled.credits);
      return { status: 'paid', txHash, creditsGranted: order.credits };
    } catch (e) {
      // Duplicate txHash => this transfer already settled another order. Keep looking.
      if (isDuplicateKey(e)) continue;
      throw e;
    }
  }
  return { status: 'pending' };
}

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
}

/**
 * Grant an order's credits to its user EXACTLY once, crash-safely.
 *
 * The `creditsGranted` flag is the idempotency guard: only the call that flips it
 * false->true performs the `$inc`. On a replica set / Atlas the flip and the
 * increment commit in one transaction, so a crash can neither double-grant nor
 * leave a paid order uncredited. On a standalone Mongo (no transactions) we fall
 * back to the same guarded two-step, which is still safe against double-granting.
 */
async function grantCreditsOnce(orderId: unknown, userId: unknown, credits: number): Promise<void> {
  const claim = { _id: orderId, status: 'paid', creditsGranted: { $ne: true } };
  try {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const claimed = await Order.findOneAndUpdate(
          claim,
          { $set: { creditsGranted: true } },
          { new: true, session },
        );
        if (claimed) {
          await User.updateOne({ _id: userId }, { $inc: { credits } }, { session });
        }
      });
    } finally {
      await session.endSession();
    }
  } catch {
    // Standalone Mongo (transactions unsupported) or a transient transaction
    // error: fall back to the guarded claim+grant. The $ne:true guard still
    // prevents a double grant.
    const claimed = await Order.findOneAndUpdate(claim, { $set: { creditsGranted: true } }, { new: true });
    if (claimed) await User.updateOne({ _id: userId }, { $inc: { credits } });
  }
}

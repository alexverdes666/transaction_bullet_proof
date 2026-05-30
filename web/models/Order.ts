import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * A crypto payment order. Price/credits are set server-side from the pack table;
 * the client only chooses a packId. Payment is settled by matching an on-chain
 * transfer to (treasury, token, exact amount) after `createdAt`, with a unique
 * txHash so a single payment can never settle two orders (replay protection).
 * `creditsGranted` is the idempotency guard: credits are added exactly once, in
 * the same transaction that flips this flag (see lib/payments.grantCreditsOnce).
 */
const orderSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // `unique: true` already builds the index — no separate `index: true`.
  reference: { type: String, required: true, unique: true },
  packId: { type: String, required: true },
  credits: { type: Number, required: true },

  // Expected payment, in token base units (string to avoid float loss).
  amount: { type: String, required: true },
  tokenAddress: { type: String, required: true },
  tokenSymbol: { type: String, required: true },
  tokenDecimals: { type: Number, required: true },
  chainId: { type: Number, required: true },
  treasury: { type: String, required: true },

  // Block height at order creation; payment search starts here.
  fromBlock: { type: Number, required: true },

  status: {
    type: String,
    enum: ['pending', 'paid', 'expired', 'failed'],
    default: 'pending',
    index: true,
  },
  // The settling transaction. Unique (sparse) => one tx settles at most one order.
  txHash: { type: String, default: null },
  // Set true exactly once, atomically with the credit grant.
  creditsGranted: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  paidAt: Date,
});

// One on-chain tx can settle only one order.
orderSchema.index({ txHash: 1 }, { unique: true, sparse: true });
// User's own order history, newest first (also covers userId lookups).
orderSchema.index({ userId: 1, createdAt: -1 });
// Admin "recent orders across all users".
orderSchema.index({ createdAt: -1 });

export type OrderDoc = InferSchemaType<typeof orderSchema> & {
  _id: import('mongoose').Types.ObjectId;
};

export const Order: Model<OrderDoc> =
  (models.Order as Model<OrderDoc>) ?? model<OrderDoc>('Order', orderSchema);

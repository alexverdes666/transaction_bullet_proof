import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/** Fixed-window rate-limit counter, auto-expired by a TTL index. */
const rateLimitSchema = new Schema({
  key: { type: String, required: true, index: true }, // e.g. "login:1.2.3.4"
  count: { type: Number, default: 0 },
  windowStart: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

export type RateLimitDoc = InferSchemaType<typeof rateLimitSchema>;

export const RateLimit: Model<RateLimitDoc> =
  (models.RateLimit as Model<RateLimitDoc>) ?? model<RateLimitDoc>('RateLimit', rateLimitSchema);

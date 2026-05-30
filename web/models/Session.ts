import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * Server-side session record. The cookie holds an opaque random token; we store
 * only a keyed HMAC of it (see lib/session), so a DB leak cannot be replayed as
 * a live cookie. The TTL index on expiresAt auto-deletes expired sessions.
 */
const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // `unique: true` already builds a unique index — no separate `index: true`.
  tokenHash: { type: String, required: true, unique: true },
  ip: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now },
  // TTL index: Mongo auto-deletes the session at expiry.
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

export type SessionDoc = InferSchemaType<typeof sessionSchema> & {
  _id: import('mongoose').Types.ObjectId;
};

export const Session: Model<SessionDoc> =
  (models.Session as Model<SessionDoc>) ?? model<SessionDoc>('Session', sessionSchema);

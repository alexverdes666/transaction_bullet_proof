import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/** A captured browser fingerprint sighting. */
const fingerprintSchema = new Schema(
  {
    hash: { type: String, required: true },
    userAgent: String,
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    count: { type: Number, default: 1 },
  },
  { _id: false },
);

const ipSightingSchema = new Schema(
  {
    ip: { type: String, required: true },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    count: { type: Number, default: 1 },
  },
  { _id: false },
);

const userSchema = new Schema({
  // `unique: true` already builds a unique index — no separate `index: true`.
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // scrypt: stored as `salt:hash` hex. Never plaintext.
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
  status: { type: String, enum: ['active', 'banned'], default: 'active', index: true },

  // Paywall: scans remaining. Mutated only server-side, atomically.
  credits: { type: Number, default: 0, min: 0 },

  emailVerified: { type: Boolean, default: false },

  // Tracking aggregates (full history lives in auditLogs).
  ips: { type: [ipSightingSchema], default: [] },
  fingerprints: { type: [fingerprintSchema], default: [] },
  lastIp: String,
  lastUserAgent: String,
  lastLoginAt: Date,
  loginCount: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
});
// Admin user listing is sorted newest-first.
userSchema.index({ createdAt: -1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: import('mongoose').Types.ObjectId };

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) ?? model<UserDoc>('User', userSchema);

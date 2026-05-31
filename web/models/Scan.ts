import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/** A persisted scan result tied to the user who paid for it. */
const scanSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true, index: true },
  // Chain the scan ran on (e.g. "ethereum", "bsc"). Defaults to ethereum for
  // rows written before multi-chain support.
  chain: { type: String, default: 'ethereum' },
  verdict: { type: String, enum: ['SAFE', 'SUSPICIOUS', 'HONEYPOT', 'ERROR'], required: true },
  riskScore: { type: Number, default: 0 },
  summary: String,
  // Full HoneypotReport JSON from the worker (bigints already stringified).
  report: { type: Schema.Types.Mixed },
  durationMs: Number,
  // NOTE: IP/fingerprint are intentionally NOT stored here (data minimization).
  // The `scan` AuditLog event already records them and AuditLog has a TTL.
  createdAt: { type: Date, default: Date.now, index: true },
});
// Dashboard "recent scans": find by user, newest first (also covers userId lookups).
scanSchema.index({ userId: 1, createdAt: -1 });

export type ScanDoc = InferSchemaType<typeof scanSchema> & {
  _id: import('mongoose').Types.ObjectId;
};

export const Scan: Model<ScanDoc> =
  (models.Scan as Model<ScanDoc>) ?? model<ScanDoc>('Scan', scanSchema);

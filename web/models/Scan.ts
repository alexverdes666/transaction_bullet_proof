import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/** A persisted scan result tied to the user who paid for it. */
const scanSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  token: { type: String, required: true, index: true },
  verdict: { type: String, enum: ['SAFE', 'SUSPICIOUS', 'HONEYPOT', 'ERROR'], required: true },
  riskScore: { type: Number, default: 0 },
  summary: String,
  // Full HoneypotReport JSON from the worker (bigints already stringified).
  report: { type: Schema.Types.Mixed },
  durationMs: Number,
  ip: String,
  fingerprint: String,
  createdAt: { type: Date, default: Date.now, index: true },
});

export type ScanDoc = InferSchemaType<typeof scanSchema> & {
  _id: import('mongoose').Types.ObjectId;
};

export const Scan: Model<ScanDoc> =
  (models.Scan as Model<ScanDoc>) ?? model<ScanDoc>('Scan', scanSchema);

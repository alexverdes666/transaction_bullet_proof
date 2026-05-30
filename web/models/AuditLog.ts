import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { AUDIT_TYPES } from '@/lib/audit';

/**
 * Append-only activity trail. Every security-relevant event lands here with the
 * actor's IP, user-agent and fingerprint, powering the admin panel's view of
 * "who did what, from where". Rows auto-expire via a TTL index so this
 * PII-bearing trail does not grow without bound.
 */

const AUDIT_TTL_DAYS = 180;

const auditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  email: String, // denormalised for fast admin search (e.g. failed logins)
  type: { type: String, required: true, enum: [...AUDIT_TYPES], index: true },
  ip: String,
  userAgent: String,
  fingerprint: String,
  detail: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});
// Retention: auto-purge audit rows after AUDIT_TTL_DAYS to bound PII growth.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_TTL_DAYS * 24 * 60 * 60 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & {
  _id: import('mongoose').Types.ObjectId;
};

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc>) ?? model<AuditLogDoc>('AuditLog', auditLogSchema);

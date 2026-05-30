import 'server-only';
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

/**
 * Append-only activity trail. Every security-relevant event lands here with the
 * actor's IP, user-agent and fingerprint, powering the admin panel's view of
 * "who did what, from where".
 */
const auditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  email: String, // denormalised for fast admin search (e.g. failed logins)
  type: {
    type: String,
    required: true,
    index: true,
    // register | login | login_failed | logout | scan | scan_denied |
    // order_created | order_paid | order_failed | admin_view | admin_login | rate_limited
  },
  ip: String,
  userAgent: String,
  fingerprint: String,
  detail: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true },
});

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & {
  _id: import('mongoose').Types.ObjectId;
};

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc>) ?? model<AuditLogDoc>('AuditLog', auditLogSchema);

'use strict';

// Ported from Ess-Backend/src/models/AuditLog.js (commit 522bdbd), adapted for SLAS:
// - tenant, API-key and actorType=api_key fields removed
// - fixed action enum replaced by dotted action codes (auth.login, role.update, ...)
// - before/after values and on-behalf-of added (BRD NFR-05, FR-50)
// - append-only: every update/delete path is blocked

const mongoose = require('mongoose');
const appendOnly = require('./plugins/appendOnly');

const auditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorStaffNo: String,
    onBehalfOfId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true, match: /^[a-z]+(\.[a-z_]+)+$/ },
    description: { type: String, required: true },
    entity: String,
    entityId: String,
    appRef: String,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
    ip: String,
    userAgent: String,
    correlationId: String,
    method: String,
    path: String,
    // FR-55: the entry concerns a limited-details application; descriptions never carry terms.
    limited: { type: Boolean, default: false },
  },
  { versionKey: false }
);

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ actorId: 1, at: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });

auditLogSchema.plugin(appendOnly, { name: 'Audit log' });

module.exports = mongoose.model('AuditLog', auditLogSchema);

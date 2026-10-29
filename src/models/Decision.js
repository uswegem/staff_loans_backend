'use strict';

// Every step in an application's history (FR-14: prior decisions and comments).
// Append-only, like the audit log.

const mongoose = require('mongoose');
const appendOnly = require('./plugins/appendOnly');

const decisionSchema = new mongoose.Schema(
  {
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', required: true },
    cycle: { type: Number, default: 1 },
    stage: { type: String, default: null },
    action: {
      type: String,
      required: true,
      enum: ['create', 'submit', 'resubmit', 'approve', 'return', 'reject', 'withdraw', 'accept_revised', 'decline_revised', 'expire', 'disburse'],
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    onBehalfOfId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    comment: { type: String, maxlength: 2000 },
    details: mongoose.Schema.Types.Mixed,
    at: { type: Date, default: Date.now },
    ip: String,
  },
  { versionKey: false }
);

decisionSchema.index({ applicationId: 1, at: 1 });
decisionSchema.index({ actorId: 1, at: -1 });
decisionSchema.plugin(appendOnly, { name: 'Decision' });

module.exports = mongoose.model('Decision', decisionSchema);

'use strict';

// Time-bound delegation of review permissions (FR-19, BRD 7.3). While active, the
// delegate acts in the delegator's place; decisions record both names ("on behalf of").
// from and until are calendar days (local midnight); until is inclusive.

const mongoose = require('mongoose');

const delegationSchema = new mongoose.Schema(
  {
    delegatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    delegateId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    permissions: { type: [String], required: true }, // the review.* permissions handed over
    from: { type: Date, required: true },
    until: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

delegationSchema.index({ delegatorId: 1, revokedAt: 1, until: -1 });
delegationSchema.index({ delegateId: 1, revokedAt: 1, until: -1 });

const DAY = 24 * 3600 * 1000;

/** Delegations in force at `now`: started, not past the end of the until day, not revoked. */
delegationSchema.statics.activeFilter = (now = new Date()) => ({ revokedAt: null, from: { $lte: now }, until: { $gt: new Date(now.getTime() - DAY) } });

module.exports = mongoose.model('Delegation', delegationSchema);

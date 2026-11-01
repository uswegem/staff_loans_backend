'use strict';

// A proposed date of birth waiting for, or decided by, People and Culture (D-82).
// Maker-checker on one field, following the product module's rules (D-05): one open
// change per staff member, the submitter never verifies it, a rejection has a reason,
// and every step is audited. Records only move from pending to a final state.

const mongoose = require('mongoose');

const { Schema } = mongoose;

const dobChangeSchema = new Schema(
  {
    staffId: { type: Schema.Types.ObjectId, ref: 'Staff', required: true },
    proposed: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    previous: { type: String, default: null }, // the verified value when the change was submitted
    source: { type: String, enum: ['profile', 'staff_record', 'legacy'], required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null: carried over from an unverified profile value
    submittedAt: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'withdrawn'], default: 'pending' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    reason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

dobChangeSchema.index({ status: 1, submittedAt: 1 });
dobChangeSchema.index({ staffId: 1, submittedAt: -1 });
// At most one pending change per staff member, even under concurrent submissions.
dobChangeSchema.index({ staffId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_staff' });

module.exports = mongoose.model('DobChange', dobChangeSchema);

'use strict';

// Versioned Swahili agreement templates (FR-40, D-88). The Legal Officer uploads or edits
// a version; it is "Pending Legal Approval" and cannot be used until the Head of Legal
// approves it (never the person who uploaded or edited it). The version in use is the
// newest approved one whose effective date has come; each loan keeps the version it
// accepted. Editing an approved version creates a new version.

const mongoose = require('mongoose');

const { Schema } = mongoose;
const STATES = ['pending_legal_approval', 'approved', 'rejected'];

const templateSchema = new Schema(
  {
    version: { type: String, required: true, unique: true, trim: true },
    status: { type: String, enum: STATES, default: 'pending_legal_approval' },
    body: { type: String, required: true },
    sample: { type: Boolean, default: false }, // prototype clauses, not yet the Legal text (DECISIONS Q6)
    effectiveFrom: Date,
    note: String,
    basedOnId: { type: Schema.Types.ObjectId, ref: 'AgreementTemplate' }, // the approved version this one edits
    loadedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // uploader
    editors: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] }, // everyone who uploaded or edited it
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    rejectionReason: String,
    // Before D-88: a tick that Legal had approved the text outside the system.
    legalApproved: Boolean,
    legalApprovalRef: String,
  },
  { timestamps: true }
);

templateSchema.statics.STATES = STATES;

/** The version agreements are generated from: approved, effective, newest. */
templateSchema.statics.active = function active(session, now = new Date()) {
  return this.findOne({ status: 'approved', $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] })
    .sort({ effectiveFrom: -1, approvedAt: -1, createdAt: -1 })
    .session(session || null);
};

module.exports = mongoose.model('AgreementTemplate', templateSchema);

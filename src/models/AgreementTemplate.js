'use strict';

// Versioned Swahili agreement templates (FR-40). Only an administrator loads a new
// version after Legal approval; each loan keeps the version it accepted. The current
// version is the newest one whose effective date has come (DECISIONS D-73).

const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema(
  {
    version: { type: String, required: true, unique: true, trim: true },
    status: { type: String, enum: ['active', 'retired'], default: 'active' },
    body: { type: String, required: true },
    legalApproved: { type: Boolean, required: true },
    legalApprovalRef: String,
    sample: { type: Boolean, default: false }, // prototype clauses, not yet the Legal text (DECISIONS Q6)
    effectiveFrom: Date,
    loadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: String,
  },
  { timestamps: true }
);

templateSchema.statics.active = function active(session, now = new Date()) {
  return this.findOne({ status: 'active', $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .session(session || null);
};

module.exports = mongoose.model('AgreementTemplate', templateSchema);

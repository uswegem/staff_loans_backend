'use strict';

// Versioned, Legal-approved notices shown before signing (D-108), in English and Swahili.
// The first is the data protection notice (key 'data_protection'). Like agreement
// templates (D-88), a version is used only once approved by the Head of Legal; a changed
// text is a new version. Each application keeps the version and language it accepted.

const mongoose = require('mongoose');

const { Schema } = mongoose;

const noticeSchema = new Schema(
  {
    key: { type: String, required: true, enum: ['data_protection'] },
    version: { type: String, required: true, trim: true }, // e.g. DP-2026-1
    language: { type: String, required: true, enum: ['en', 'sw'] },
    title: { type: String, required: true },
    body: { type: String, required: true },
    checkbox: { type: String, required: true }, // the statement ticked to accept
    status: { type: String, enum: ['pending_legal_approval', 'approved', 'rejected'], default: 'pending_legal_approval' },
    effectiveFrom: Date,
    loadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvalRef: String, // where Legal approved the text when it was loaded by script
  },
  { timestamps: true }
);

noticeSchema.index({ key: 1, version: 1, language: 1 }, { unique: true });

/** The approved, effective, newest version of a notice in a language, or null. */
noticeSchema.statics.current = function current(key, language, now = new Date()) {
  return this.findOne({ key, language, status: 'approved', $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] }).sort({ effectiveFrom: -1, approvedAt: -1, createdAt: -1 });
};

module.exports = mongoose.model('LegalNotice', noticeSchema);

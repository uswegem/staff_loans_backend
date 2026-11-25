'use strict';

// A signed Mkataba wa Mkopo wa Mwajiriwa (BRD 8, FR-33 to FR-41). The accepted text,
// its SHA-256 and the acceptance evidence are kept exactly as signed; only the status
// fields change later (in force at final approval, void on reject, withdraw, decline or
// replacement).

const mongoose = require('mongoose');

const { Schema } = mongoose;

const agreementSchema = new Schema(
  {
    number: { type: String, required: true, unique: true }, // MKT-YYYY-NNNNN
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
    kind: { type: String, enum: ['original', 'revised'], default: 'original' },
    templateId: { type: Schema.Types.ObjectId, ref: 'AgreementTemplate' },
    templateVersion: String,
    terms: {
      amount: Number,
      tenor: Number,
      instalment: Number,
      interestBps: Number,
      processingFee: Number,
      insuranceFee: Number,
      totalInterest: Number,
      totalRepayable: Number,
      firstDueDate: String,
      repaymentMethod: String,
    },
    schedule: { type: Array, default: [] },
    text: { type: String, required: true }, // the exact text accepted
    // The rendered blocks of that text (bold and highlighted values), for printing; not part of
    // the fingerprint. Absent on agreements signed before they were kept.
    blocks: { type: Array, default: undefined },
    textSha256: { type: String, required: true },
    pdfFileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    pdfSha256: String,
    // At final approval: the same text with the approvers who signed for the employer (FR-36).
    inForcePdfFileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    approvals: { type: [{ name: String, title: String, stage: String, at: Date, onBehalfOf: String, _id: false }], default: [] },
    acceptance: {
      userId: { type: Schema.Types.ObjectId, ref: 'User' },
      staffNo: String,
      fullName: String,
      at: Date,
      ip: String,
      userAgent: String,
    },
    // D-108: the data protection notice accepted with it, printed after the agreement.
    language: { type: String, enum: ['en', 'sw'] },
    // D-110: 2 = numbered agreement whose canonical text carries its structure; 1 (or none) = earlier text.
    format: { type: Number, default: 1 }, // D-109: the language signed in (older ones: the template's)
    dataProtection: { accepted: Boolean, version: String, language: String, title: String, body: String, checkbox: String, at: Date },
    status: { type: String, enum: ['signed', 'in_force', 'void'], default: 'signed' },
    effectiveAt: Date,
    voidAt: Date,
    voidReason: String,
    replacedById: { type: Schema.Types.ObjectId, ref: 'Agreement' },
    expiresAt: Date, // revised agreements only (FR-39)
  },
  { timestamps: true }
);

agreementSchema.index({ applicationId: 1, createdAt: -1 });

module.exports = mongoose.model('Agreement', agreementSchema);

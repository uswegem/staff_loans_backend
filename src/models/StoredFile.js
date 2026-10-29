'use strict';

// An uploaded or generated file (BRD NFR-07). Content lives under UPLOAD_DIR, outside
// any web root, under a random name; it is served only through authorised endpoints.

const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['document', 'crb_report', 'agreement_pdf'], required: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    label: { type: String, trim: true, maxlength: 160 },
    originalName: { type: String, required: true, maxlength: 200 },
    mime: { type: String, enum: ['application/pdf', 'image/jpeg', 'image/png'], required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    storageKey: { type: String, required: true },
    scan: { status: { type: String, enum: ['pending', 'clean', 'infected'], default: 'pending' }, at: Date, engine: String },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    removedAt: Date,
  },
  { timestamps: true }
);

fileSchema.index({ applicationId: 1 });

module.exports = mongoose.model('StoredFile', fileSchema);

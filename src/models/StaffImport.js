'use strict';

// One Excel or CSV upload of staff records (FR-02): the checked rows wait here as a
// preview until People and Culture confirm or discard them.

const mongoose = require('mongoose');

const rowSchema = new mongoose.Schema(
  {
    rowNo: Number,
    raw: mongoose.Schema.Types.Mixed, // the cells as uploaded, by template column key
    staffNo: String,
    name: String,
    outcome: { type: String, enum: ['new', 'update', 'unchanged', 'error'] },
    problems: { type: [String], default: [] },
    changes: { type: [String], default: [] },
  },
  { _id: false }
);

const staffImportSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['previewed', 'committed', 'discarded'], default: 'previewed' },
    rows: { type: [rowSchema], default: [] },
    summary: { new: Number, update: Number, unchanged: Number, error: Number },
    committedAt: Date,
    committedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    result: { created: Number, updated: Number, skipped: Number },
  },
  { timestamps: true }
);

staffImportSchema.index({ uploadedBy: 1, createdAt: -1 });

module.exports = mongoose.model('StaffImport', staffImportSchema);

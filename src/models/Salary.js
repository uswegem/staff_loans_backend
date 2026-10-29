'use strict';

// Effective-dated salary history (FR-03). Amounts are integer TZS.

const mongoose = require('mongoose');

const money = { type: Number, min: 0, validate: { validator: (v) => v == null || Number.isInteger(v), message: '{PATH} must be whole shillings' } };

const salarySchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true },
    basic: { ...money, required: true },
    allowances: { ...money, default: 0 },
    commission: { ...money, default: 0 },
    gross: money,
    net: money,
    effectiveFrom: { type: Date, required: true },
    source: { type: String, default: 'manual' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

salarySchema.index({ staffId: 1, effectiveFrom: -1 });

/** Salary in force at a date (FR-03: appraisals use the salary in force at submission). */
salarySchema.statics.inForce = function inForce(staffId, at = new Date(), session) {
  return this.findOne({ staffId, effectiveFrom: { $lte: at } }).sort({ effectiveFrom: -1 }).session(session || null);
};

module.exports = mongoose.model('Salary', salarySchema);

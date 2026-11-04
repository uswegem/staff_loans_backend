'use strict';

// One version of a product's parameters (FR-57). Applications keep the version they
// were submitted under (FR-61). Amounts are integer TZS.

const mongoose = require('mongoose');
const makerChecker = require('./plugins/makerChecker');

const { Schema } = mongoose;

const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select'];
const CATEGORIES = ['Management', 'Non-management'];
// Every staff loan is repaid by salary deduction (D-84): account debit was removed.
const REPAYMENT_METHODS = ['payroll'];

const fieldSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: FIELD_TYPES, required: true },
    options: { type: [String], default: [] },
    mandatory: { type: Boolean, default: false },
  },
  { _id: false }
);

const versionSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    minAmount: { type: Number, required: true },
    maxAmount: { type: Number, required: true },
    salaryMultiple: Number, // no longer used: the maximum amount comes from the reverse calculation (D-78)
    minTenor: { type: Number, required: true },
    maxTenor: { type: Number, required: true },
    minServiceMonths: { type: Number, required: true },
    maxConcurrent: { type: Number, required: true },
    topUpAllowed: { type: Boolean, default: false },
    // How this product's staff loan deduction is labelled on the payslip (D-101), for example
    // "Staff Loan - Car". Matched without regard to case, spacing or punctuation.
    payslipLabel: { type: String, trim: true, default: '' },
    contractStaffAllowed: { type: Boolean, default: false },
    eligibleCategories: { type: [{ type: String, enum: CATEGORIES }], default: CATEGORIES },
    repaymentMethods: { type: [{ type: String, enum: REPAYMENT_METHODS }], default: REPAYMENT_METHODS },
    fields: { type: [fieldSchema], default: [] },
    // Minimum number of months before applying for a top-up of this product (NS-02, D-84).
    reapplyCoolingMonths: { type: Number, default: 6 },
    agreementTemplateId: { type: Schema.Types.ObjectId, ref: 'AgreementTemplate', default: null }, // null = the active template
  },
  { timestamps: true }
);

versionSchema.plugin(makerChecker);
versionSchema.index({ productId: 1, version: 1 }, { unique: true });
versionSchema.index({ productId: 1, approvedAt: 1, liveFrom: -1 });

module.exports = mongoose.model('ProductVersion', versionSchema);
module.exports.FIELD_TYPES = FIELD_TYPES;
module.exports.CATEGORIES = CATEGORIES;
module.exports.REPAYMENT_METHODS = REPAYMENT_METHODS;

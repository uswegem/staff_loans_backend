'use strict';

// Global pricing, versioned and effective-dated, changed through the same
// maker-checker as products (prompt 4.4, DECISIONS D-06, D-08). Rates are integer
// basis points (6% = 600) so fees and interest never use floating-point percentages.

const mongoose = require('mongoose');
const makerChecker = require('./plugins/makerChecker');

const bandSchema = new mongoose.Schema(
  { from: { type: Number, required: true }, base: { type: Number, required: true }, rateBps: { type: Number, required: true } },
  { _id: false }
);

const pricingSchema = new mongoose.Schema(
  {
    interestBps: { type: Number, required: true }, // a year, reducing balance (BR-14)
    processingFeeBps: { type: Number, required: true }, // new loan (BR-15)
    processingFeeTopUpBps: { type: Number, required: true },
    insuranceBps: { type: Number, required: true }, // a year, pro-rata, one-off
    affordabilityBps: { type: Number, required: true }, // instalment limit, of adjusted net pay
    pensionBps: { type: Number, required: true }, // of basic salary
    instalmentRounding: { type: Number, required: true, default: 100 }, // round up to (TZS)
    payeBands: { type: [bandSchema], required: true },
  },
  { timestamps: true }
);

pricingSchema.plugin(makerChecker);
pricingSchema.index({ version: 1 }, { unique: true });

module.exports = mongoose.model('PricingVersion', pricingSchema);

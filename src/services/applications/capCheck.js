'use strict';

// Re-checks Room (D-87, D-101) at every approval and just before disbursement: another of
// the staff member's loans may have been approved or paid out in the meantime. The same
// calculation as the live calculator and submission, on the payslip attached to the
// application.

const Application = require('../../models/Application');
const PricingVersion = require('../../models/PricingVersion');
const ProductVersion = require('../../models/ProductVersion');
const calc = require('../calc/loanCalculator');
const rules = require('./rules');
const { productLabels } = require('../payslip/deductionLines');
const { localDay } = require('../../utils/dates');

const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;

/**
 * terms: { amount, tenor }. Returns { ok, combined, instalment } or { ok: false, message }.
 * Basic Pay and the staff loan deductions are read from the application's payslip.
 */
async function capCheck(app, terms, now = new Date()) {
  const [apps, pricing, version] = await Promise.all([
    Application.find({ applicantUserId: app.applicantUserId }).lean(),
    PricingVersion.findById(app.pricingVersionId).lean(),
    ProductVersion.findById(app.productVersionId).lean(),
  ]);
  const ded = rules.deductions({ apps, appId: app._id, today: localDay(now), products: await productLabels(version), productId: app.productId, payslip: app.payslip, topUp: app.topUp });
  const instalment = calc.instalment(terms.amount, terms.tenor, pricing.interestBps, pricing.instalmentRounding);
  const net = calc.payslip(rules.payInputs(app.payslip), pricing).net;
  const combined = calc.combinedCap(net, pricing.affordabilityBps, ded.inputs, instalment);
  if (instalment <= combined.available) return { ok: true, combined, instalment };
  return {
    ok: false,
    combined,
    instalment,
    code: 'AFFORDABILITY_EXCEEDED',
    message: `The instalment of ${tzs(instalment)} no longer fits Room: ${pricing.affordabilityBps / 100}% of Net Pay is ${tzs(combined.cap)}, less ${tzs(combined.payslipDeductions)} of staff loan deductions on the payslip and ${tzs(combined.slasNotOnPayslip)} of Staff Loans loans not yet on it, leaving ${tzs(combined.available)}.`,
  };
}

module.exports = { capCheck };

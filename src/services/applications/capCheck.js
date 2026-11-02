'use strict';

// Re-checks the combined 50% cap (D-87) at every approval and just before disbursement:
// another of the staff member's loans may have been approved in the meantime.

const Application = require('../../models/Application');
const PricingVersion = require('../../models/PricingVersion');
const calc = require('../calc/loanCalculator');
const rules = require('./rules');
const { localDay } = require('../../utils/dates');

const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;

/**
 * terms: { amount, tenor }. Returns { ok, combined, instalment } or { ok: false, message }.
 * The salary figure is the Basic Pay read from the application's payslip.
 */
async function capCheck(app, terms, now = new Date()) {
  const [apps, pricing] = await Promise.all([
    Application.find({ applicantUserId: app.applicantUserId }).lean(),
    PricingVersion.findById(app.pricingVersionId).lean(),
  ]);
  const existing = rules.existingLoans(apps, app._id, localDay(now), app.topUp);
  const instalment = calc.instalment(terms.amount, terms.tenor, pricing.interestBps, pricing.instalmentRounding);
  const net = calc.payslip({ basic: app.payslip?.basic || 0 }, pricing).net;
  const combined = calc.combinedCap(net, pricing.affordabilityBps, existing, instalment);
  if (instalment <= combined.available) return { ok: true, combined, instalment };
  return {
    ok: false,
    combined,
    instalment,
    code: 'AFFORDABILITY_EXCEEDED',
    message: `The instalment of ${tzs(instalment)} no longer fits the combined limit: ${pricing.affordabilityBps / 100}% of Net Pay is ${tzs(combined.cap)}, and the applicant's other loans in Staff Loans now take ${tzs(combined.others)}, leaving ${tzs(combined.available)}.`,
  };
}

module.exports = { capCheck };

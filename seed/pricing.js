'use strict';

// Launch pricing (BRD 10, BR-14, BR-15): interest, fees, insurance, the combined 50% cap
// (affordabilityBps, D-87), pension and the PAYE bands. Pricing is system configuration,
// not a loan product, so it is seeded once on an empty system; every later change goes
// through the two-stage approval (D-89). No seeder creates loan products (D-92).

const PricingVersion = require('../src/models/PricingVersion');
const { localMidnight } = require('../src/utils/dates');

const IN_FORCE = '2026-10-01';

const PRICING = {
  interestBps: 600,
  processingFeeBps: 100,
  processingFeeTopUpBps: 50,
  insuranceBps: 60,
  affordabilityBps: 5000,
  pensionBps: 1000,
  instalmentRounding: 100,
  payeBands: [
    { from: 0, base: 0, rateBps: 0 },
    { from: 270000, base: 0, rateBps: 800 },
    { from: 520000, base: 20000, rateBps: 2000 },
    { from: 760000, base: 68000, rateBps: 2500 },
    { from: 1000000, base: 128000, rateBps: 3000 },
  ],
};

/** Approval fields for a seeded version: prepared by maker, approved in both stages. */
function approvedMeta({ maker, creditApprover, riskApprover } = {}, note) {
  const at = localMidnight(IN_FORCE);
  return {
    version: 1,
    state: 'active',
    changeType: 'create',
    effectiveFrom: at,
    liveFrom: at,
    note,
    editors: maker ? [maker] : [],
    makerId: maker,
    submittedAt: at,
    submittedBy: maker,
    approvals: [
      { stage: 'credit', by: creditApprover, at },
      { stage: 'risk', by: riskApprover, at },
    ],
    checkerId: riskApprover,
    decidedAt: at,
    approvedAt: at,
  };
}

async function seedPricing(people = {}) {
  if (await PricingVersion.exists({})) return null;
  return PricingVersion.create({ ...PRICING, ...approvedMeta(people, 'Launch pricing (seed): BRD 10, BR-14, BR-15; 50% combined cap (D-87).') });
}

module.exports = { seedPricing, approvedMeta, PRICING, IN_FORCE };

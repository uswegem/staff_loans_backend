'use strict';

// Validation and comparison for global pricing versions (BR-14, BR-15, BRD 10).

const PRICING_FIELDS = [
  ['interestBps', 'Interest a year (basis points)'],
  ['processingFeeBps', 'Processing fee, new loan (basis points)'],
  ['processingFeeTopUpBps', 'Processing fee, top-up (basis points)'],
  ['insuranceBps', 'Insurance a year (basis points)'],
  ['affordabilityBps', 'Instalment limit, of adjusted net pay (basis points)'],
  ['pensionBps', 'Pension, of basic salary (basis points)'],
  ['instalmentRounding', 'Instalment rounded up to (TZS)'],
  ['payeBands', 'PAYE bands'],
];

const add = (errors, field, msg) => {
  (errors[field] = errors[field] || []).push(msg);
};

function validatePricing(v) {
  const errors = {};
  const bps = (f, label, { min = 0, max = 10000 } = {}) => {
    if (!Number.isInteger(v[f]) || v[f] < min || v[f] > max) add(errors, f, `${label} must be between ${min / 100}% and ${max / 100}%, in steps of 0.01%.`);
  };
  bps('interestBps', 'Interest', { max: 5000 });
  bps('processingFeeBps', 'Processing fee', { max: 1000 });
  bps('processingFeeTopUpBps', 'Top-up processing fee', { max: 1000 });
  bps('insuranceBps', 'Insurance', { max: 1000 });
  bps('affordabilityBps', 'Instalment limit', { min: 1, max: 10000 });
  bps('pensionBps', 'Pension', { max: 5000 });
  if (![1, 10, 100, 1000].includes(v.instalmentRounding)) add(errors, 'instalmentRounding', 'Round to 1, 10, 100 or 1,000 shillings.');

  const bands = v.payeBands || [];
  if (!bands.length || bands[0].from !== 0) add(errors, 'payeBands', 'The first PAYE band must start at TZS 0.');
  bands.forEach((b, i) => {
    if (!Number.isInteger(b.from) || b.from < 0 || !Number.isInteger(b.base) || b.base < 0) add(errors, `payeBands.${i}`, 'Band amounts must be whole shillings, 0 or more.');
    if (!Number.isInteger(b.rateBps) || b.rateBps < 0 || b.rateBps > 10000) add(errors, `payeBands.${i}`, 'Band rates must be between 0% and 100%.');
    if (i > 0 && b.from <= bands[i - 1].from) add(errors, `payeBands.${i}`, 'Bands must go up in order of taxable pay.');
  });
  return errors;
}

module.exports = { PRICING_FIELDS, validatePricing };

'use strict';

// Retirement cutoff (D-82), from the HR-verified date of birth only: the last instalment
// of a loan must fall on or before date of birth + retirementAge years − retirementBufferDays
// days. Used by the application rules and by the eligibility view on Home.

const calc = require('../calc/loanCalculator');

/** The cutoff day, or null without a verified date of birth. */
function cutoffFor(staff, settings) {
  const dob = staff.dateOfBirth?.value;
  return dob ? calc.retirementCutoff(dob, settings.retirementAge ?? 60, settings.retirementBufferDays ?? 60) : null;
}

/** "60 days before you turn 60", from the settings. */
const cutoffRule = (settings) => `${settings.retirementBufferDays ?? 60} days before you turn ${settings.retirementAge ?? 60}`;

/**
 * Can this person take this product at all? A verified date of birth, and room before
 * the cutoff for at least the product's minimum tenor. Returns the message, or null.
 */
function cutoffProblem(staff, version, settings, today) {
  const d = staff.dateOfBirth || {};
  if (!d.value) {
    return d.pending?.changeId
      ? `Your date of birth (${d.pending.proposed}) is waiting for People and Culture to verify it. You can apply once it is verified.`
      : 'Add your date of birth in your profile (Personal details) and wait for People and Culture to verify it. You can apply once it is verified.';
  }
  const cutoff = cutoffFor(staff, settings);
  const fits = calc.instalmentsBefore(cutoff, calc.firstDueDate(today, settings.firstDueDay || 25));
  if (fits < 1) return `You cannot take a new loan: it must be repaid by ${cutoff} (${cutoffRule(settings)}), and no monthly instalment falls on or before that date.`;
  if (fits < version.minTenor) return `${version.name} needs at least ${version.minTenor} months, but only ${fits} monthly ${fits === 1 ? 'instalment falls' : 'instalments fall'} on or before ${cutoff} (${cutoffRule(settings)}).`;
  return null;
}

module.exports = { cutoffFor, cutoffRule, cutoffProblem };

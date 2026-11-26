'use strict';

// The four approval routes (BRD 7, 7.2.1, decisions 30 and 31). The route comes from
// the applicant's permissions first, then the employee category on the staff record
// (DECISIONS D-03). Every route ends with OPS disbursement.
//
// A stage accepts one or more permissions: whoever holds any of them may act, and the first
// to decide moves the application on (D-103). The People and Culture stage ("pc") is for the
// People and Culture Manager or the Head of People and Culture, on every route but the CEO's,
// whose final approval stays with the Head of People and Culture ("hr"). "pcm" and "hr" on
// the other routes remain only for applications submitted before D-103, which keep the
// route they were submitted on.

const STAGES = Object.freeze({
  // D-113: Credit Underwriting (Credit Analyst, Credit Manager, Head of Credit).
  credit: { key: 'credit', label: 'Credit Underwriting', permissions: ['review.credit'], status: 'pending_credit', target: 'stage' },
  pcm: { key: 'pcm', label: 'People and Culture Manager', permissions: ['review.pcm'], status: 'pending_pcm', target: 'stage' },
  hr: { key: 'hr', label: 'Head of People and Culture', short: 'Head of HR', permissions: ['review.hr'], status: 'pending_hr', target: 'stage' },
  pc: { key: 'pc', label: 'People and Culture', permissions: ['review.hr', 'review.pcm'], status: 'pending_pc', target: 'stage' },
  ceo: { key: 'ceo', label: 'CEO', permissions: ['review.ceo'], status: 'pending_ceo', target: 'ceo' },
});

/** The stages where People and Culture confirm the staff record (employment, category, pay). */
const PC_STAGES = Object.freeze(['pc', 'hr', 'pcm']);

/** Who acts with each review permission, for labels ("People and Culture (P&C Manager)"). */
const PERMISSION_ROLE = Object.freeze({ 'review.credit': 'Credit Underwriting', 'review.pcm': 'P&C Manager', 'review.hr': 'Head of P&C', 'review.ceo': 'CEO' });

const ROUTES = Object.freeze({
  nonmgmt: { key: 'nonmgmt', label: 'Non-management staff', stages: ['credit', 'pc', 'ceo'], limitedCredit: false },
  mgmt: { key: 'mgmt', label: 'Management staff', stages: ['credit', 'pc', 'ceo'], limitedCredit: true },
  ceo: { key: 'ceo', label: 'CEO', stages: ['credit', 'hr'], limitedCredit: true },
  hrhead: { key: 'hrhead', label: 'Head of People and Culture', stages: ['credit', 'pc', 'ceo'], limitedCredit: true },
});

/** True when someone with these permissions may act at the stage. */
const stageAccepts = (stage, perms) => STAGES[stage].permissions.some((p) => (perms instanceof Set ? perms.has(p) : perms.includes(p)));

/** permissions: Set or array of the applicant's permissions; staff: the staff record. */
function routeFor(permissions, staff) {
  const has = (p) => (permissions instanceof Set ? permissions.has(p) : permissions.includes(p));
  if (has('review.ceo')) return ROUTES.ceo;
  if (has('review.hr')) return ROUTES.hrhead;
  return staff.category === 'Management' ? ROUTES.mgmt : ROUTES.nonmgmt;
}

// D-112: after the last approval the loan goes to Disbursement (People and Culture book, OPS disburse).
const describeRoute = (route) => `${route.stages.map((s) => STAGES[s].short || STAGES[s].label).join(', then ')}, then Disbursement (People and Culture book, OPS disburse)`;

module.exports = { STAGES, ROUTES, PC_STAGES, PERMISSION_ROLE, routeFor, describeRoute, stageAccepts };

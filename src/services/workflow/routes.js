'use strict';

// The four approval routes (BRD 7, 7.2.1, decisions 30 and 31). The route comes from
// the applicant's permissions first, then the employee category on the staff record
// (DECISIONS D-03). Every route ends with OPS disbursement.

const STAGES = Object.freeze({
  credit: { key: 'credit', label: 'Credit Analyst', permission: 'review.credit', status: 'pending_credit', target: 'stage' },
  pcm: { key: 'pcm', label: 'People and Culture Manager', short: 'P&C Manager', permission: 'review.pcm', status: 'pending_pcm', target: 'stage' },
  hr: { key: 'hr', label: 'Head of People and Culture', short: 'Head of HR', permission: 'review.hr', status: 'pending_hr', target: 'stage' },
  ceo: { key: 'ceo', label: 'CEO', permission: 'review.ceo', status: 'pending_ceo', target: 'ceo' },
});

const ROUTES = Object.freeze({
  nonmgmt: { key: 'nonmgmt', label: 'Non-management staff', stages: ['credit', 'hr', 'ceo'], limitedCredit: false },
  mgmt: { key: 'mgmt', label: 'Management staff', stages: ['credit', 'hr', 'ceo'], limitedCredit: true },
  ceo: { key: 'ceo', label: 'CEO', stages: ['credit', 'hr'], limitedCredit: true },
  hrhead: { key: 'hrhead', label: 'Head of People and Culture', stages: ['credit', 'pcm', 'ceo'], limitedCredit: true },
});

/** permissions: Set or array of the applicant's permissions; staff: the staff record. */
function routeFor(permissions, staff) {
  const has = (p) => (permissions instanceof Set ? permissions.has(p) : permissions.includes(p));
  if (has('review.ceo')) return ROUTES.ceo;
  if (has('review.hr')) return ROUTES.hrhead;
  return staff.category === 'Management' ? ROUTES.mgmt : ROUTES.nonmgmt;
}

const describeRoute = (route) => `${route.stages.map((s) => STAGES[s].short || STAGES[s].label).join(', then ')}, then OPS disburses`;

module.exports = { STAGES, ROUTES, routeFor, describeRoute };

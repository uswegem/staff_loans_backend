'use strict';

/**
 * Permission catalogue (BRD 9.5, FR-44). Every protected action and screen is a
 * named permission. Code checks permissions, never role names.
 *
 * kind drives segregation of duties (FR-48) and MFA (FR-49):
 *   approve  – review stages
 *   disburse – OPS confirmation
 *   admin    – configuration and access management
 *   check    – product / pricing checker (FR-60, DECISIONS D-05)
 */
const PERMISSIONS = Object.freeze([
  { id: 'loan.apply', group: 'My loans', label: 'Apply for staff loans', locked: true },
  { id: 'loan.viewOwn', group: 'My loans', label: 'View own applications and agreements', locked: true },
  { id: 'review.credit', group: 'Reviews', label: 'Review at Credit Analyst stage', kind: 'approve' },
  { id: 'review.pcm', group: 'Reviews', label: 'Review at People and Culture Manager stage (Head of P&C applications)', kind: 'approve' },
  { id: 'review.hr', group: 'Reviews', label: 'Review at Head of People and Culture stage', kind: 'approve' },
  { id: 'review.ceo', group: 'Reviews', label: 'Give final approval (CEO stage)', kind: 'approve' },
  { id: 'review.delegate', group: 'Reviews', label: 'Delegate own reviews during absence' },
  { id: 'loan.viewAll', group: 'Reviews', label: 'View every application and its approvals, read-only (Auditor)' },
  { id: 'disb.confirm', group: 'Operations', label: 'Confirm disbursements', kind: 'disburse' },
  { id: 'staff.view', group: 'Staff records', label: 'View staff records' },
  { id: 'staff.manage', group: 'Staff records', label: 'Maintain staff records and salaries' },
  { id: 'staff.verifyDob', group: 'Staff records', label: 'Verify staff dates of birth (not their own submissions)' },
  { id: 'reports.view', group: 'Reports', label: 'View reports' },
  { id: 'reports.export', group: 'Reports', label: 'Export reports' },
  { id: 'products.view', group: 'Administration', label: 'View products, pricing and pending changes' },
  { id: 'products.make', group: 'Administration', label: 'Prepare product and pricing changes (maker)', kind: 'admin' },
  { id: 'products.approveCredit', group: 'Administration', label: 'Approve product and pricing changes, first stage (Head of Credit)', kind: 'check' },
  { id: 'products.approveRisk', group: 'Administration', label: 'Approve and publish product and pricing changes, second stage (Head of Risk and Compliance)', kind: 'check' },
  { id: 'admin.workflow', group: 'Administration', label: 'Manage workflow settings and calendar', kind: 'admin' },
  { id: 'admin.users', group: 'Administration', label: 'Assign roles to users', kind: 'admin' },
  { id: 'admin.roles', group: 'Administration', label: 'Manage roles and permissions', kind: 'admin' },
  { id: 'admin.templates', group: 'Administration', label: 'Upload and edit agreement templates (Legal Officer)', kind: 'admin' },
  { id: 'templates.approve', group: 'Administration', label: 'Approve or reject agreement templates (Head of Legal)', kind: 'check' },
  { id: 'audit.view', group: 'Administration', label: 'View and export the audit log' },
]);

const PERMISSION_IDS = Object.freeze(PERMISSIONS.map((p) => p.id));
const permById = (id) => PERMISSIONS.find((p) => p.id === id);

/** Permissions the Staff role always keeps (FR-46). */
const LOCKED_PERMISSIONS = Object.freeze(PERMISSIONS.filter((p) => p.locked).map((p) => p.id));

/** FR-49: MFA for disbursement, administration and checker permissions; review-only actions are exempt. */
const MFA_KINDS = Object.freeze(['disburse', 'admin', 'check']);

const REVIEW_PERMISSIONS = Object.freeze(['review.credit', 'review.pcm', 'review.hr', 'review.ceo']);

/**
 * Segregation-of-duties rules (FR-48, FR-60). A rule is breached when a permission
 * set contains a kind from `a` and a kind from `b`, or every permission in `all`.
 */
const SOD_RULES = Object.freeze([
  {
    id: 'sod1',
    name: 'Administration is kept apart from approving and disbursing',
    why: 'Someone who can change rules or access must not also approve or release money.',
    a: ['admin', 'check'],
    b: ['approve', 'disburse'],
  },
  {
    id: 'sod2',
    name: 'Approving is kept apart from confirming disbursement',
    why: 'The person who approves a loan must not also confirm that it was paid out.',
    a: ['approve'],
    b: ['disburse'],
  },
  {
    id: 'sod3',
    name: 'The two product approvals are held by different people',
    why: 'No product goes live, changes or is withdrawn without two separate approvals (BRD 5.1, D-89). A maker never approves their own version either.',
    all: ['products.approveCredit', 'products.approveRisk'],
  },
]);

function kindsOf(permissions) {
  const kinds = new Set();
  for (const p of permissions) {
    const def = permById(p);
    if (def && def.kind) kinds.add(def.kind);
  }
  return kinds;
}

/** Returns the SoD rules breached by a set of permissions. */
function sodConflicts(permissions) {
  const set = new Set(permissions);
  const kinds = kindsOf(set);
  return SOD_RULES.filter((r) => {
    if (r.all) return r.all.every((p) => set.has(p));
    return r.a.some((k) => kinds.has(k)) && r.b.some((k) => kinds.has(k));
  });
}

function requiresMfa(permissions) {
  const kinds = kindsOf(permissions);
  return MFA_KINDS.some((k) => kinds.has(k));
}

module.exports = {
  PERMISSIONS,
  PERMISSION_IDS,
  LOCKED_PERMISSIONS,
  REVIEW_PERMISSIONS,
  MFA_KINDS,
  SOD_RULES,
  permById,
  sodConflicts,
  requiresMfa,
};

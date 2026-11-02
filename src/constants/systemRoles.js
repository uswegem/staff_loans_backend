'use strict';

// Default roles (FR-43, BRD 4 access table). System roles can be edited but not deleted.
// Product approval has two stages (D-89): Head of Credit, then Head of Risk and
// Compliance. Agreement templates: Legal Officer uploads, Head of Legal approves (D-88).
// The Auditor reads applications, approvals and the audit trail (D-90).

const DEFAULT_ROLES = Object.freeze([
  { code: 'staff', name: 'Staff', system: true, description: 'Every active staff member.', permissions: ['loan.apply', 'loan.viewOwn'] },
  {
    code: 'credit_analyst',
    name: 'Credit Analyst',
    system: true,
    description: 'Credit bureau check on every application; sees the applicant\'s name, NIDA and mobile only (D-86).',
    permissions: ['review.credit', 'review.delegate', 'reports.view', 'reports.export'],
  },
  {
    code: 'pc_manager',
    name: 'People and Culture Manager',
    system: true,
    description: "Reviews the Head of People and Culture's own applications, before the CEO.",
    permissions: ['review.pcm', 'review.delegate', 'staff.view', 'staff.verifyDob', 'reports.view', 'reports.export'],
  },
  {
    code: 'head_pc',
    name: 'Head of People and Culture',
    system: true,
    description: 'HR review for all staff; maintains staff records.',
    permissions: ['review.hr', 'review.delegate', 'staff.view', 'staff.manage', 'staff.verifyDob', 'reports.view', 'reports.export'],
  },
  { code: 'ceo', name: 'CEO', system: true, description: 'Final approval.', permissions: ['review.ceo', 'review.delegate', 'reports.view', 'reports.export'] },
  { code: 'ops', name: 'OPS', system: true, description: 'Confirms disbursement of finally approved loans.', permissions: ['disb.confirm', 'reports.view', 'reports.export'] },
  {
    code: 'sys_admin',
    name: 'System Administrator',
    system: true,
    description: 'Configures the system and prepares product changes. Cannot approve or disburse.',
    permissions: ['products.view', 'products.make', 'admin.workflow', 'admin.users', 'admin.roles', 'audit.view', 'reports.view'],
  },
  {
    code: 'head_credit',
    name: 'Head of Credit',
    system: true,
    description: 'Prepares products and pricing, and gives the first approval of changes others prepare (D-89).',
    permissions: ['products.view', 'products.make', 'products.approveCredit', 'reports.view', 'reports.export'],
  },
  {
    code: 'head_risk',
    name: 'Head of Risk and Compliance',
    system: true,
    description: 'Gives the second approval of product and pricing changes, which publishes them (D-89).',
    permissions: ['products.view', 'products.approveRisk', 'reports.view', 'reports.export'],
  },
  {
    code: 'legal_officer',
    name: 'Legal Officer',
    system: true,
    description: 'Uploads and edits agreement templates; they wait for the Head of Legal (D-88).',
    permissions: ['admin.templates'],
  },
  {
    code: 'head_legal',
    name: 'Head of Legal',
    system: true,
    description: 'Approves or rejects agreement templates (D-88).',
    permissions: ['templates.approve'],
  },
  {
    code: 'auditor',
    name: 'Auditor',
    system: true,
    description: 'Read-only: every application and its approvals, reports and the audit trail (D-90).',
    permissions: ['loan.viewAll', 'reports.view', 'reports.export', 'audit.view'],
  },
  {
    code: 'risk_audit_viewer',
    name: 'Risk and Audit Viewer',
    system: false,
    description: 'Read-only reports and audit log for Risk and Internal Audit.',
    permissions: ['reports.view', 'reports.export', 'audit.view'],
  },
]);

module.exports = { DEFAULT_ROLES };

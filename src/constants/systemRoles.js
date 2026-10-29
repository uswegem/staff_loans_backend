'use strict';

// Default roles (FR-43, BRD 4 access table, prototype defaultRoles()). The seven
// system roles can be edited but not deleted. Two custom roles are seeded:
// Product Checker (DECISIONS D-05, Q4) and Risk and Audit Viewer (prototype).

const DEFAULT_ROLES = Object.freeze([
  { code: 'staff', name: 'Staff', system: true, description: 'Every active staff member.', permissions: ['loan.apply', 'loan.viewOwn'] },
  {
    code: 'credit_analyst',
    name: 'Credit Analyst',
    system: true,
    description: 'First review on every route; limited details on management routes.',
    permissions: ['review.credit', 'review.delegate', 'reports.view', 'reports.export'],
  },
  {
    code: 'pc_manager',
    name: 'People and Culture Manager',
    system: true,
    description: "Reviews the Head of People and Culture's own applications, before the CEO.",
    permissions: ['review.pcm', 'review.delegate', 'staff.view', 'reports.view', 'reports.export'],
  },
  {
    code: 'head_pc',
    name: 'Head of People and Culture',
    system: true,
    description: 'HR review for all staff; maintains staff records.',
    permissions: ['review.hr', 'review.delegate', 'staff.view', 'staff.manage', 'reports.view', 'reports.export'],
  },
  { code: 'ceo', name: 'CEO', system: true, description: 'Final approval.', permissions: ['review.ceo', 'review.delegate', 'reports.view', 'reports.export'] },
  { code: 'ops', name: 'OPS', system: true, description: 'Confirms disbursement of finally approved loans.', permissions: ['disb.confirm', 'reports.view', 'reports.export'] },
  {
    code: 'sys_admin',
    name: 'System Administrator',
    system: true,
    description: 'Configures the system and prepares product changes. Cannot approve or disburse.',
    permissions: ['products.view', 'products.make', 'admin.workflow', 'admin.users', 'admin.roles', 'admin.templates', 'audit.view', 'reports.view'],
  },
  {
    code: 'product_checker',
    name: 'Product Checker',
    system: false,
    description: 'Approves or rejects product and pricing changes prepared by the maker (BRD 5.1).',
    permissions: ['products.view', 'products.check', 'reports.view'],
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

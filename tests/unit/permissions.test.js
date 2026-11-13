'use strict';

const { sodConflicts, requiresMfa, PERMISSIONS } = require('../../src/constants/permissions');
const { DEFAULT_ROLES } = require('../../src/constants/systemRoles');

const ids = (rules) => rules.map((r) => r.id).sort();

describe('segregation of duties (FR-48, FR-60)', () => {
  it('administration cannot be combined with approving', () => {
    expect(ids(sodConflicts(['admin.users', 'review.credit']))).toEqual(['sod1']);
  });

  it('administration cannot be combined with disbursing', () => {
    expect(ids(sodConflicts(['products.make', 'disb.confirm']))).toEqual(['sod1']);
  });

  it('approving cannot be combined with confirming disbursement', () => {
    expect(ids(sodConflicts(['review.ceo', 'disb.confirm']))).toEqual(['sod2']);
  });

  it('product maker and checker cannot be the same user', () => {
    expect(ids(sodConflicts(['products.approveCredit', 'products.approveRisk']))).toEqual(['sod3']);
    // The Head of Credit may prepare and give the first approval; never of their own version (D-89).
    expect(ids(sodConflicts(['products.make', 'products.approveCredit']))).toEqual([]);
  });

  it('checker cannot approve loans', () => {
    expect(ids(sodConflicts(['products.approveRisk', 'review.hr']))).toEqual(['sod1']);
  });

  it('reports and staff permissions do not conflict with approving', () => {
    expect(sodConflicts(['review.hr', 'staff.manage', 'reports.export', 'audit.view'])).toEqual([]);
  });

  it('every default role is conflict-free on its own', () => {
    DEFAULT_ROLES.forEach((r) => expect([r.code, sodConflicts(r.permissions)]).toEqual([r.code, []]));
  });

  it('every default role uses catalogue permissions only', () => {
    const known = new Set(PERMISSIONS.map((p) => p.id));
    DEFAULT_ROLES.forEach((r) => r.permissions.forEach((p) => expect(known.has(p)).toBe(true)));
  });
});

describe('MFA requirement (FR-49)', () => {
  it.each([
    [['loan.apply', 'loan.viewOwn'], false],
    [['loan.apply', 'reports.view', 'audit.view'], false],
    [['review.credit'], false],
    [['disb.confirm'], true],
    [['admin.users'], true],
    [['products.approveCredit'], true],
    [['templates.approve'], true],
  ])('%j → %s', (perms, expected) => {
    expect(requiresMfa(perms)).toBe(expected);
  });
});

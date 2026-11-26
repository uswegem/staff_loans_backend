'use strict';

// D-113: the credit stage is "Credit Underwriting". The Credit Analyst, the Credit Manager
// and the Head of Credit each see its queue and decide there, with the identity-only view.
// sod1 lets the Head of Credit hold product making and first approval with review.credit,
// and nothing wider. scripts/upgrade-2026-12c.js updates existing databases.

const { api, seedAll, applyAndSign, decide, signIn, CRB } = require('../flows');
const Application = require('../../src/models/Application');
const AuditLog = require('../../src/models/AuditLog');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');
const User = require('../../src/models/User');
const { DEFAULT_ROLES } = require('../../src/constants/systemRoles');
const { sodConflicts } = require('../../src/constants/permissions');
const { STATUS } = require('../../src/constants/statuses');
const { STAGES, describeRoute, ROUTES } = require('../../src/services/workflow/routes');
const { run } = require('../../scripts/upgrade-2026-12c');

jest.setTimeout(180000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const userId = async (staffNo) => (await User.findOne({ staffNo }))._id;
const perms = (code) => DEFAULT_ROLES.find((r) => r.code === code).permissions;

/** Salma (plain staff in the seed) as Credit Manager. */
async function creditManager() {
  const role = await Role.findOne({ code: 'credit_manager' });
  await RoleAssignment.create({ userId: await userId('LFB0377'), roleId: role._id });
  return signIn('LFB0377');
}

describe('Credit Underwriting (D-113)', () => {
  it('the stage, its status and the three roles', () => {
    expect(STAGES.credit.label).toBe('Credit Underwriting');
    expect(STATUS.pending_credit).toBe('Pending Credit Underwriting');
    expect(describeRoute(ROUTES.nonmgmt)).toMatch(/^Credit Underwriting, then /);
    for (const code of ['credit_analyst', 'credit_manager', 'head_credit']) expect(perms(code)).toContain('review.credit');
    expect(perms('credit_manager')).toEqual(perms('credit_analyst'));
    expect(perms('head_credit')).toEqual(expect.arrayContaining(['products.make', 'products.approveCredit', 'review.delegate']));
  });

  it('sod1 lets only the Head of Credit pair through', () => {
    expect(sodConflicts(perms('head_credit'))).toEqual([]);
    const ids = (p) => sodConflicts(p).map((r) => r.id);
    expect(ids(['products.make', 'review.ceo'])).toContain('sod1'); // another approval
    expect(ids(['products.approveRisk', 'review.credit'])).toContain('sod1'); // the second product approval
    expect(ids(['admin.users', 'review.credit'])).toContain('sod1'); // access administration
    expect(ids([...perms('head_credit'), 'admin.workflow'])).toContain('sod1');
    expect(ids([...perms('head_credit'), 'review.hr'])).toContain('sod1');
  });

  it('the Head of Credit sees the queue with the limited view and decides at Credit Underwriting', async () => {
    const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
    const asha = await signIn('LFB0010');
    const queue = (await api(asha.token).get('/queue')).body.data;
    expect(queue.items.map((i) => i.id)).toContain(id);
    const view = (await api(asha.token).get(`/review/${id}`)).body.data;
    expect(view).toMatchObject({ limited: true });
    expect(view.payslip ?? null).toBeNull();
    const res = await decide(asha, id, { action: 'approve', crb: CRB });
    expect(res.status).toBe(200);
    expect((await Application.findById(id)).status).toBe('pending_pc');
  });

  it('the Credit Manager decides like the Credit Analyst', async () => {
    const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
    const salma = await creditManager();
    expect(salma.body.data.permissions).toContain('review.credit');
    expect((await api(salma.token).get('/queue')).body.data.items.map((i) => i.id)).toContain(id);
    expect((await api(salma.token).get(`/review/${id}`)).body.data.limited).toBe(true);
    expect((await decide(salma, id, { action: 'approve', crb: CRB })).status).toBe(200);
    expect((await Application.findById(id)).status).toBe('pending_pc');
  });

  it('upgrade-2026-12c: dry run lists; --apply adds the permissions and the role, audited; a second run changes nothing', async () => {
    await Role.collection.updateOne({ code: 'head_credit' }, { $pull: { permissions: { $in: ['review.credit', 'review.delegate'] } } });
    await Role.collection.deleteOne({ code: 'credit_manager' });

    const dry = await run();
    expect(dry).toMatchObject({ apply: false, headCreditAdded: ['review.credit', 'review.delegate'], created: ['credit_manager'] });
    expect(await Role.collection.findOne({ code: 'credit_manager' })).toBeNull();

    await run({ apply: true });
    expect((await Role.collection.findOne({ code: 'head_credit' })).permissions).toEqual(expect.arrayContaining(['review.credit', 'review.delegate']));
    expect(await Role.findOne({ code: 'credit_manager' })).toMatchObject({ name: 'Credit Manager', system: true, permissions: perms('credit_manager') });
    expect(await AuditLog.countDocuments({ action: { $in: ['role.update', 'role.create'] }, description: /D-113/ })).toBe(2);

    expect(await run({ apply: true })).toMatchObject({ headCreditAdded: [], created: [] });
    expect(await AuditLog.countDocuments({ description: /D-113/ })).toBe(2);
  });
});

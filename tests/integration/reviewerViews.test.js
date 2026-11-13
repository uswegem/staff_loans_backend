'use strict';

// D-102: what each reviewer sees of a loan application.
// - Credit Analyst: identity, product, requested amount, tenor, purpose, instalment and
//   affordability (Room); never the payslip, pay or deduction lines.
// - Auditor (loan.viewAll, read-only): the application without the payslip and salary details.
// - Head of People and Culture and CEO: everything, as before.

const { signIn, request, app, authed } = require('../helpers');
const { api, seedAll, applyAndSign, decide, CRB, HR_OK } = require('../flows');
const Role = require('../../src/models/Role');
const User = require('../../src/models/User');
const RoleAssignment = require('../../src/models/RoleAssignment');
const Application = require('../../src/models/Application');

let products;
const NEEMA = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };

beforeEach(async () => {
  ({ products } = await seedAll());
});

/** Every key anywhere in a JSON body. */
function keysOf(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, keys));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      if (k === 'salaryMask') return; // Mask labels are intentionally present, not raw salary fields.
      keys.add(k);
      keysOf(v, keys);
    });
  }
  return keys;
}
const PAY_KEYS = ['basic', 'net', 'pension', 'tax', 'taxable', 'lfbDeductions', 'lfbLines', 'payslipDeductions', 'cap'];

async function makeAuditor(staffNo) {
  const user = await User.findOne({ staffNo });
  const role = await Role.findOne({ code: 'auditor' });
  await RoleAssignment.create({ userId: user._id, roleId: role._id, assignedBy: user._id });
}

describe('Credit Analyst', () => {
  it('sees the product, requested terms, instalment and Room in the review screen', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, NEEMA);
    const stored = await Application.findById(id).lean();

    const juma = await signIn('LFB0233');
    const view = (await api(juma.token).get(`/review/${id}`)).body.data;
    expect(view).toMatchObject({
      limited: true,
      product: { name: 'Personal Loan' },
      amount: NEEMA.amount,
      tenor: NEEMA.tenor,
      purpose: NEEMA.purpose,
      applicant: { firstName: 'Neema', lastName: 'Mushi' },
    });
    expect(view.affordability).toEqual({
      instalment: stored.calcSnapshot.instalment,
      room: stored.calcSnapshot.combined.available,
      remaining: stored.calcSnapshot.combined.remaining,
      fits: stored.calcSnapshot.combined.remaining >= 0,
      maxAmount: stored.calcSnapshot.maxAmount,
      maxTenor: stored.calcSnapshot.maxTenor,
    });
  });

  it('never gets the payslip, Basic or Net Pay, or deduction lines', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, NEEMA);
    const juma = await signIn('LFB0233');
    const keys = keysOf((await api(juma.token).get(`/review/${id}`)).body);
    expect((await api(juma.token).get(`/review/${id}`)).body.data.salaryMask).toEqual({ basic: '********', gross: '********', net: '********', deductions: '********' });
    for (const k of [...PAY_KEYS, 'payslip', 'calcAtSubmission', 'deductions', 'staffNo', 'title', 'department', 'nextOfKin', 'history', 'agreements']) expect([k, keys.has(k)]).toEqual([k, false]);
    const stored = await Application.findById(id).lean();
    const slip = await request(app()).get(`/api/v1/files/${stored.payslip.fileId}`).set(authed(juma.token));
    expect(slip.status).toBe(404);
  });

  it('sees the product and requested terms in the queue', async () => {
    const neema = await signIn('LFB0412');
    await applyAndSign(neema, products.PL._id, NEEMA);
    const juma = await signIn('LFB0233');
    const row = (await api(juma.token).get('/queue')).body.data.items[0];
    expect(row).toMatchObject({ limited: true, product: 'Personal Loan', amount: NEEMA.amount, tenor: NEEMA.tenor });
    expect(row.route).toBeUndefined();
  });
});

describe('Auditor (read-only)', () => {
  it('sees the application and affordability summary, without payslip or salary details', async () => {
    await makeAuditor('LFB0377');
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, NEEMA);
    const auditor = await signIn('LFB0377');
    const view = (await api(auditor.token).get(`/review/${id}`)).body.data;
    expect(view).toMatchObject({ limited: false, payHidden: true, amount: NEEMA.amount, payslip: null, calcAtSubmission: null, deductions: null });
    expect(view.affordability.room).toEqual(expect.any(Number));
    expect(view.applicant.existingLfbLoans).toEqual([]);
    expect(view.salaryMask).toEqual({ basic: '********', gross: '********', net: '********', deductions: '********' });
    expect(view.panel).toBeNull(); // read-only
    const keys = keysOf(view);
    PAY_KEYS.forEach((k) => expect([k, keys.has(k)]).toEqual([k, false]));
  });

  it('cannot download the payslip, but can open other documents of the application', async () => {
    await makeAuditor('LFB0377');
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, NEEMA);
    const stored = await Application.findById(id).lean();
    const auditor = await signIn('LFB0377');
    expect((await request(app()).get(`/api/v1/files/${stored.payslip.fileId}`).set(authed(auditor.token))).status).toBe(404);
    const view = (await api(auditor.token).get(`/review/${id}`)).body.data;
    for (const d of view.documents) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app()).get(`/api/v1/files/${d.id}`).set(authed(auditor.token))).status).toBe(200);
    }
  });
});

describe('Head of People and Culture and CEO', () => {
  it('still see the payslip and the full calculation', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, NEEMA);
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    const grace = await signIn('LFB0051');
    const view = (await api(grace.token).get(`/review/${id}`)).body.data;
    expect(view.payHidden).toBe(false);
    expect(view.payslip.basic).toEqual(expect.any(Number));
    expect(view.calcAtSubmission.payslip.net).toEqual(expect.any(Number));
    const stored = await Application.findById(id).lean();
    expect((await request(app()).get(`/api/v1/files/${stored.payslip.fileId}`).set(authed(grace.token))).status).toBe(200);
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
    const joseph = await signIn('LFB0002');
    expect((await api(joseph.token).get(`/review/${id}`)).body.data.payslip.basic).toEqual(expect.any(Number));
  });
});

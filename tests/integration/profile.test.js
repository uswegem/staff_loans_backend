'use strict';

// Staff profile and the completeness gate (BRD 6, decision 7, FR-05) and the
// eligibility view with the reapply cooling period (NS-02, NS-03).

const { app, seed, signIn, authed, request } = require('../helpers');
const { seedProducts } = require('../fixtures/products');
const Staff = require('../../src/models/Staff');
const Settings = require('../../src/models/Settings');
const AuditLog = require('../../src/models/AuditLog');

let products;
const api = (token) => ({
  get: (url) => request(app()).get(`/api/v1${url}`).set(authed(token)),
  patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(authed(token)).send(body),
});

beforeEach(async () => {
  const { users } = await seed();
  products = await seedProducts(users);
});

describe('my profile', () => {
  it('shows employment read-only, salary and the approval route', async () => {
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).get('/me/profile');
    expect(res.status).toBe(200);
    expect(res.body.data.personal.nida).toBe('19890712-14112-00004-21');
    expect(res.body.data.employment).toMatchObject({ category: 'Non-management', dateJoined: '2019-03-04', probation: { onProbation: false } });
    expect(res.body.data.salary).toMatchObject({ basic: 1850000, allowances: 220000 });
    expect(res.body.data.route).toMatchObject({ key: 'nonmgmt', limitedCredit: false });
    expect(res.body.data.completeness.complete).toBe(true);
  });

  it.each([
    ['LFB0067', 'mgmt'],
    ['LFB0002', 'ceo'],
    ['LFB0051', 'hrhead'],
  ])('%s is on the %s route (BRD 7.3)', async (staffNo, route) => {
    const p = await signIn(staffNo);
    const res = await api(p.token).get('/me/profile');
    expect(res.body.data.route.key).toBe(route);
    expect(res.body.data.route.limitedCredit).toBe(true);
  });

  it('Rehema has an incomplete profile and sees what is missing', async () => {
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).get('/me/profile/completeness');
    expect(res.body.data.complete).toBe(false);
    expect(res.body.data.missing.map((m) => m.label)).toEqual(
      expect.arrayContaining(['Marital status', 'Date of birth', 'NIDA number', 'P.O. Box', 'Account number', 'Next of kin first name', 'Next of kin surname'])
    );
    expect(res.body.data.missing.find((m) => m.key === 'personal.mobile')).toBeUndefined();
  });

  it('completes the profile tab by tab', async () => {
    const rehema = await signIn('LFB0596');
    const r = api(rehema.token);
    expect((await r.patch('/me/profile/personal', { maritalStatus: 'Single', dob: '1998-05-20', nida: '19980520-41108-00031-26', poBox: 'P.O. Box 902, Dodoma', residence: 'Area D, Dodoma' })).status).toBe(200);
    expect((await r.patch('/me/profile/bank', { accountNo: '4010 3341 0596' })).status).toBe(200);
    expect((await r.patch('/me/profile/kin', { nextOfKin: [{ firstName: 'Mwanaidi', lastName: 'Ally', relationship: 'Parent', phone: '+255 715 660 214', address: 'Kikuyu, Dodoma' }] })).status).toBe(200);
    const kin = await r.get('/me/profile/completeness');
    expect(kin.body.data).toMatchObject({ complete: true, done: 16, total: 16 });
    expect((await r.get('/me/profile')).body.data.nextOfKin[0]).toMatchObject({ firstName: 'Mwanaidi', lastName: 'Ally' });
    // Existing staff loans are optional and need no confirmation tick (D-80).
    expect((await r.patch('/me/profile/pay', { existingLfbLoans: [] })).status).toBe(200);
    const staff = await Staff.findOne({ staffNo: 'LFB0596' });
    expect(staff.personal.nida).toBe('19980520411080003126');
    expect(await AuditLog.countDocuments({ action: { $in: ['profile.personal', 'profile.bank', 'profile.kin', 'profile.pay'] } })).toBe(4);
  });

  it('refuses a malformed NIDA number with the prototype message', async () => {
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).patch('/me/profile/personal', { nida: '1998052041108' });
    expect(res.status).toBe(400);
    expect(res.body.details.nida[0]).toBe('A NIDA number has 20 digits, for example 19890712-14112-00004-21.');
  });

  it('existing staff loans are kept for the running-loan count and the reapply wait (BR-07, NS-02)', async () => {
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).patch('/me/profile/pay', { existingLfbLoans: [{ description: 'Paper loan 2025', instalment: 90000 }] });
    expect(res.status).toBe(200);
    expect((await Staff.findOne({ staffNo: 'LFB0412' })).existingLfbLoans[0].description).toBe('Paper loan 2025');
  });

  it('employment fields cannot be changed through the profile', async () => {
    const neema = await signIn('LFB0412');
    await api(neema.token).patch('/me/profile/personal', { residence: 'Isamilo', category: 'Management', dateJoined: '2010-01-01' });
    const s = await Staff.findOne({ staffNo: 'LFB0412' });
    expect(s.category).toBe('Non-management');
  });

  it('the mandatory fields are configurable', async () => {
    await Settings.updateOne({ _id: 'global' }, { $set: { mandatoryProfileFields: ['personal.mobile', 'personal.nida'] } });
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).get('/me/profile/completeness');
    expect(res.body.data).toMatchObject({ total: 2, done: 1 });
  });
});

describe('eligibility view (NS-02, NS-03)', () => {
  it('lists every live product; an incomplete profile blocks all', async () => {
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).get('/me/eligibility');
    expect(res.body.data.products).toHaveLength(4);
    res.body.data.products.forEach((p) => {
      expect(p.canApply).toBe(false);
      expect(p.reasons[0]).toMatch(/^You can apply once your profile is complete/);
    });
  });

  it('shows the days before a top-up for a product applied for recently, and leaves other products open', async () => {
    const appliedAt = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await Staff.updateOne(
      { staffNo: 'LFB0412' },
      { $set: { loanHistory: [{ productId: products.PL._id, ref: 'SL-2026-00020', appliedAt, approvedAt: appliedAt }] } }
    );
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).get('/me/eligibility');
    const pl = res.body.data.products.find((p) => p.name === 'Personal Loan');
    expect(pl.canApply).toBe(false);
    expect(pl.topUpAllowed).toBe(true);
    expect(pl.daysRemaining).toBeGreaterThanOrEqual(150);
    expect(pl.daysRemaining).toBeLessThanOrEqual(155);
    expect(pl.reasons[0]).toMatch(/^You applied for a Personal Loan on .+\. You can apply for this product again from .+ \(\d+ days\)\.$/);
    expect(res.body.data.products.find((p) => p.name === 'Vehicle Loan').canApply).toBe(true);
  });
});

'use strict';

// Date of birth with People and Culture verification, and the retirement cutoff on
// applications and approvals (D-82).

const { api, seedAll, applyAndSign, decide, signIn, CRB, HR_OK } = require('../flows');
const Staff = require('../../src/models/Staff');
const DobChange = require('../../src/models/DobChange');
const Application = require('../../src/models/Application');
const AuditLog = require('../../src/models/AuditLog');
const calc = require('../../src/services/calc/loanCalculator');
const { PRICING } = require('../../seed/products');
const { run: setupDob } = require('../../scripts/dob-verification-setup');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(120000);

let products;
const PL = () => String(products.PL._id);
const NEEMA = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const staffNo = (no) => Staff.findOne({ staffNo: no });
/** A date of birth that puts the cutoff (60th birthday − 60 days) about `months` months from today. */
const dobForMonthsLeft = (months) => calc.addMonthsToDay(localDay(), months - 720 + 2);

beforeEach(async () => {
  ({ products } = await seedAll());
});

describe('a date of birth change waits for People and Culture (D-82)', () => {
  it('stays pending; the verified value is used until HR approves it', async () => {
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).patch('/me/profile/personal', { dob: '1990-01-10' });
    expect(res.status).toBe(200);
    expect(res.body.data.dateOfBirth).toMatchObject({ verified: '1989-07-12', pending: { proposed: '1990-01-10' } });
    expect(res.body.data.personal.dob).toBe('1989-07-12');
    expect((await staffNo('LFB0412')).dateOfBirth.value).toBe('1989-07-12');

    // The application still uses the verified value.
    const draft = await api(neema.token).post('/applications', { productId: PL() });
    expect(draft.body.data.retirement).toMatchObject({ dateOfBirth: '1989-07-12', cutoff: calc.retirementCutoff('1989-07-12', 60, 60) });

    // People and Culture see it in the queue.
    const grace = await signIn('LFB0051');
    const queue = await api(grace.token).get('/dob-verifications');
    expect(queue.body.data.items).toEqual([expect.objectContaining({ staff: expect.objectContaining({ staffNo: 'LFB0412', name: 'Neema Mushi' }), current: '1989-07-12', proposed: '1990-01-10', submittedBy: 'Neema Mushi', status: 'pending' })]);

    const ok = await api(grace.token).post(`/dob-verifications/${queue.body.data.items[0].id}/approve`);
    expect(ok.status).toBe(200);
    const after = await staffNo('LFB0412');
    expect(after.dateOfBirth).toMatchObject({ value: '1990-01-10' });
    expect(String(after.dateOfBirth.verifiedBy)).toBe(String(grace.body.data.user.id));
    expect(after.dateOfBirth.pending?.changeId).toBeFalsy();
    const change = await DobChange.findOne({ proposed: '1990-01-10' });
    expect(change).toMatchObject({ status: 'approved', previous: '1989-07-12' });
    expect(change.decidedAt).toBeInstanceOf(Date);
    const fresh = await api(neema.token).get(`/applications/${draft.body.data.id}`);
    expect(fresh.body.data.retirement.dateOfBirth).toBe('1990-01-10');
  });

  it('the submitter cannot verify it, even as HR; another verifier can', async () => {
    const grace = await signIn('LFB0051');
    const neemaId = (await staffNo('LFB0412'))._id;
    const proposed = await api(grace.token).post(`/staff/${neemaId}/date-of-birth`, { dob: '1989-08-12' });
    expect(proposed.status).toBe(201);
    const id = String((await DobChange.findOne({ status: 'pending' }))._id);
    const self = await api(grace.token).post(`/dob-verifications/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SOD_SELF_VERIFY');
    const upendo = await signIn('LFB0129');
    expect((await api(upendo.token).post(`/dob-verifications/${id}/approve`)).status).toBe(200);
  });

  it('nobody verifies their own date of birth', async () => {
    await Staff.updateOne({ staffNo: 'LFB0051' }, { $unset: { dateOfBirth: '' } });
    await setupDob(); // carries Grace's earlier profile value into the queue
    const id = String((await DobChange.findOne({ status: 'pending' }))._id);
    const grace = await signIn('LFB0051');
    const own = await api(grace.token).post(`/dob-verifications/${id}/approve`);
    expect(own.body.code).toBe('SELF_RECORD');
  });

  it('a rejection needs a reason; every step is audited with old and new values', async () => {
    const neema = await signIn('LFB0412');
    await api(neema.token).patch('/me/profile/personal', { dob: '1991-03-03' });
    const grace = await signIn('LFB0051');
    const id = String((await DobChange.findOne({ status: 'pending' }))._id);
    const noReason = await api(grace.token).post(`/dob-verifications/${id}/reject`, { reason: ' ' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('REASON_REQUIRED');
    expect((await api(grace.token).post(`/dob-verifications/${id}/reject`, { reason: 'Does not match the NIDA card.' })).status).toBe(200);
    expect((await staffNo('LFB0412')).dateOfBirth.value).toBe('1989-07-12');
    const profile = await api(neema.token).get('/me/profile');
    expect(profile.body.data.dateOfBirth.lastRejection).toMatchObject({ proposed: '1991-03-03', reason: 'Does not match the NIDA card.' });

    const submit = await AuditLog.findOne({ action: 'dob.submit' }).lean();
    expect(submit).toMatchObject({ before: { dateOfBirth: '1989-07-12' }, after: { proposed: '1991-03-03', status: 'pending' } });
    const rejected = await AuditLog.findOne({ action: 'dob.reject' }).lean();
    expect(rejected).toMatchObject({ before: { dateOfBirth: '1989-07-12', proposed: '1991-03-03' }, after: { dateOfBirth: '1989-07-12', status: 'rejected', reason: 'Does not match the NIDA card.' } });

    await api(neema.token).patch('/me/profile/personal', { dob: '1989-07-21' });
    const id2 = String((await DobChange.findOne({ status: 'pending' }))._id);
    await api(grace.token).post(`/dob-verifications/${id2}/approve`);
    expect(await AuditLog.findOne({ action: 'dob.approve' }).lean()).toMatchObject({ before: { dateOfBirth: '1989-07-12' }, after: { dateOfBirth: '1989-07-21' } });
  });

  it('one open change at a time; the submitter may withdraw it; dates are checked', async () => {
    const neema = await signIn('LFB0412');
    const future = await api(neema.token).patch('/me/profile/personal', { dob: '2030-01-01' });
    expect(future.body.message).toBe('The date of birth cannot be in the future.');
    const young = await api(neema.token).patch('/me/profile/personal', { dob: localDay(new Date(Date.now() - 16 * 365.25 * 86400000)) });
    expect(young.body.message).toMatch(/^This date of birth gives an age of 1[56]\. It must be between 18 and 60\.$/);
    expect((await api(neema.token).patch('/me/profile/personal', { dob: '1990-01-10' })).status).toBe(200);
    const again = await api(neema.token).patch('/me/profile/personal', { dob: '1990-01-11' });
    expect(again.body.code).toBe('DOB_CHANGE_PENDING');
    const id = String((await DobChange.findOne({ status: 'pending' }))._id);
    const juma = await signIn('LFB0233');
    expect((await api(juma.token).post(`/dob-verifications/${id}/withdraw`)).status).toBe(404); // not the submitter
    expect((await api(juma.token).get('/dob-verifications')).status).toBe(403); // not a verifier
    expect((await api(neema.token).post(`/dob-verifications/${id}/withdraw`)).status).toBe(200);
    expect((await api(neema.token).patch('/me/profile/personal', { dob: '1990-01-11' })).status).toBe(200);
  });
});

describe('applying needs a verified date of birth (D-82)', () => {
  it('blocks without one, and says what to do', async () => {
    await Staff.updateOne({ staffNo: 'LFB0412' }, { $unset: { dateOfBirth: '' } });
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).post('/applications', { productId: PL() });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Add your date of birth in your profile (Personal details) and wait for People and Culture to verify it. You can apply once it is verified.');
    await api(neema.token).patch('/me/profile/personal', { dob: '1989-07-12' });
    const pending = await api(neema.token).post('/applications', { productId: PL() });
    expect(pending.body.message).toBe('Your date of birth (1989-07-12) is waiting for People and Culture to verify it. You can apply once it is verified.');
    const home = await api(neema.token).get('/me/eligibility');
    expect(home.body.data.products.every((p) => !p.canApply)).toBe(true);
  });

  it('blocks a staff member already past the cutoff', async () => {
    await Staff.updateOne({ staffNo: 'LFB0412' }, { $set: { 'dateOfBirth.value': dobForMonthsLeft(-1) } });
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).post('/applications', { productId: PL() });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^You cannot take a new loan: it must be repaid by \d{4}-\d{2}-\d{2} \(60 days before you turn 60\), and no monthly instalment falls on or before that date\.$/);
  });

  it('caps the tenor and works out affordability on the capped tenor', async () => {
    await Staff.updateOne({ staffNo: 'LFB0412' }, { $set: { 'dateOfBirth.value': dobForMonthsLeft(30) } });
    const neema = await signIn('LFB0412');
    const created = await api(neema.token).post('/applications', { productId: PL() });
    const id = created.body.data.id;
    const { attachPayslip } = require('../flows');
    await attachPayslip(neema, id);
    const res = await api(neema.token).patch(`/applications/${id}`, { ...NEEMA, tenor: 60, repaymentMethod: 'payroll' });
    const { retirement, quote, checks } = res.body.data;
    const first = calc.firstDueDate(localDay(), 25);
    expect(retirement.maxTenor).toBe(calc.instalmentsBefore(retirement.cutoff, first));
    expect(retirement.maxTenor).toBeLessThan(60);
    expect(quote.maxTenor).toBe(retirement.maxTenor);
    expect(quote.maxAmount).toBe(calc.maxAmount(quote.maxInstalment, retirement.maxTenor, PRICING.interestBps, PRICING.instalmentRounding, { cap: 300000000 }));
    // 60 months is refused with the cutoff and the maximum, never shortened silently.
    expect(checks.canSubmit).toBe(false);
    expect(checks.checks).toContain(`Your last instalment would be due on ${calc.addMonthsToDay(first, 59)}, after your cutoff of ${retirement.cutoff} (60 days before you turn 60). The longest tenor you can take is ${retirement.maxTenor} months.`);
    expect((await Application.findById(id)).tenor).toBe(60);
    const fits = await api(neema.token).patch(`/applications/${id}`, { tenor: retirement.maxTenor });
    expect(fits.body.data.checks.checks.filter((c) => c.includes('cutoff'))).toEqual([]);
  });
});

describe('every approval re-checks the cutoff (D-82)', () => {
  it('fails when a newly verified date of birth no longer allows the tenor', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    const juma = await signIn('LFB0233');
    expect((await decide(juma, id, { action: 'approve', crb: CRB })).body.data.outcome).toBe('moved');

    // Between stages, a corrected date of birth is verified: about 12 months are left.
    const grace = await signIn('LFB0051');
    await api(grace.token).post(`/staff/${(await staffNo('LFB0412'))._id}/date-of-birth`, { dob: dobForMonthsLeft(12) });
    const upendo = await signIn('LFB0129');
    await api(upendo.token).post(`/dob-verifications/${(await DobChange.findOne({ status: 'pending' }))._id}/approve`);

    const res = await decide(grace, id, { action: 'approve', hrChecks: HR_OK });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUTOFF_EXCEEDED');
    expect(res.body.message).toMatch(/^This application cannot be approved now\. The last instalment would be due on \d{4}-\d{2}-25, after the cutoff of \d{4}-\d{2}-\d{2} \(60 days before you turn 60\)\. The longest tenor allowed is 1\d months; 36 months is too long\. Return it, reject it, or \(Credit Analyst\) recommend a shorter tenor\.$/);
    expect((await Application.findById(id)).status).toBe('pending_hr');
    // Returning still works.
    expect((await decide(grace, id, { action: 'return', comment: 'Apply for a shorter tenor before your retirement cutoff.' })).body.data.outcome).toBe('returned');
  });
});

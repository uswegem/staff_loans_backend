'use strict';

// Disbursement and notifications (BRD 11, 12; FR-20 to FR-22, FR-24 to FR-26; Q3).

const { api, seedAll, applyAndSign, decide, signIn, CRB, HR_OK } = require('../flows');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const Decision = require('../../src/models/Decision');
const Delegation = require('../../src/models/Delegation');
const Notification = require('../../src/models/Notification');
const ProductVersion = require('../../src/models/ProductVersion');
const AuditLog = require('../../src/models/AuditLog');
const User = require('../../src/models/User');
const { flagOutsideSla } = require('../../src/services/disbursement/disbursementService');
const { remindOverdue } = require('../../src/services/workflow/reminders');
const { localDay } = require('../../src/utils/dates');

// Whole-route flows sign in four people; allow for a loaded machine.
jest.setTimeout(120000);

let products;
const PL = () => products.PL._id;
const DAY = 24 * 3600 * 1000;
const userId = async (staffNo) => (await User.findOne({ staffNo }))._id;
const notesFor = async (staffNo, type) => Notification.find({ userId: await userId(staffNo), ...(type ? { type } : {}) }).lean();
const NEEMA = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };

beforeEach(async () => {
  ({ products } = await seedAll());
});

/** Applies as Neema and takes the loan through the non-management route to OPS. */
async function toOps() {
  const neema = await signIn('LFB0412');
  const id = await applyAndSign(neema, PL(), NEEMA);
  await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
  await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
  const final = await decide(await signIn('LFB0002'), id, { action: 'approve' });
  expect(final.body.data.outcome).toBe('approved');
  return { id, neema };
}

describe('OPS confirms disbursement (FR-20 to FR-22)', () => {
  it('lists the loan, checks the confirmation, then ends the journey and regenerates the schedule', async () => {
    const { id, neema } = await toOps();
    const halima = await signIn('LFB0318');
    const ops = api(halima.token);

    const ready = await ops.get('/disbursements');
    expect(ready.status).toBe(200);
    expect(ready.body.data.counts).toMatchObject({ ready: 1, done: 0, outsideSla: 0 });
    const ag = await Agreement.findById((await Application.findById(id)).currentAgreementId);
    expect(ready.body.data.items[0]).toMatchObject({ id, staff: { name: 'Neema Mushi', staffNo: 'LFB0412' }, product: 'Personal Loan', amount: 4500000, instalment: 136900, processingFee: ag.terms.processingFee, insuranceFee: ag.terms.insuranceFee, outsideSla: false, blockedReason: null });

    const detail = await ops.get(`/disbursements/${id}`);
    expect(detail.body.data).toMatchObject({ agreement: { number: ag.number }, conditions: [], earliestDate: localDay(), topUp: null });
    expect(detail.body.data.schedule).toHaveLength(36);

    const today = localDay();
    const tomorrow = localDay(new Date(Date.now() + DAY));
    const yesterday = localDay(new Date(Date.now() - DAY));
    expect((await ops.post(`/disbursements/${id}/confirm`, { date: today, comment: '  ' })).body.code).toBe('COMMENT_REQUIRED');
    expect((await ops.post(`/disbursements/${id}/confirm`, { date: tomorrow, comment: 'Done.' })).body.message).toBe('The disbursement date cannot be in the future.');
    expect((await ops.post(`/disbursements/${id}/confirm`, { date: yesterday, comment: 'Done.' })).body.message).toBe('The disbursement date cannot be before the final approval.');
    expect((await ops.post(`/disbursements/${id}/confirm`, { date: today, comment: 'Done.', transactionRef: '=HYPERLINK(1)' })).status).toBe(400);

    const ok = await ops.post(`/disbursements/${id}/confirm`, { date: today, transactionRef: 'FT26294AB12', comment: 'Loan disbursed to staff account.' });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toMatch(/disbursed\. Journey complete\./);
    const a = await Application.findById(id);
    expect(a).toMatchObject({ status: 'disbursed', scheduleBasis: 'disbursement', disbursement: { transactionRef: 'FT26294AB12', comment: 'Loan disbursed to staff account.' } });
    expect(String(a.disbursement.confirmedBy)).toBe(String(await userId('LFB0318')));
    expect(a.schedule).toHaveLength(36);
    expect(a.schedule[0].due > today).toBe(true);
    expect(await Decision.countDocuments({ applicationId: id, action: 'disburse' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'disbursement.confirm', entityId: id })).toBe(1);
    const [note] = await notesFor('LFB0412', 'application.disbursed');
    expect(note.text).toMatch(/your loan of TZS 4,500,000 has been disbursed\. Your first instalment of TZS 136,900 is due on \d{4}-\d{2}-\d{2}\./);

    // Once only.
    expect((await ops.post(`/disbursements/${id}/confirm`, { date: today, comment: 'Again.' })).body.code).toBe('ALREADY_DISBURSED');
    const done = await ops.get('/disbursements?tab=done');
    expect(done.body.data.items[0]).toMatchObject({ id, disbursement: { date: today, transactionRef: 'FT26294AB12', by: 'Halima Said' } });

    // FR-25: the applicant sees the disbursement and the schedule from it.
    const mine = await api(neema.token).get(`/applications/${id}`);
    expect(mine.body.data).toMatchObject({ status: 'disbursed', scheduleBasis: 'disbursement', disbursement: { date: today, transactionRef: 'FT26294AB12' } });
    expect(mine.body.data.schedule[0].due).toBe(a.schedule[0].due);
    expect(mine.body.data.history.at(-1).action).toBe('disburse');

    // OPS opens the agreement, not the bureau report.
    expect((await ops.get(`/agreements/${ag._id}/pdf`)).status).toBe(200);
  });

  it('requires each product condition to be ticked (FR-22)', async () => {
    const { id } = await toOps();
    const app = await Application.findById(id);
    await ProductVersion.updateOne({ _id: app.productVersionId }, { $set: { disbursementConditions: ['Insurance cover note received', 'Sale agreement on file'] } });
    const ops = api((await signIn('LFB0318')).token);
    expect((await ops.get(`/disbursements/${id}`)).body.data.conditions).toHaveLength(2);
    const body = { date: localDay(), comment: 'Disbursed.' };
    expect((await ops.post(`/disbursements/${id}/confirm`, { ...body, conditions: [true] })).body.message).toBe('Tick each condition before you confirm.');
    expect((await ops.post(`/disbursements/${id}/confirm`, { ...body, conditions: [true, true] })).status).toBe(200);
    expect((await Application.findById(id)).disbursement.conditions.map((c) => c.text)).toEqual(['Insurance cover note received', 'Sale agreement on file']);
  });

  it('a top-up needs the old balance confirmed as settled', async () => {
    const { id } = await toOps();
    await Application.updateOne({ _id: id }, { $set: { topUp: { on: true, loanRef: 'SL-2026-00003', instalment: 50000, outstanding: 900000 } } });
    const ops = api((await signIn('LFB0318')).token);
    const body = { date: localDay(), comment: 'Disbursed.' };
    expect((await ops.post(`/disbursements/${id}/confirm`, body)).body.code).toBe('TOPUP_NOT_SETTLED');
    expect((await ops.post(`/disbursements/${id}/confirm`, { ...body, topUpSettled: true })).status).toBe(200);
  });

  it('OPS cannot confirm their own loan or one they approved (FR-48)', async () => {
    const { id } = await toOps();
    const halimaId = await userId('LFB0318');
    const ops = api((await signIn('LFB0318')).token);

    await Decision.create({ applicationId: id, cycle: 1, stage: 'ceo', action: 'approve', actorId: await userId('LFB0002'), onBehalfOfId: halimaId, at: new Date() });
    const list = await ops.get('/disbursements');
    expect(list.body.data.items[0].blockedReason).toBe('You approved this loan, so another OPS officer confirms it.');
    expect((await ops.post(`/disbursements/${id}/confirm`, { date: localDay(), comment: 'x' })).body.code).toBe('SOD_DISBURSE');

    await Application.updateOne({ _id: id }, { $set: { applicantUserId: halimaId } });
    const res = await ops.post(`/disbursements/${id}/confirm`, { date: localDay(), comment: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This is your own loan. Another OPS officer confirms it.');
  });

  it('only OPS reaches the queue', async () => {
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).get('/disbursements')).status).toBe(403);
    const juma = await signIn('LFB0233');
    expect((await api(juma.token).get('/disbursements')).status).toBe(403);
  });
});

describe('Outside SLA (Q3): flagged, never expired', () => {
  it('flags a loan waiting longer than approvalSlaDays and still lets OPS disburse it', async () => {
    const { id } = await toOps();
    await Application.updateOne({ _id: id }, { $set: { stageEnteredAt: new Date(Date.now() - 31 * DAY) } });
    const ops = api((await signIn('LFB0318')).token);
    const list = await ops.get('/disbursements');
    expect(list.body.data.counts.outsideSla).toBe(1);
    expect(list.body.data.items[0]).toMatchObject({ outsideSla: true, daysWaiting: 31, slaDays: 30 });

    expect(await flagOutsideSla()).toBe(1);
    expect((await Application.findById(id)).outsideSla).toBe(true);
    expect((await Application.findById(id)).status).toBe('pending_disbursement');

    expect((await ops.post(`/disbursements/${id}/confirm`, { date: localDay(), comment: 'Disbursed late.' })).status).toBe(200);
    expect((await Application.findById(id)).outsideSla).toBe(false);
  });
});

describe('disbursed loans register (FR-26)', () => {
  it('exports CSV for OPS and report exporters, with the recovery columns', async () => {
    const { id } = await toOps();
    const ops = api((await signIn('LFB0318')).token);
    await ops.post(`/disbursements/${id}/confirm`, { date: localDay(), transactionRef: 'FT26294AB12', comment: 'Disbursed.' });

    const res = await ops.get('/disbursements/register.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Reference,Staff number,Staff,Department,Product,Amount,Processing fee,Insurance,Instalment,Tenor,Repayment method,Account,First due date,Disbursed,Transaction ref,Agreement');
    expect(lines[1]).toMatch(/^SL-\d{4}-\d{5},LFB0412,Neema Mushi,.*,Personal Loan,4500000,.*,136900,36,Payroll deduction,,\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2},FT26294AB12,MKT-/);
    expect(await AuditLog.countDocuments({ action: 'report.export' })).toBe(1);

    expect((await api((await signIn('LFB0051')).token).get('/disbursements/register.csv')).status).toBe(200); // HR (reports.export)
    expect((await api((await signIn('LFB0412')).token).get('/disbursements/register.csv')).status).toBe(403);
  });
});

describe('notifications (BRD 12)', () => {
  it('reminds the reviewer once when a stage is overdue, and the delegate with the holder', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    await Application.updateOne({ _id: id }, { $set: { stageDueAt: new Date(Date.now() - 3600 * 1000) } });

    expect(await remindOverdue()).toBe(1);
    const [note] = await notesFor('LFB0233', 'application.overdue');
    expect(note.text).toMatch(/from Neema Mushi is overdue at Credit Analyst review\./);
    expect(await remindOverdue()).toBe(0); // once per stage
    expect(await notesFor('LFB0412', 'application.overdue')).toHaveLength(0);

    // A new stage entry can be reminded again; a delegate is told with the holder.
    await Delegation.create({ delegatorId: await userId('LFB0233'), delegateId: await userId('LFB0129'), permissions: ['review.credit'], from: new Date(Date.now() - DAY), until: new Date(Date.now() + DAY) });
    await Application.updateOne({ _id: id }, { $set: { stageEnteredAt: new Date(), stageDueAt: new Date(Date.now() - 1000) } });
    expect(await remindOverdue()).toBe(1);
    expect(await notesFor('LFB0233', 'application.overdue')).toHaveLength(2);
    expect(await notesFor('LFB0129', 'application.overdue')).toHaveLength(1);
  });

  it('tells the applicant what is missing when they start with an incomplete profile, once while unread', async () => {
    const rehema = await signIn('LFB0596');
    await api(rehema.token).post('/applications', { productId: String(PL()) });
    await api(rehema.token).post('/applications', { productId: String(PL()) });
    const notes = await notesFor('LFB0596', 'profile.incomplete');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ href: '/profile', text: expect.stringMatching(/^Complete your profile to apply\. Missing: .*NIDA number/) });
  });

  it('sends the first stage to an active delegate instead of the holder (FR-19)', async () => {
    await Delegation.create({ delegatorId: await userId('LFB0233'), delegateId: await userId('LFB0129'), permissions: ['review.credit'], from: new Date(Date.now() - DAY), until: new Date(Date.now() + DAY) });
    const neema = await signIn('LFB0412');
    await applyAndSign(neema, PL(), NEEMA);
    expect(await notesFor('LFB0129', 'application.stage')).toHaveLength(1);
    expect(await notesFor('LFB0233', 'application.stage')).toHaveLength(0);
  });
});

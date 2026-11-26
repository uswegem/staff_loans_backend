'use strict';

// D-112: one Disbursement queue after final approval, replacing the in-system booking step
// of D-107. OPS, the Head of People and Culture and the P&C Manager (disb.confirm) download
// the Agreement and a one-page Loan Summary and mark the loan as disbursed with a date, a
// unique transaction reference and a required comment. Nobody marks their own loan, or one
// they approved (themselves, as a delegate, or on whose behalf it was approved). The
// applicant never downloads the papers here.

const { api, seedAll, applyAndSign, decide, signIn, CRB, HR_OK } = require('../flows');
const { pages } = require('../pdfRaster');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const AuditLog = require('../../src/models/AuditLog');
const Decision = require('../../src/models/Decision');
const Notification = require('../../src/models/Notification');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');
const User = require('../../src/models/User');
const { SUMMARY_TEXT } = require('../../src/services/agreement/pdfService');
const { describeRoute, ROUTES } = require('../../src/services/workflow/routes');
const { blockedReason } = require('../../src/services/disbursement/disbursementService');
const { PERMISSION_IDS, sodConflicts } = require('../../src/constants/permissions');
const { DEFAULT_ROLES } = require('../../src/constants/systemRoles');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(240000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const DAY = 24 * 3600 * 1000;
const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const OTHER = 'Another People and Culture or OPS officer marks it as disbursed.';
const userId = async (staffNo) => (await User.findOne({ staffNo }))._id;
const binary = (r) => r.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const as = async (staffNo) => api((await signIn(staffNo)).token);
const textOf = async (buf) => (await pages(buf)).map((p) => p.items.map((i) => i.str).join(' ')).join(' ').replace(/\s+/g, ' ');

/**
 * Neema's loan through Credit, People and Culture and the CEO. pcBy: who decides the People
 * and Culture stage (the Head of P&C by default, or the P&C Manager; D-103).
 */
async function approved({ pcBy = 'LFB0051' } = {}) {
  const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
  await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
  await decide(await signIn(pcBy), id, { action: 'approve', hrChecks: HR_OK });
  expect((await decide(await signIn('LFB0002'), id, { action: 'approve' })).body.data.outcome).toBe('approved');
  return id;
}

const BODY = { date: localDay(), transactionRef: 'FT26294AB12', comment: 'Paid to the staff account.' };

describe('one Disbursement queue (D-112)', () => {
  it('the roles: OPS, Head of P&C and P&C Manager hold disb.confirm; loan.book is gone; other approvers stay apart', () => {
    const perms = (code) => DEFAULT_ROLES.find((r) => r.code === code).permissions;
    for (const code of ['ops', 'head_pc', 'pc_manager']) expect(perms(code)).toContain('disb.confirm');
    expect(PERMISSION_IDS).not.toContain('loan.book');
    expect(DEFAULT_ROLES.flatMap((r) => r.permissions)).not.toContain('loan.book');
    expect(sodConflicts(perms('head_pc'))).toEqual([]);
    expect(sodConflicts(perms('pc_manager'))).toEqual([]);
    expect(sodConflicts(['review.ceo', 'disb.confirm']).map((r) => r.id)).toContain('sod2');
    expect(sodConflicts(['review.credit', 'disb.confirm']).map((r) => r.id)).toContain('sod2');
    expect(describeRoute(Object.values(ROUTES)[0])).toMatch(/then Disbursement \(People and Culture or OPS\)$/);
  });

  it('final approval goes straight to Pending Disbursement; everyone with disb.confirm is told; two tabs; no booking', async () => {
    const id = await approved();
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_disbursement' });
    for (const staffNo of ['LFB0318', 'LFB0129']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await Notification.exists({ userId: await userId(staffNo), type: 'application.ready_to_disburse' })).toBeTruthy();
    }
    expect(await Notification.exists({ type: 'application.ready_to_book' })).toBeFalsy();
    const upendo = await as('LFB0129');
    const queue = (await upendo.get('/disbursements')).body.data;
    expect(queue).toMatchObject({ tab: 'ready', counts: { ready: 1, done: 0 }, can: { confirm: true } });
    expect(queue.counts.booking).toBeUndefined();
    expect(queue.items[0]).toMatchObject({ id, canConfirm: true, canDownload: true, agreementId: expect.any(String) });
    expect(queue.items[0].canBook).toBeUndefined();
    expect((await upendo.get('/disbursements?tab=booking')).status).toBe(400);
    expect((await upendo.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN1', date: localDay() })).status).toBe(404);
    // Staff without disb.confirm cannot open the queue.
    expect((await (await as('LFB0412')).get('/disbursements')).status).toBe(403);
    expect((await (await as('LFB0233')).get('/disbursements')).status).toBe(403);
  });

  it('the P&C Manager marks a loan as disbursed: date, reference and comment; the applicant is told; audited; read-only after', async () => {
    const id = await approved();
    const upendo = await as('LFB0129');
    const ok = await upendo.post(`/disbursements/${id}/confirm`, BODY);
    expect(ok.status).toBe(200);
    const a = await Application.findById(id).lean();
    expect(a).toMatchObject({ status: 'disbursed', scheduleBasis: 'disbursement', disbursement: { transactionRef: 'FT26294AB12', comment: 'Paid to the staff account.' } });
    expect(String(a.disbursement.confirmedBy)).toBe(String(await userId('LFB0129')));
    expect(a.schedule).toHaveLength(36);
    expect(await Notification.exists({ userId: await userId('LFB0412'), type: 'application.disbursed' })).toBeTruthy();
    const log = await AuditLog.findOne({ action: 'loan.disbursed', entityId: id }).lean();
    expect(log.description).toMatch(/FT26294AB12: Paid to the staff account\./);
    expect((await upendo.post(`/disbursements/${id}/confirm`, { ...BODY, transactionRef: 'FT2' })).body.code).toBe('ALREADY_DISBURSED');
    const done = (await upendo.get('/disbursements?tab=done')).body.data.items[0];
    expect(done).toMatchObject({ id, canConfirm: false, disbursement: { date: localDay(), transactionRef: 'FT26294AB12', comment: 'Paid to the staff account.', by: 'Upendo Massawe' } });
  });

  it('the Head of P&C marks one they did not approve (the P&C Manager decided the stage)', async () => {
    const id = await approved({ pcBy: 'LFB0129' });
    const grace = await as('LFB0051');
    expect((await grace.get('/disbursements')).body.data.items[0]).toMatchObject({ id, canConfirm: true });
    expect((await grace.post(`/disbursements/${id}/confirm`, BODY)).status).toBe(200);
  });

  it('OPS marks a loan as disbursed', async () => {
    const id = await approved();
    expect((await (await as('LFB0318')).post(`/disbursements/${id}/confirm`, BODY)).status).toBe(200);
  });

  it('refuses without a reference or comment, a future date, a date before final approval and a duplicate reference', async () => {
    const id = await approved();
    const halima = await as('LFB0318');
    const noComment = await halima.post(`/disbursements/${id}/confirm`, { ...BODY, comment: 'Paid' });
    expect(noComment.status).toBe(400);
    expect(noComment.body.details.comment).toEqual(['Add a comment for the disbursement record.']);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...BODY, comment: undefined })).status).toBe(400);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...BODY, comment: 'x'.repeat(1001) })).status).toBe(400);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...BODY, transactionRef: '' })).status).toBe(400);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...BODY, transactionRef: 'FT 1' })).status).toBe(400);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...BODY, transactionRef: 'F'.repeat(41) })).status).toBe(400);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...BODY, date: localDay(new Date(Date.now() + DAY)) })).body.message).toBe('The disbursement date cannot be in the future.');
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...BODY, date: localDay(new Date(Date.now() - DAY)) })).body.message).toBe('The disbursement date cannot be before the final approval.');

    // A reference already on another loan, in any case.
    const other = await applyAndSign(await signIn('LFB0233'), products.PL._id, TERMS);
    await Application.updateOne({ _id: other }, { $set: { status: 'disbursed', disbursement: { date: new Date(), transactionRef: 'FT26294AB12', comment: 'Earlier loan paid.' } } });
    const otherRef = (await Application.findById(other)).ref;
    const dup = await halima.post(`/disbursements/${id}/confirm`, { ...BODY, transactionRef: 'ft26294ab12' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE_TRANSACTION_REF', message: `This reference is already recorded on ${otherRef}.` });
    expect((await Application.findById(id)).status).toBe('pending_disbursement');
  });

  it('nobody marks their own loan, or one they approved, as disbursed', async () => {
    const id = await approved();
    // Grace (Head of P&C) decided the People and Culture stage.
    const grace = await as('LFB0051');
    expect((await grace.get('/disbursements')).body.data.items[0]).toMatchObject({ canConfirm: false, blockedReason: `You approved this loan. ${OTHER}` });
    const refused = await grace.post(`/disbursements/${id}/confirm`, BODY);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'SOD_DISBURSE', message: `You approved this loan. ${OTHER}` });

    // Neema, given OPS rights for the test, on her own loan: refused, and no papers.
    const ops = await Role.findOne({ code: 'ops' });
    await RoleAssignment.create({ userId: await userId('LFB0412'), roleId: ops._id });
    const neema = await as('LFB0412');
    expect((await neema.get('/disbursements')).body.data.items[0]).toMatchObject({ canConfirm: false, ownLoan: true, canDownload: false, blockedReason: `This is your own loan. ${OTHER}` });
    expect((await neema.post(`/disbursements/${id}/confirm`, BODY)).body.code).toBe('SOD_DISBURSE');
  });

  it('a delegate who approved, and the person it was approved for, are both kept from it', async () => {
    const id = await approved();
    const app = await Application.findById(id).lean();
    const [upendo, halima] = [await userId('LFB0129'), await userId('LFB0318')];
    await Decision.create({ applicationId: id, cycle: app.cycle, action: 'approve', stage: 'ceo', actorId: upendo, onBehalfOfId: halima, at: new Date() });
    expect(await blockedReason(upendo, app)).toBe(`You approved this loan as a delegate. ${OTHER}`);
    expect(await blockedReason(halima, app)).toBe(`This loan was approved on your behalf. ${OTHER}`);
  });
});

describe('Disbursement papers (D-112)', () => {
  it('the Loan Summary: one Swahili page for OPS and People and Culture, with the disbursement once done; audited', async () => {
    const id = await approved();
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    expect(ag.language).toBe('sw');
    const S = SUMMARY_TEXT.sw;
    const ref = (await Application.findById(id)).ref;

    const pc = await binary((await as('LFB0129')).get(`/disbursements/${id}/summary.pdf`));
    expect(pc.status).toBe(200);
    expect(pc.headers['content-type']).toMatch(/application\/pdf/);
    expect(pc.headers['content-disposition']).toContain(`loan-summary-${ref}.pdf`);
    expect(await pages(pc.body)).toHaveLength(1);
    const text = await textOf(pc.body);
    for (const label of [S.title, S.staff, S.terms, S.approvals, S.disbursement, S.notDisbursed, S.totalRepayable, S.payslipLabel]) expect(text).toContain(label);
    for (const value of [ref, ag.number, 'Neema Mushi', 'LFB0412', '4,500,000', 'Imetolewa na Upendo Massawe']) expect(text).toContain(value);
    expect(text).not.toContain(S.booking);
    expect(text).not.toMatch(/Low Risk|Salio la mwanzo|Opening balance/);

    expect((await (await as('LFB0318')).post(`/disbursements/${id}/confirm`, BODY)).status).toBe(200);
    const ops = await binary((await as('LFB0318')).get(`/disbursements/${id}/summary.pdf`));
    expect(ops.status).toBe(200);
    const after = await textOf(ops.body);
    for (const value of ['FT26294AB12', 'Paid to the staff account.', S.confirmedBy]) expect(after).toContain(value);

    const logs = await AuditLog.find({ action: 'summary.download', entityId: id }).lean();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ appRef: ref, after: { language: 'sw' } });
  });

  it('the Agreement downloads as "<agreement number>.pdf" for OPS, the P&C Manager and the Head of P&C; audited', async () => {
    const id = await approved();
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    for (const staffNo of ['LFB0318', 'LFB0129', 'LFB0051']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await binary((await as(staffNo)).get(`/agreements/${ag._id}/pdf`));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toContain(`${ag.number}.pdf`);
    }
    const logs = await AuditLog.find({ action: 'agreement.download', entityId: String(ag._id) }).lean();
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ appRef: (await Application.findById(id)).ref, after: { language: 'sw' } });
  });

  it('refused to the applicant, to staff without disb.confirm, and before final approval', async () => {
    const id = await approved();
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    // Credit has no disb.confirm.
    expect((await (await as('LFB0233')).get(`/disbursements/${id}/summary.pdf`)).status).toBe(403);
    // The applicant with OPS rights: OWN_LOAN.
    const ops = await Role.findOne({ code: 'ops' });
    await RoleAssignment.create({ userId: await userId('LFB0412'), roleId: ops._id });
    const own = await (await as('LFB0412')).get(`/disbursements/${id}/summary.pdf`);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('OWN_LOAN');
    // Not finally approved yet.
    const early = await applyAndSign(await signIn('LFB0233'), products.PL._id, TERMS);
    const res = await (await as('LFB0318')).get(`/disbursements/${early}/summary.pdf`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_APPROVED');
    const earlyAg = await Agreement.findOne({ applicationId: early }).lean();
    expect((await (await as('LFB0318')).get(`/agreements/${earlyAg._id}/pdf`)).status).toBe(404);
    expect(ag.number).toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'summary.download' })).toBe(0);
  });
});

'use strict';

// D-112: the final queue is "Disbursement". People and Culture (loan.book) and OPS
// (disb.confirm) download the Agreement and a one-page Loan Summary for any approved loan;
// the applicant never does here. OPS marks a booked loan as disbursed with a date, a unique
// transaction reference and a required comment; the applicant and People and Culture are told.

const { api, seedAll, applyAndSign, decide, signIn, bookLoan, CRB, HR_OK } = require('../flows');
const { pages } = require('../pdfRaster');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const AuditLog = require('../../src/models/AuditLog');
const Notification = require('../../src/models/Notification');
const User = require('../../src/models/User');
const { SUMMARY_TEXT } = require('../../src/services/agreement/pdfService');
const { describeRoute } = require('../../src/services/workflow/routes');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(240000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const DAY = 24 * 3600 * 1000;
const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const userId = async (staffNo) => (await User.findOne({ staffNo }))._id;
const binary = (r) => r.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const as = async (staffNo) => api((await signIn(staffNo)).token);
const textOf = async (buf) => (await pages(buf)).map((p) => p.items.map((i) => i.str).join(' ')).join(' ').replace(/\s+/g, ' ');

/** Neema's loan with final approval (pending booking). */
async function approved() {
  const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
  await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
  await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
  expect((await decide(await signIn('LFB0002'), id, { action: 'approve' })).body.data.outcome).toBe('approved');
  return id;
}

describe('Disbursement queue downloads (D-112)', () => {
  it('the Loan Summary: People and Culture and OPS get one page in the agreement language; audited', async () => {
    const id = await approved();
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    const S = SUMMARY_TEXT[ag.language === 'en' ? 'en' : 'sw'];

    // P&C Manager while pending booking.
    const pc = await binary((await as('LFB0129')).get(`/disbursements/${id}/summary.pdf`));
    expect(pc.status).toBe(200);
    expect(pc.headers['content-type']).toMatch(/application\/pdf/);
    const ref = (await Application.findById(id)).ref;
    expect(pc.headers['content-disposition']).toContain(`loan-summary-${ref}.pdf`);
    const ps = await pages(pc.body);
    expect(ps).toHaveLength(1);
    const text = await textOf(pc.body);
    for (const label of [S.title, S.staff, S.terms, S.approvals, S.booking, S.disbursement, S.notBooked]) expect(text).toContain(label);
    expect(text).toContain(ref);
    expect(text).toContain(ag.number);
    expect(text).toContain('Neema Mushi');
    expect(text).toContain('4,500,000');
    expect(text).toMatch(new RegExp(`${S.generated('Upendo Massawe', '').trim()}`));
    // No schedule, bureau report or payslip figures.
    expect(text).not.toMatch(/Low Risk|Opening balance|Salio la mwanzo|Net pay|Mshahara halisi/i);

    // OPS after booking and disbursement: the booking and disbursement sections are filled.
    await bookLoan(id);
    expect((await (await as('LFB0318')).post(`/disbursements/${id}/confirm`, { date: localDay(), transactionRef: 'FT26294AB12', comment: 'Paid to the staff account.' })).status).toBe(200);
    const ops = await binary((await as('LFB0318')).get(`/disbursements/${id}/summary.pdf`));
    expect(ops.status).toBe(200);
    const after = await textOf(ops.body);
    expect(after).toContain('LN2026000123');
    expect(after).toContain('FT26294AB12');
    expect(after).toContain('Paid to the staff account.');

    const logs = await AuditLog.find({ action: 'summary.download', entityId: id }).lean();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ appRef: ref, after: { language: ag.language || 'sw' } });
  });

  it('the Loan Summary is refused to the applicant, to staff without the permissions and before final approval', async () => {
    const id = await approved();
    // Credit has neither loan.book nor disb.confirm.
    expect((await (await as('LFB0233')).get(`/disbursements/${id}/summary.pdf`)).status).toBe(403);
    // The applicant (given OPS rights for the test) is refused with OWN_LOAN.
    const Role = require('../../src/models/Role');
    const RoleAssignment = require('../../src/models/RoleAssignment');
    const ops = await Role.findOne({ code: 'ops' });
    await RoleAssignment.create({ userId: await userId('LFB0412'), roleId: ops._id });
    const item = (await (await as('LFB0412')).get('/disbursements?tab=booking')).body.data.items.find((i) => i.id === id);
    expect(item).toMatchObject({ ownLoan: true, canDownload: false });
    expect((await (await as('LFB0318')).get('/disbursements?tab=booking')).body.data.items[0]).toMatchObject({ ownLoan: false, canDownload: true, agreementId: expect.any(String) });
    const own = await (await as('LFB0412')).get(`/disbursements/${id}/summary.pdf`);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('OWN_LOAN');
    // Not yet approved.
    const other = await applyAndSign(await signIn('LFB0233'), products.PL._id, TERMS);
    const early = await (await as('LFB0318')).get(`/disbursements/${other}/summary.pdf`);
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('NOT_APPROVED');
    expect(await AuditLog.countDocuments({ action: 'summary.download' })).toBe(0);
  });

  it('OPS and the P&C Manager download the Agreement as "<agreement number>.pdf"; audited with the reference', async () => {
    const id = await approved();
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    for (const staffNo of ['LFB0318', 'LFB0129']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await binary((await as(staffNo)).get(`/agreements/${ag._id}/pdf`));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toContain(`${ag.number}.pdf`);
    }
    const ref = (await Application.findById(id)).ref;
    const logs = await AuditLog.find({ action: 'agreement.download', entityId: String(ag._id) }).lean();
    expect(logs).toHaveLength(2);
    expect(logs[0].appRef).toBe(ref);
  });

  it('the route description names Disbursement', () => {
    const { ROUTES } = require('../../src/services/workflow/routes');
    expect(describeRoute(Object.values(ROUTES)[0])).toMatch(/then Disbursement \(People and Culture book, OPS disburse\)$/);
  });
});

describe('Mark as disbursed (D-112)', () => {
  it('refuses before booking, to People and Culture, without a comment or reference, on bad dates and on a duplicate reference', async () => {
    const id = await approved();
    const halima = await as('LFB0318');
    const today = localDay();
    const body = { date: today, transactionRef: 'FT26294AB12', comment: 'Paid to the staff account.' };

    const early = await halima.post(`/disbursements/${id}/confirm`, body);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_BOOKED');

    await bookLoan(id);
    // People and Culture cannot mark it as disbursed.
    expect((await (await as('LFB0129')).post(`/disbursements/${id}/confirm`, body)).status).toBe(403);
    // Comment and reference required.
    const noComment = await halima.post(`/disbursements/${id}/confirm`, { ...body, comment: '' });
    expect(noComment.status).toBe(400);
    expect(noComment.body.details.comment).toEqual(['Add a comment for the disbursement record.']);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...body, comment: 'x'.repeat(1001) })).status).toBe(400);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...body, transactionRef: '' })).status).toBe(400);
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...body, transactionRef: 'F'.repeat(41) })).status).toBe(400);
    // Dates: not in the future, not before booking.
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...body, date: localDay(new Date(Date.now() + DAY)) })).body.message).toBe('The disbursement date cannot be in the future.');
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...body, date: localDay(new Date(Date.now() - DAY)) })).body.message).toBe('The disbursement date cannot be before the booking date.');

    // A reference already recorded on another loan (any case) is refused.
    const ref = (await Application.findById(id)).ref;
    const second = await applyAndSign(await signIn('LFB0233'), products.PL._id, TERMS);
    await Application.updateOne({ _id: second }, { $set: { status: 'disbursed', disbursement: { date: new Date(), transactionRef: 'FT26294AB12', comment: 'Earlier loan paid.' } } });
    const secondRef = (await Application.findById(second)).ref;
    const dup = await halima.post(`/disbursements/${id}/confirm`, { ...body, transactionRef: 'ft26294ab12' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_TRANSACTION_REF');
    expect(dup.body.message).toBe(`This reference is already recorded on ${secondRef}.`);
    expect((await Application.findById(id)).status).toBe('pending_disbursement');

    // Marked as disbursed: the applicant and People and Culture are told; audited.
    const ok = await halima.post(`/disbursements/${id}/confirm`, { ...body, transactionRef: 'FT26294AB13' });
    expect(ok.status).toBe(200);
    const a = await Application.findById(id).lean();
    expect(a).toMatchObject({ status: 'disbursed', disbursement: { transactionRef: 'FT26294AB13', comment: 'Paid to the staff account.' } });
    expect(a.schedule.length).toBe(36);
    expect(await Notification.exists({ userId: await userId('LFB0412'), type: 'application.disbursed' })).toBeTruthy();
    expect(await Notification.exists({ userId: await userId('LFB0129'), type: 'application.disbursed_pc', text: `${ref} is disbursed (ref FT26294AB13).` })).toBeTruthy();
    expect(await Notification.exists({ userId: await userId('LFB0051'), type: 'application.disbursed_pc' })).toBeTruthy();
    const log = await AuditLog.findOne({ action: 'loan.disbursed', entityId: id }).lean();
    expect(log.description).toMatch(/FT26294AB13/);
    expect(log.description).toMatch(/Paid to the staff account\./);

    // Read-only once saved: a second confirmation is refused.
    expect((await halima.post(`/disbursements/${id}/confirm`, { ...body, transactionRef: 'FT26294AB14' })).status).toBe(409);
    // The Disbursed tab shows the record.
    const done = (await halima.get('/disbursements?tab=done')).body.data.items.find((i) => i.id === id);
    expect(done.disbursement).toMatchObject({ transactionRef: 'FT26294AB13', comment: 'Paid to the staff account.' });
  });
});

'use strict';

// Apply (BRD 9.2: FR-05 to FR-12; BRD 8: FR-33 to FR-37; BRD 10: BR-01 to BR-15;
// NS-01, NS-02). Agreement signed before submission (prompt 4.3).

const crypto = require('crypto');
const { app, seed, signIn, authed, PASSWORD, request } = require('../helpers');
const { seedProducts } = require('../fixtures/products');
const { seedAgreementTemplate } = require('../../seed/agreementTemplate');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const Decision = require('../../src/models/Decision');
const Notification = require('../../src/models/Notification');
const Staff = require('../../src/models/Staff');
const Settings = require('../../src/models/Settings');
const StoredFile = require('../../src/models/StoredFile');
const User = require('../../src/models/User');
const AuditLog = require('../../src/models/AuditLog');
const fileStore = require('../../src/services/files/fileStore');
const { localDay } = require('../../src/utils/dates');
const { attachPayslip } = require('../flows');

let products;
const api = (token) => ({
  get: (url) => request(app()).get(`/api/v1${url}`).set(authed(token)),
  post: (url, body = {}) => request(app()).post(`/api/v1${url}`).set(authed(token)).send(body),
  patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(authed(token)).send(body),
});

const CONSENTS = { truth: true, deduct: true, crb: true, sms: true };
const PL = () => String(products.PL._id);
const HE = () => String(products.HE._id);

/** A draft with the applicant's latest payslip attached (D-79) unless payslip is false. */
async function draft(person, productId, terms, { payslip = true } = {}) {
  const a = api(person.token);
  const created = await a.post('/applications', { productId });
  if (created.status !== 201) throw new Error(`create failed ${JSON.stringify(created.body)}`);
  const id = created.body.data.id;
  if (payslip) {
    const slip = await attachPayslip(person, id, payslip === true ? {} : payslip);
    if (slip.status !== 201) throw new Error(`payslip failed ${JSON.stringify(slip.body)}`);
  }
  const res = terms ? await a.patch(`/applications/${id}`, terms) : await a.get(`/applications/${id}`);
  return { id, res };
}

async function signAndSubmit(person, id, over = {}) {
  const a = api(person.token);
  const preview = await a.get(`/applications/${id}/agreement/preview`);
  if (preview.status !== 200) throw new Error(`preview failed ${JSON.stringify(preview.body)}`);
  return a.post(`/applications/${id}/sign-and-submit`, { consents: CONSENTS, accepted: true, scrolledToEnd: true, password: PASSWORD, textSha256: preview.body.data.textSha256, ...over });
}

const NEEMA_TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };

/** A running Staff Loans loan (D-87): approved and disbursed, instalments still due. */
let refNo = 90000;
async function runningLoan(staffNo, code, instalment, status = 'disbursed') {
  const ProductVersion = require('../../src/models/ProductVersion');
  const user = await User.findOne({ staffNo });
  const staff = await Staff.findOne({ staffNo });
  const version = await ProductVersion.findOne({ productId: products[code]._id, state: 'active' });
  refNo += 1;
  return Application.create({
    ref: `SL-2025-${refNo}`,
    applicantUserId: user._id,
    applicantStaffId: staff._id,
    productId: products[code]._id,
    productVersionId: version._id,
    status,
    repayment: { method: 'payroll' },
    approved: { amount: 3000000, tenor: 24, instalment },
    finalApprovedAt: new Date(Date.now() - 300 * 24 * 3600 * 1000),
    schedule: [{ n: 1, due: localDay(new Date(Date.now() + 400 * 24 * 3600 * 1000)), instalment }],
  });
}

beforeEach(async () => {
  const { users } = await seed();
  products = await seedProducts(users);
  await seedAgreementTemplate(users);
});

describe('starting an application (FR-05)', () => {
  it('an incomplete profile blocks it, with the missing details', async () => {
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).post('/applications', { productId: PL() });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ELIGIBLE');
    expect(res.body.message).toMatch(/^You can apply once your profile is complete\. Missing: .*NIDA number/);
  });

  it('a draft gets a reference and shows the calculator inputs read from the payslip', async () => {
    const neema = await signIn('LFB0412');
    const { res } = await draft(neema, PL());
    expect(res.body.data.ref).toMatch(/^SL-\d{4}-00001$/);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.payInputs).toEqual({ basic: 1850000 });
    expect(res.body.data.payslip).toMatchObject({ basic: 1850000, lfbDeductions: 0, payDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(res.body.data.checks.fieldErrors).toMatchObject({ amount: 'Enter the amount you want to borrow.', tenor: 'Enter the tenor in months.', purpose: 'Say what the loan is for.' });
    expect(res.body.data.route.key).toBe('nonmgmt');
  });

  it('only one open application per product (BR-08)', async () => {
    const neema = await signIn('LFB0412');
    const { res } = await draft(neema, PL());
    const again = await api(neema.token).post('/applications', { productId: PL() });
    expect(again.status).toBe(400);
    expect(again.body.message).toBe(`You already have an open Personal Loan application (${res.body.data.ref}). Finish or withdraw it first.`);
    expect((await api(neema.token).post('/applications', { productId: HE() })).status).toBe(201);
  });

  it('the reapply wait applies to the same product only (NS-02)', async () => {
    const appliedAt = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    await Staff.updateOne({ staffNo: 'LFB0412' }, { $set: { loanHistory: [{ productId: products.PL._id, appliedAt, approvedAt: appliedAt, ref: 'SL-2026-00015' }] } });
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).post('/applications', { productId: PL() });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^You applied for a Personal Loan on .+\. You can apply for this product again from .+ \(\d+ days\)\.$/);
    expect((await api(neema.token).post('/applications', { productId: HE() })).status).toBe(201);
  });
});

describe('live checks (BR-03 to BR-06, BR-14, BR-15)', () => {
  it('the worked example passes with the prototype figures', async () => {
    const neema = await signIn('LFB0412');
    const { res } = await draft(neema, PL(), NEEMA_TERMS);
    expect(res.body.data.quote).toMatchObject({ instalment: 136900, maxInstalment: 668750, totalInterest: 428351, processingFee: 45000, insuranceFee: 81000, pass: true });
    expect(res.body.data.checks.canSubmit).toBe(true);
  });

  it.each([
    [{ amount: 400000, tenor: 12 }, 'The minimum for Personal Loan is TZS 500,000.'],
    [{ amount: 2000000, tenor: 72 }, 'Choose a tenor between 6 and 60 months.'],
    [{ amount: 14000000, tenor: 6 }, 'The instalment of TZS 2,374,400 is above your Room of TZS 668,750 a month: 50% of Net Pay is TZS 668,750, less TZS 0 of staff loan deductions on your payslip and TZS 0 of Staff Loans loans not yet on it. Borrow up to TZS 3,942,000 over 6 months, or up to TZS 34,588,000 over 60 months.'],
  ])('%j → %s', async (terms, message) => {
    const neema = await signIn('LFB0412');
    const { res } = await draft(neema, PL(), { ...terms, purpose: 'Test' });
    expect(res.body.data.checks.canSubmit).toBe(false);
    expect(res.body.data.checks.checks).toEqual(expect.arrayContaining([typeof message === 'string' ? message : expect.stringMatching(message)]));
  });

  it('the loan must end by the retirement cutoff from the verified date of birth (D-82)', async () => {
    const joseph = await signIn('LFB0002'); // verified date of birth 1976-04-18: cutoff 2036-02-18
    const { res } = await draft(joseph, HE(), { amount: 50000000, tenor: 120, purpose: 'House' });
    const max = res.body.data.retirement.maxTenor;
    expect(res.body.data.retirement).toMatchObject({ dateOfBirth: '1976-04-18', cutoff: '2036-02-18' });
    expect(res.body.data.checks.checks).toContainEqual(expect.stringMatching(new RegExp(`^Your last instalment would be due on \\d{4}-\\d{2}-25, after your cutoff of 2036-02-18 \\(60 days before you turn 60\\)\\. The longest tenor you can take is ${max} months\\.$`)));
  });

  it('submits without the removed product fields; every loan is repaid by salary deduction (D-84)', async () => {
    const neema = await signIn('LFB0412');
    const { id, res } = await draft(neema, HE(), { amount: 3200000, tenor: 12, purpose: 'Tuition' });
    expect(res.body.data.checks.fieldErrors).toEqual({});
    const account = await api(neema.token).patch(`/applications/${id}`, { repaymentMethod: 'account' });
    expect(account.status).toBe(400);
    expect(account.body.details.repaymentMethod[0]).toMatch(/Salary deduction is the only repayment method/);
    expect(res.body.data.repayment).toEqual({ method: 'payroll' });
    expect((await signAndSubmit(neema, id)).status).toBe(200);
    const a = await Application.findById(id);
    expect(a.repayment.method).toBe('payroll');
  });

  it('Room counts every running Staff Loans loan the payslip cannot show yet (D-87, D-101)', async () => {
    const neema = await signIn('LFB0412');
    // Net Pay 1,337,500: limit 668,750. Another product's loan whose first instalment is after
    // the payslip takes 300,000; an approved, not yet disbursed one takes 200,000: Room 168,750.
    await runningLoan('LFB0412', 'VL', 300000);
    await runningLoan('LFB0412', 'HE', 200000, 'pending_disbursement');
    const { res } = await draft(neema, PL(), NEEMA_TERMS);
    expect(res.body.data.quote.combined).toMatchObject({ basis: 'payslip', cap: 668750, payslipDeductions: 0, slasNotOnPayslip: 500000, available: 168750, newInstalment: 136900, remaining: 31850 });
    expect(res.body.data.checks.canSubmit).toBe(true);
    const over = await api(neema.token).patch(`/applications/${res.body.data.id}`, { amount: 6000000 });
    expect(over.body.data.checks.canSubmit).toBe(false);
    expect(over.body.data.checks.checks).toContainEqual(expect.stringMatching(/is above your Room of TZS 168,750 a month: 50% of Net Pay is TZS 668,750, less TZS 0 of staff loan deductions on your payslip and TZS 500,000 of Staff Loans loans not yet on it/));
  });

  it("a top-up leaves out the payslip line topped up, links the product's Staff Loans loan and charges 0.5% (BR-09, D-101)", async () => {
    const neema = await signIn('LFB0412');
    const old = await runningLoan('LFB0412', 'PL', 250000);
    // At the limit of one Personal Loan, a top-up draft can still be started.
    const { id, res } = await draft(neema, PL(), { ...NEEMA_TERMS, topUp: { on: true } }, { payslip: { lfbLines: [{ label: 'Staff Loan - Personal', amount: 250000 }] } });
    expect(res.body.data.deductions.topUpLoan).toMatchObject({ ref: old.ref, instalment: 250000 });
    expect(res.body.data.quote.combined).toMatchObject({ cap: 668750, payslipDeductions: 0, slasNotOnPayslip: 0, available: 668750, topUp: true });
    expect(res.body.data.quote.processingFee).toBe(22500);
    expect(res.body.data.checks.canSubmit).toBe(true);
    // Not a top-up: the limit of one Personal Loan applies.
    const plain = await api(neema.token).patch(`/applications/${id}`, { topUp: { on: false } });
    expect(plain.body.data.checks.canSubmit).toBe(false);
  });

  it("a top-up needs the product's deduction on the payslip; a linked loan's different instalment is flagged (D-101)", async () => {
    const neema = await signIn('LFB0412');
    await runningLoan('LFB0412', 'VL', 250000);
    const { id, res } = await draft(neema, PL(), { ...NEEMA_TERMS, topUp: { on: true } });
    expect(res.body.data.checks.fieldErrors['topUp.on']).toBe('Your payslip shows no Personal Loan deduction (Staff Loan - Personal), so there is no loan to top up. Untick top-up to apply for a new loan, or attach a payslip that shows it.');
    const old = await runningLoan('LFB0412', 'PL', 250000);
    // The payslip shows 90,000 for the Personal Loan, not the 250,000 recorded here.
    await attachPayslip(neema, id, { lfbLines: [{ label: 'Staff Loan - Personal', amount: 90000 }] });
    expect((await signAndSubmit(neema, id)).status).toBe(200);
    const a = await Application.findById(id);
    expect(a.topUp).toMatchObject({ on: true, loanRef: old.ref, payslipLine: { label: 'Staff Loan - Personal', amount: 90000 } });
    expect(a.ruleFlags).toContain(`Top-up of ${old.ref}: its instalment in Staff Loans is TZS 250,000, but the payslip line Staff Loan - Personal shows TZS 90,000. Confirm the deduction with Payroll.`);
  });

  it('the maximum amount is the reverse calculation over the longest tenor, capped by the product', async () => {
    const neema = await signIn('LFB0412');
    const { res } = await draft(neema, PL(), NEEMA_TERMS);
    expect(res.body.data.quote).toMatchObject({ maxTenor: 60, maxAmount: 34588000 });
    const sa = await draft(neema, String(products.SA._id), { amount: 600000, tenor: 3, purpose: 'Rent', repaymentMethod: 'payroll' });
    expect(sa.res.body.data.quote.maxAmount).toBeLessThanOrEqual(sa.res.body.data.product.maxAmount);
  });
});

describe('payslip (D-78, D-79)', () => {
  it('is required, and Basic Pay and LFB deductions are read from it', async () => {
    const neema = await signIn('LFB0412');
    const { id, res } = await draft(neema, PL(), NEEMA_TERMS, { payslip: false });
    expect(res.body.data.checks.fieldErrors.payslip).toBe('Attach your latest payslip. Basic Pay and LFB deductions are read from it.');
    expect(res.body.data.checks.canSubmit).toBe(false);
    const up = await attachPayslip(neema, id, { basic: 2000000, lfbLines: [{ label: 'STAFF LOAN', amount: 100000 }, { label: 'LFB LOAN', amount: 50000 }] });
    expect(up.status).toBe(201);
    expect(up.body.data.payslip).toMatchObject({ basic: 2000000, lfbDeductions: 150000 });
    expect(up.body.data.payInputs).toEqual({ basic: 2000000 });
    // Basic 2,000,000: pension 200,000; PAYE 128,000 + 30% × 800,000 = 368,000; Net Pay 1,432,000 (D-87).
    expect(up.body.data.quote.payslip).toMatchObject({ pension: 200000, taxable: 1800000, tax: 368000, totalDeductions: 568000, net: 1432000 });
    // D-101: the staff loan deductions on it come off the limit of 716,000; neither line matches a product.
    expect(up.body.data.quote.combined).toMatchObject({ cap: 716000, payslipDeductions: 150000, available: 566000 });
    expect(up.body.data.quote.maxInstalment).toBe(566000);
    expect(up.body.data.deductions.lines.map((l) => [l.label, l.productId])).toEqual([['STAFF LOAN', null], ['LFB LOAN', null]]);
    expect(await AuditLog.countDocuments({ action: 'payslip.upload' })).toBe(1);
  });

  it('is refused at upload when older than 45 days (configurable)', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS, { payslip: false });
    const old = await attachPayslip(neema, id, { payDate: localDay(new Date(Date.now() - 80 * 24 * 3600 * 1000)) });
    expect(old.status).toBe(400);
    expect(old.body.code).toBe('PAYSLIP_TOO_OLD');
    expect(old.body.message).toMatch(/^Your payslip is dated \d{4}-\d{2}-\d{2}, \d+ days ago\. Attach one not older than 45 days\.$/);
    expect((await Application.findById(id)).payslip?.fileId).toBeFalsy();
    await Settings.updateOne({ _id: 'global' }, { $set: { payslipMaxAgeDays: 120 } });
    expect((await attachPayslip(neema, id, { payDate: localDay(new Date(Date.now() - 80 * 24 * 3600 * 1000)) })).status).toBe(201);
  });

  it('refuses images, someone else\'s payslip, and keeps the previous one when a new one cannot be read', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    const photo = await request(app()).post(`/api/v1/applications/${id}/payslip`).set(authed(neema.token)).attach('file', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50000)]), 'payslip.jpg');
    expect(photo.body.code).toBe('PAYSLIP_NOT_PDF');
    const juma = await signIn('LFB0233');
    const theirs = await attachPayslip(juma, id); // Juma's payslip, sent to Neema's draft by Neema
    expect(theirs.status).toBe(404);
    const { samplePayslip } = require('../../seed/samplePayslip');
    const { PRICING } = require('../fixtures/products');
    const other = await samplePayslip({ staff: { fullName: 'Juma Kassim', staffNo: 'LFB0233' }, basic: 9000000, payDate: localDay(), pricing: PRICING });
    const wrong = await request(app()).post(`/api/v1/applications/${id}/payslip`).set(authed(neema.token)).attach('file', other, 'payslip.pdf');
    expect(wrong.body.code).toBe('PAYSLIP_NOT_YOURS');
    expect(wrong.body.message).toBe("Staff Code in the Payslip doesn't match your staff number, upload correct Pay Slip");
    const kept = await api(neema.token).get(`/applications/${id}`);
    expect(kept.body.data.payslip.basic).toBe(1850000);
  });

  it('uses the payslip alone: no salary record to compare it with, no flag and no salary in the snapshot (D-100)', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS, { payslip: { basic: 1900000 } });
    await signAndSubmit(neema, id);
    const a = await Application.findById(id);
    expect(a.ruleFlags.join()).not.toMatch(/staff record/);
    expect(a.applicantSnapshot.payslip).toMatchObject({ basic: 1900000, lfbDeductions: 0 });
    expect(a.applicantSnapshot.salary).toBeUndefined();
  });
});

describe('agreement preview (FR-33, BRD 8)', () => {
  it('shows the Swahili agreement pre-filled with the terms, words and schedule', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    const res = await api(neema.token).get(`/applications/${id}/agreement/preview`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body.data.blocks);
    expect(text).toMatch(/MKATABA WA MKOPO WA MWAJIRIWA/);
    expect(text).toMatch(/Tshs 4,500,000/);
    expect(text).toMatch(/Shilingi milioni nne na elfu mia tano tu/);
    expect(text).toMatch(/Neema Mushi/);
    const table = res.body.data.blocks.find((b) => b.type === 'table');
    expect(table.rows).toHaveLength(36);
    expect(table.rows[0][2]).toBe('136,900');
    expect(res.body.data.terms).toMatchObject({ instalment: 136900, fees: 126000, totalRepayable: 4928351 });
    expect(res.body.data.template).toMatchObject({ version: '2026.11', sample: true });
  });

  it('is refused while a hard rule fails', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), { amount: 400000, tenor: 12, purpose: 'x' });
    const res = await api(neema.token).get(`/applications/${id}/agreement/preview`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_READY');
  });
});

describe('sign agreement and submit (FR-10, FR-34 to FR-37)', () => {
  it('cannot submit without every consent, the tick, reading to the end and the password', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    expect((await signAndSubmit(neema, id, { consents: { ...CONSENTS, crb: false } })).body.code).toBe('CONSENTS_REQUIRED');
    expect((await signAndSubmit(neema, id, { accepted: false })).body.code).toBe('CONSENTS_REQUIRED');
    expect((await signAndSubmit(neema, id, { scrolledToEnd: false })).body.code).toBe('NOT_READ');
    const wrong = await signAndSubmit(neema, id, { password: 'not-my-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.details.remainingAttempts).toBe(4);
    expect((await Application.findById(id)).status).toBe('draft');
  });

  it('refuses when the agreement text differs from what was read', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    const res = await signAndSubmit(neema, id, { textSha256: 'a'.repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AGREEMENT_CHANGED');
  });

  it('there is no other way to submit', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    await api(neema.token).patch(`/applications/${id}`, { status: 'pending_credit', amount: 4500000 });
    expect((await Application.findById(id)).status).toBe('draft');
  });

  it('signing submits, stores the evidence and locks the PDF', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    const preview = await api(neema.token).get(`/applications/${id}/agreement/preview`);
    const res = await signAndSubmit(neema, id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'pending_credit', statusLabel: 'Pending Credit Review', currentStage: 'credit', cycle: 1 });
    expect(res.body.data.route.stages).toEqual(['credit', 'hr', 'ceo']);

    const a = await Application.findById(id);
    const ag = await Agreement.findById(a.currentAgreementId);
    expect(ag.number).toMatch(/^MKT-\d{4}-00001$/);
    expect(ag.status).toBe('signed');
    expect(ag.textSha256).toBe(preview.body.data.textSha256);
    expect(crypto.createHash('sha256').update(ag.text, 'utf8').digest('hex')).toBe(ag.textSha256);
    expect(ag.acceptance).toMatchObject({ staffNo: 'LFB0412', fullName: 'Neema Mushi' });
    expect(ag.acceptance.ip).toBeTruthy();
    expect(ag.acceptance.at).toBeInstanceOf(Date);
    expect(ag.templateVersion).toBe('2026.11');
    expect(ag.terms).toMatchObject({ amount: 4500000, tenor: 36, instalment: 136900 });

    const pdf = await StoredFile.findById(ag.pdfFileId);
    const bytes = await fileStore.read(pdf);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(ag.pdfSha256);

    expect(a.productVersionId).toBeTruthy();
    expect(a.pricingVersionId).toBeTruthy();
    expect(a.applicantSnapshot.payslip.basic).toBe(1850000); // from the payslip; no salary record (D-100)
    expect(a.stageDueAt.getTime()).toBeGreaterThan(Date.now());
    expect((await Staff.findOne({ staffNo: 'LFB0412' })).lastAppliedAt).toBeInstanceOf(Date);
    expect(await Decision.countDocuments({ applicationId: id, action: 'submit' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'application.submit' })).toBe(1);
  });

  it('notifies the applicant and every Credit Analyst', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    await signAndSubmit(neema, id);
    const juma = await User.findOne({ staffNo: 'LFB0233' });
    const n = await Notification.findOne({ userId: juma._id, type: 'application.stage' });
    expect(n.text).toMatch(/from Neema Mushi is waiting for your Credit Analyst review \(limited details\)$/);
    expect(n.text).not.toMatch(/4,500,000|Personal Loan/);
    const me = await User.findOne({ staffNo: 'LFB0412' });
    expect(await Notification.countDocuments({ userId: me._id, type: 'application.submitted' })).toBe(1);
  });

  it('the staff member downloads their agreement and its PDF; others cannot', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    const sub = await signAndSubmit(neema, id);
    const agId = sub.body.data.agreements[0].id;
    const ag = await api(neema.token).get(`/agreements/${agId}`);
    expect(ag.body.data.text).toMatch(/MKATABA/);
    const pdf = await api(neema.token).get(`/agreements/${agId}/pdf`).buffer(true).parse((r, cb) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const aisha = await signIn('LFB0451');
    expect((await api(aisha.token).get(`/agreements/${agId}`)).status).toBe(404);
    expect((await api(aisha.token).get(`/applications/${id}`)).status).toBe(404);
  });
});

describe('routes chosen at submission (BRD 7.3, D-03)', () => {
  it.each([
    ['LFB0067', 'mgmt', ['credit', 'hr', 'ceo'], ' (limited details)'],
    ['LFB0002', 'ceo', ['credit', 'hr'], ' (limited details)'],
    ['LFB0051', 'hrhead', ['credit', 'pcm', 'ceo'], ' (limited details)'],
  ])('%s goes on the %s route', async (staffNo, route, stages, suffix) => {
    const person = await signIn(staffNo);
    const { id } = await draft(person, PL(), { amount: 5000000, tenor: 24, purpose: 'Family needs', repaymentMethod: 'payroll' });
    const res = await signAndSubmit(person, id);
    expect(res.body.data.route).toMatchObject({ key: route, stages });
    const juma = await User.findOne({ staffNo: 'LFB0233' });
    expect((await Notification.findOne({ userId: juma._id, type: 'application.stage' })).text.endsWith(`review${suffix}`)).toBe(true);
  });
});

describe('probation (NS-01)', () => {
  beforeEach(async () => {
    const joined = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    await Staff.updateOne(
      { staffNo: 'LFB0596' },
      {
        $set: {
          dateJoined: joined,
          'personal.maritalStatus': 'Single',
          'personal.dob': new Date('1998-05-20'),
          dateOfBirth: { value: '1998-05-20', verifiedAt: new Date() },
          'personal.nida': '19980520-41108-00031-26',
          'personal.address': { region: 'Dodoma', district: 'Dodoma', ward: 'Ipagala', street: 'Area D' },
          'bank.accountNo': '4010 3341 0596',
          nextOfKin: [{ firstName: 'Mwanaidi', lastName: 'Ally', relationship: 'Parent', phone: '+255715660214', address: 'Dodoma' }],
          payDeclaredAt: new Date(),
        },
      }
    );
  });

  it('a staff member on probation may apply with a reason, flagged for People and Culture', async () => {
    const rehema = await signIn('LFB0596');
    const { id, res } = await draft(rehema, PL(), { amount: 1000000, tenor: 12, purpose: 'Rent deposit', repaymentMethod: 'payroll' });
    expect(res.body.data.probation.onProbation).toBe(true);
    expect(res.body.data.checks.fieldErrors.probationReason).toBe('Say why you are applying during probation. People and Culture will verify it.');
    await api(rehema.token).patch(`/applications/${id}`, { probationReason: 'Moved to Dodoma for this job and need a rent deposit.' });
    expect((await signAndSubmit(rehema, id)).status).toBe(200);
    const a = await Application.findById(id);
    expect(a.probation).toMatchObject({ onProbation: true, reason: 'Moved to Dodoma for this job and need a rent deposit.' });
    expect(a.ruleFlags[0]).toMatch(/probation/);
  });
});

describe('documents (FR-09)', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const upload = (person, id, buffer, name) => request(app()).post(`/api/v1/applications/${id}/documents`).set(authed(person.token)).field('label', 'Payslip').attach('file', buffer, name);

  it('accepts PDF, JPG and PNG by content and refuses the rest', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL());
    expect((await upload(neema, id, PNG, 'payslip.png')).status).toBe(201);
    const fake = await upload(neema, id, Buffer.from('MZ this is not a pdf'), 'payslip.pdf');
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('FILE_TYPE');
    expect((await upload(neema, id, PNG, 'payslip.exe')).body.code).toBe('FILE_TYPE');
    const view = await api(neema.token).get(`/applications/${id}`);
    expect(view.body.data.documents).toHaveLength(1);
  });

  it('applies the configurable size limit', async () => {
    await Settings.updateOne({ _id: 'global' }, { $set: { maxUploadMb: 1 } }, { upsert: true });
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL());
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 10)]);
    expect((await upload(neema, id, big, 'big.png')).body.code).toBe('FILE_TOO_LARGE');
  });

  it('files are served only to their owner, and removal is audited', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL());
    const up = await upload(neema, id, PNG, 'payslip.png');
    const fileId = up.body.data.id;
    expect((await api(neema.token).get(`/files/${fileId}`)).status).toBe(200);
    const aisha = await signIn('LFB0451');
    expect((await api(aisha.token).get(`/files/${fileId}`)).status).toBe(404);
    await request(app()).delete(`/api/v1/applications/${id}/documents/${fileId}`).set(authed(neema.token));
    expect((await api(neema.token).get(`/applications/${id}`)).body.data.documents).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: { $in: ['document.upload', 'document.remove', 'file.download'] } })).toBe(3);
  });
});

describe('resubmit and withdraw (FR-11)', () => {
  it('a returned application is corrected and signed again; the old agreement is replaced', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    await signAndSubmit(neema, id);
    const first = (await Application.findById(id)).currentAgreementId;
    await Application.updateOne({ _id: id }, { $set: { status: 'returned', currentStage: null } }); // review arrives in M5
    await api(neema.token).patch(`/applications/${id}`, { amount: 4000000 });
    const res = await signAndSubmit(neema, id);
    expect(res.body.data).toMatchObject({ status: 'pending_credit', cycle: 2, amount: 4000000 });
    const old = await Agreement.findById(first);
    expect(old).toMatchObject({ status: 'void', voidReason: 'Replaced by a new signed version on resubmission' });
    expect(await Decision.countDocuments({ applicationId: id, action: 'resubmit' })).toBe(1);
    expect(res.body.data.agreements.map((a) => a.status)).toEqual(['signed', 'void']);
  });

  it('withdrawing voids the agreement', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    await signAndSubmit(neema, id);
    const res = await api(neema.token).post(`/applications/${id}/withdraw`, { reason: 'No longer needed' });
    expect(res.body.data.status).toBe('withdrawn');
    expect(res.body.data.agreements[0]).toMatchObject({ status: 'void', voidReason: 'Application withdrawn' });
    // A new application for the product is possible again (BR-08).
    expect((await api(neema.token).post('/applications', { productId: PL() })).status).toBe(201);
  });

  it('cancelling a draft that was never submitted succeeds and the application stays readable', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    expect((await Application.findById(id)).pricingVersionId).toBeUndefined();
    const res = await api(neema.token).post(`/applications/${id}/withdraw`, { reason: 'Draft cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'withdrawn', withdrawable: false, editable: false });
    const again = await api(neema.token).get(`/applications/${id}`);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('withdrawn');
  });

  it('a product deactivated after the draft started cannot be submitted', async () => {
    const neema = await signIn('LFB0412');
    const { id } = await draft(neema, PL(), NEEMA_TERMS);
    const ProductVersion = require('../../src/models/ProductVersion');
    await ProductVersion.create({ ...(await ProductVersion.findOne({ productId: products.PL._id }).lean()), _id: undefined, version: 2, changeType: 'deactivate', state: 'inactive', liveFrom: new Date(), approvedAt: new Date(), effectiveFrom: new Date() });
    const res = await api(neema.token).get(`/applications/${id}/agreement/preview`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_UNAVAILABLE');
    expect(localDay()).toBeTruthy();
  });
});

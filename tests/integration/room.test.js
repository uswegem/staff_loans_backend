'use strict';

// Room (D-101): the combined limit (50% of Net Pay) less the staff loan deductions on the
// payslip and the SLAS loans the payslip cannot show yet. A top-up is of a payslip
// deduction, recorded in Staff Loans or not. The same calculation runs in the live view,
// at submission, at every approval and before disbursement.
//
// Neema Mushi: Basic Pay 1,850,000 → Net Pay 1,337,500 → combined limit 668,750.
// Fixture products: Personal Loan "Staff Loan - Personal", Vehicle Loan "Staff Loan - Vehicle".

const { api, seedAll, attachPayslip, sign, decide, signIn, runningLoan, CRB, HR_OK } = require('../flows');
const Application = require('../../src/models/Application');
const { capCheck } = require('../../src/services/applications/capCheck');
const { runningLoans } = require('../../src/services/applications/rules');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(120000);

let products;
const LIMIT = 668750;
const NEEMA = { amount: 1000000, tenor: 12, purpose: 'School fees' };
const PL_LINE = (amount) => ({ label: 'Staff Loan - Personal', amount });
const VL_LINE = (amount) => ({ label: 'Staff Loan - Vehicle', amount });
const daysAgo = (n) => localDay(new Date(Date.now() - n * 86400000));

beforeEach(async () => {
  ({ products } = await seedAll());
});

/** A Personal Loan draft for Neema with a payslip; returns { neema, id, view }. */
async function draft({ lines = [], topUp, terms = NEEMA, payDate } = {}) {
  const neema = await signIn('LFB0412');
  const a = api(neema.token);
  const id = (await a.post('/applications', { productId: String(products.PL._id) })).body.data.id;
  const slip = await attachPayslip(neema, id, { lfbLines: lines, ...(payDate ? { payDate } : {}) });
  if (slip.status !== 201) throw new Error(`payslip: ${JSON.stringify(slip.body)}`);
  const res = await a.patch(`/applications/${id}`, { ...terms, ...(topUp ? { topUp } : {}) });
  return { neema, id, view: res.body.data };
}

describe('Room for a new loan (D-101)', () => {
  it('subtracts every staff loan deduction on the payslip, each line matched to its product', async () => {
    const { view } = await draft({ lines: [PL_LINE(150000), VL_LINE(100000)] });
    expect(view.quote.combined).toMatchObject({ cap: LIMIT, payslipDeductions: 250000, slasNotOnPayslip: 0, available: 418750, topUp: false });
    expect(view.quote.maxInstalment).toBe(418750);
    expect(view.deductions.lines).toEqual([
      { label: 'Staff Loan - Personal', amount: 150000, productId: String(products.PL._id), product: 'Personal Loan' },
      { label: 'Staff Loan - Vehicle', amount: 100000, productId: String(products.VL._id), product: 'Vehicle Loan' },
    ]);
  });

  it('matches labels whatever the case, spacing or punctuation, and the longer label wins over "Staff Loan"', async () => {
    const { view } = await draft({ lines: [{ label: 'STAFF LOAN PERSONAL', amount: 120000 }, { label: 'Staff  Loan—Vehicle', amount: 80000 }] });
    expect(view.deductions.lines.map((l) => l.product)).toEqual(['Personal Loan', 'Vehicle Loan']);
    expect(view.deductions.lines[0].label).toBe('STAFF LOAN PERSONAL');
    expect(view.quote.combined.payslipDeductions).toBe(200000);
  });

  it('counts a line that matches no product, and flags it for reviewers', async () => {
    const { neema, id, view } = await draft({ lines: [PL_LINE(150000), { label: 'Staff Loan', amount: 70000 }] });
    expect(view.deductions.lines[1]).toMatchObject({ label: 'Staff Loan', amount: 70000, productId: null });
    expect(view.quote.combined.available).toBe(LIMIT - 220000);
    await sign(neema, id);
    expect((await Application.findById(id)).ruleFlags).toContain('The payslip shows a staff loan deduction that matches no product: Staff Loan, TZS 70,000. It is counted against Room; confirm it with Payroll.');
  });

  it('never goes below 0, and an instalment above Room fails affordability', async () => {
    const { view } = await draft({ lines: [PL_LINE(500000), VL_LINE(250000)] });
    expect(view.quote.combined).toMatchObject({ payslipDeductions: 750000, available: 0 });
    expect(view.quote).toMatchObject({ maxInstalment: 0, maxAmount: 0, pass: false });
    expect(view.checks.checks.join()).toMatch(/is above your Room of TZS 0 a month/);
    expect(view.checks.canSubmit).toBe(false);
  });
});

describe('SLAS loans not yet on the payslip (D-101)', () => {
  it('counts a loan pending disbursement and one whose first instalment is after the pay date', async () => {
    await runningLoan('LFB0412', products.VL._id, 60000, 'pending_disbursement');
    await runningLoan('LFB0412', products.VL._id, 40000, 'disbursed', { firstDue: localDay(new Date(Date.now() + 45 * 86400000)) });
    const active = await Application.find({ status: { $in: ['pending_disbursement', 'disbursed'] } }).lean();
    expect(runningLoans(active, null, localDay(new Date())).map((a) => a.approved.instalment).sort((a, b) => a - b)).toEqual([40000, 60000]);
    const { view } = await draft({ lines: [PL_LINE(100000)], payDate: daysAgo(5) });
    // The PDF reader normalizes the payslip to its payroll month-end date.
    expect(view.payslip.payDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.deductions.slas.map((l) => ({ instalment: l.instalment, status: l.status, firstDue: l.firstDue })).sort((a, b) => a.instalment - b.instalment)).toEqual([{ instalment: 40000, status: 'disbursed', firstDue: expect.any(String) }, { instalment: 60000, status: 'pending_disbursement', firstDue: expect.any(String) }]);
    expect(view.deductions.slas.map((l) => l.instalment).sort((a, b) => a - b)).toEqual([40000, 60000]);
    expect(view.quote.combined).toMatchObject({ payslipDeductions: 100000, slasNotOnPayslip: 100000, available: LIMIT - 200000 });
    expect(view.deductions.slas.map((l) => l.instalment).sort()).toEqual([40000, 60000]);
  });

  it('does not count twice a disbursed loan the payslip already shows', async () => {
    await runningLoan('LFB0412', products.VL._id, 100000, 'disbursed', { firstDue: daysAgo(40) });
    const { view } = await draft({ lines: [VL_LINE(100000)], payDate: daysAgo(5) });
    expect(view.quote.combined).toMatchObject({ payslipDeductions: 100000, slasNotOnPayslip: 0, available: LIMIT - 100000 });
    expect(view.deductions.slas).toEqual([]);
  });

  it('counts only the new instalment when a SLAS top-up has replaced a payslip line since the pay date', async () => {
    const top = await runningLoan('LFB0412', products.VL._id, 180000, 'disbursed', { firstDue: localDay(new Date(Date.now() + 45 * 86400000)) });
    await Application.updateOne({ _id: top._id }, { $set: { topUp: { on: true, payslipLine: VL_LINE(100000) } } });
    const { view } = await draft({ lines: [VL_LINE(100000), PL_LINE(50000)], payDate: daysAgo(5) });
    expect(view.deductions.lines[0].replaced).toBe(top.ref);
    expect(view.quote.combined).toMatchObject({ payslipDeductions: 50000, slasNotOnPayslip: 180000, available: LIMIT - 230000 });
  });
});

describe('top-ups of payslip deductions (D-101)', () => {
  it('worked out without a SLAS record: Room leaves out the line topped up', async () => {
    const { neema, id, view } = await draft({ lines: [PL_LINE(150000), VL_LINE(100000)], topUp: { on: true } });
    expect(view.checks.fieldErrors).toEqual({});
    expect(view.deductions.topUpLine).toBe(0);
    expect(view.quote.combined).toMatchObject({ payslipDeductions: 100000, available: LIMIT - 100000, topUp: true });
    await sign(neema, id);
    const app = await Application.findById(id).lean();
    expect(app.topUp).toMatchObject({ on: true, payslipLine: PL_LINE(150000), instalment: 150000 });
    expect(app.topUp.applicationId).toBeUndefined();
  });

  it('is refused when the payslip shows no deduction for the product', async () => {
    const { view } = await draft({ lines: [VL_LINE(100000)], topUp: { on: true } });
    expect(view.checks.fieldErrors['topUp.on']).toBe('Your payslip shows no Personal Loan deduction (Staff Loan - Personal), so there is no loan to top up. Untick top-up to apply for a new loan, or attach a payslip that shows it.');
    expect(view.checks.canSubmit).toBe(false);
  });

  it('with several lines for the product, the applicant chooses one; the others count', async () => {
    const lines = [PL_LINE(150000), PL_LINE(50000), VL_LINE(100000)];
    const first = await draft({ lines, topUp: { on: true } });
    expect(first.view.checks.fieldErrors['topUp.payslipLine']).toBe('Your payslip shows 2 Personal Loan deductions. Choose the one being topped up.');
    const chosen = await api(first.neema.token).patch(`/applications/${first.id}`, { topUp: { on: true, payslipLine: PL_LINE(50000) } });
    expect(chosen.body.data.checks.fieldErrors).toEqual({});
    expect(chosen.body.data.deductions.topUpLine).toBe(1);
    expect(chosen.body.data.quote.combined).toMatchObject({ payslipDeductions: 250000, available: LIMIT - 250000 });
  });

  it('keeps linking a running SLAS loan of the product, and flags a different instalment', async () => {
    const old = await runningLoan('LFB0412', products.PL._id, 140000, 'disbursed', { firstDue: daysAgo(60) });
    const { neema, id, view } = await draft({ lines: [PL_LINE(150000)], topUp: { on: true }, payDate: daysAgo(5) });
    expect(view.deductions.topUpLoan).toMatchObject({ applicationId: String(old._id), ref: old.ref });
    expect(view.quote.combined).toMatchObject({ payslipDeductions: 0, slasNotOnPayslip: 0, available: LIMIT });
    await sign(neema, id);
    const app = await Application.findById(id).lean();
    expect(String(app.topUp.applicationId)).toBe(String(old._id));
    expect(app.topUp.loanRef).toBe(old.ref);
    expect(app.ruleFlags).toContain(`Top-up of ${old.ref}: its instalment in Staff Loans is TZS 140,000, but the payslip line Staff Loan - Personal shows TZS 150,000. Confirm the deduction with Payroll.`);
  });
});

describe('the same Room everywhere (D-101)', () => {
  it('the Credit Analyst is told only that the limit no longer allows it, with no figures (D-86)', async () => {
    const { neema, id } = await draft({ lines: [PL_LINE(150000), VL_LINE(100000)] });
    await sign(neema, id);
    await runningLoan('LFB0412', products.VL._id, 400000, 'pending_disbursement');
    const res = await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    expect(res.body.code).toBe('AFFORDABILITY_EXCEEDED');
    expect(res.body.message).not.toMatch(/TZS|payslip/);
  });

  it('in the live view, at submission, at approval and before disbursement', async () => {
    const { neema, id, view } = await draft({ lines: [PL_LINE(150000), VL_LINE(100000)] });
    await sign(neema, id);
    const submitted = await Application.findById(id);
    expect(submitted.calcSnapshot.combined).toMatchObject({ payslipDeductions: 250000, available: view.quote.combined.available });
    const atApproval = await capCheck(submitted, { amount: NEEMA.amount, tenor: NEEMA.tenor });
    expect(atApproval).toMatchObject({ ok: true, combined: { payslipDeductions: 250000, available: view.quote.combined.available } });

    // Credit approves while it fits.
    expect((await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB })).status).toBe(200);

    // A loan approved meanwhile and not yet paid out takes Room away from approval and disbursement alike.
    await runningLoan('LFB0412', products.VL._id, 400000, 'pending_disbursement');
    const later = await capCheck(submitted, { amount: NEEMA.amount, tenor: NEEMA.tenor });
    expect(later).toMatchObject({ ok: false, code: 'AFFORDABILITY_EXCEEDED', combined: { slasNotOnPayslip: 400000, available: 18750 } });
    const hr = await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
    expect(hr.body.code).toBe('AFFORDABILITY_EXCEEDED');
    expect(hr.body.message).toBe('This application cannot be approved now. The instalment of TZS 86,100 no longer fits Room: 50% of Net Pay is TZS 668,750, less TZS 250,000 of staff loan deductions on the payslip and TZS 400,000 of Staff Loans loans not yet on it, leaving TZS 18,750. Return or reject it.');
  });
});

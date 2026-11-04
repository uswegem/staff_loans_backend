'use strict';

// BRD 10, BR-14, BR-15, against the prototype's worked example (handover §7).

const calc = require('../../src/services/calc/loanCalculator');
const { PRICING } = require('../fixtures/products');

const neema = { basic: 1850000 };

describe('payslip and limit (D-78, D-87)', () => {
  const q = calc.quote({ amount: 4500000, tenor: 36, pay: neema, pricing: PRICING, startDay: '2026-10-29', maxTenor: 60, maxAmountCap: 300000000 });

  it('matches the worked example (no other loans in Staff Loans)', () => {
    expect(q.payslip).toEqual({ basic: 1850000, pension: 185000, taxable: 1665000, tax: 327500, totalDeductions: 512500, net: 1337500 });
    expect(q.combined).toMatchObject({ basis: 'payslip', cap: 668750, payslipDeductions: 0, slasNotOnPayslip: 0, available: 668750, newInstalment: 136900, remaining: 531850 });
    expect(q.maxInstalment).toBe(668750);
    expect(q.instalment).toBe(136900);
    expect(q.totalInterest).toBe(428351);
    expect(q.totalRepayable).toBe(4928351);
    expect(q.processingFee).toBe(45000);
    expect(q.insuranceFee).toBe(81000);
    expect(q.pass).toBe(true);
  });

  it('pension is 10% of basic; taxable pay is basic less pension; net pay is basic less pension and PAYE', () => {
    const p = calc.payslip({ basic: 1000000 }, PRICING);
    expect(p).toMatchObject({ pension: 100000, taxable: 900000, tax: 103000, totalDeductions: 203000, net: 797000 }); // PAYE 68,000 + 25% × 140,000
  });
});

describe('Room: the combined limit less payslip deductions and SLAS loans not yet on it (D-87, D-101)', () => {
  // Net Pay 9,691,734 gives a combined limit of 4,845,867, the brief's figure.
  const NET = 9691734;

  it.each([
    ['a new loan: every deduction counts', { lines: [{ amount: 3639827 }] }, 3639827, 1206040],
    ['a top-up with all 3,639,827 on the product topped up', { lines: [{ amount: 3639827 }], topUpLine: 0 }, 0, 4845867],
    ['a top-up with 500,000 on the product topped up and 3,139,827 on others', { lines: [{ amount: 500000 }, { amount: 3139827 }], topUpLine: 0 }, 3139827, 1706040],
  ])('%s', (_, lines, subtracted, expected) => {
    const inputs = calc.roomInputs(lines);
    expect(inputs.payslipDeductions).toBe(subtracted);
    expect(calc.combinedCap(NET, 5000, inputs)).toMatchObject({ cap: 4845867, payslipDeductions: subtracted, slasNotOnPayslip: 0, available: expected });
  });

  it('never goes below 0; an instalment above Room fails', () => {
    const inputs = calc.roomInputs({ lines: [{ amount: 4000000 }], slas: [{ applicationId: 'a', instalment: 900000 }] });
    expect(calc.combinedCap(NET, 5000, inputs, 1)).toMatchObject({ available: 0, remaining: -1 });
    const q = calc.quote({ amount: 1000000, tenor: 12, pay: neema, existing: calc.roomInputs({ lines: [{ amount: 700000 }] }), pricing: PRICING, maxTenor: 60 });
    expect(q).toMatchObject({ maxInstalment: 0, maxAmount: 0, pass: false });
  });

  it('counts SLAS loans not yet on the payslip, but not the one topped up nor a replaced line', () => {
    const slas = [{ applicationId: 'old', instalment: 120000 }, { applicationId: 'other', instalment: 80000 }];
    expect(calc.roomInputs({ slas })).toMatchObject({ slasNotOnPayslip: 200000, topUp: false });
    expect(calc.roomInputs({ slas, topUpLoanId: 'old' }).slasNotOnPayslip).toBe(80000);
    expect(calc.roomInputs({ lines: [{ amount: 100000, replaced: 'SL-2026-00001' }, { amount: 50000 }] }).payslipDeductions).toBe(50000);
  });

  it('shrinks the maximum instalment and amount: what fits passes, one step more does not', () => {
    const alone = calc.quote({ amount: 0, tenor: 0, pay: neema, pricing: PRICING, maxTenor: 60, maxAmountCap: 300000000 });
    const existing = calc.roomInputs({ lines: [{ amount: 401250 }] });
    const withLoan = calc.quote({ amount: 0, tenor: 0, pay: neema, existing, pricing: PRICING, maxTenor: 60, maxAmountCap: 300000000 });
    expect(withLoan.maxInstalment).toBe(668750 - 401250);
    expect(withLoan.maxAmount).toBeLessThan(alone.maxAmount);
    expect(calc.quote({ amount: withLoan.maxAmount, tenor: 60, pay: neema, existing, pricing: PRICING }).pass).toBe(true);
    expect(calc.quote({ amount: withLoan.maxAmount + 100000, tenor: 60, pay: neema, existing, pricing: PRICING }).pass).toBe(false);
  });

  it('a top-up at the limit: the line topped up is left out and the new instalment replaces it', () => {
    const atLimit = calc.quote({ amount: 1000000, tenor: 12, pay: neema, existing: calc.roomInputs({ lines: [{ amount: 668750 }] }), pricing: PRICING });
    expect(atLimit.pass).toBe(false);
    const topUp = calc.quote({ amount: 1000000, tenor: 12, topUp: true, pay: neema, existing: calc.roomInputs({ lines: [{ amount: 668750 }], topUpLine: 0 }), pricing: PRICING });
    expect(topUp.combined).toMatchObject({ payslipDeductions: 0, available: 668750, topUp: true });
    expect(topUp.pass).toBe(true);
    expect(topUp.combined.remaining).toBe(668750 - topUp.instalment);
    expect(topUp.processingFee).toBe(5000); // 0.5% on a top-up
  });
});

describe('maximum amount by reverse calculation (D-78)', () => {
  it('is the largest amount whose instalment fits the limit over the longest tenor', () => {
    const q = calc.quote({ amount: 0, tenor: 0, pay: neema, pricing: PRICING, maxTenor: 60, maxAmountCap: 300000000 });
    expect(q.maxTenor).toBe(60);
    expect(calc.instalment(q.maxAmount, 60, PRICING.interestBps, PRICING.instalmentRounding)).toBeLessThanOrEqual(668750);
    expect(calc.instalment(q.maxAmount + 1000, 60, PRICING.interestBps, PRICING.instalmentRounding)).toBeGreaterThan(668750);
    expect(q.maxAmount).toBe(34588000);
  });

  it('is capped at the product maximum and follows the chosen tenor', () => {
    expect(calc.maxAmount(668750, 60, 600, 100, { cap: 5000000 })).toBe(5000000);
    const q = calc.quote({ amount: 4500000, tenor: 36, pay: neema, pricing: PRICING, maxTenor: 60, maxAmountCap: 300000000 });
    expect(q.maxAmountAtTenor).toBeLessThan(q.maxAmount);
    expect(calc.instalment(q.maxAmountAtTenor, 36, 600, 100)).toBeLessThanOrEqual(668750);
  });

  it('is 0 without pay or tenor', () => {
    expect(calc.maxAmount(0, 60, 600)).toBe(0);
    expect(calc.maxAmount(500000, 0, 600)).toBe(0);
  });
});

describe('PAYE bands', () => {
  it.each([
    [200000, 0],
    [270000, 0],
    [400000, 10400],
    [520000, 20000],
    [700000, 56000],
    [1000000, 128000],
    [1665000, 327500],
  ])('taxable %i → %i', (taxable, tax) => {
    expect(calc.paye(taxable, PRICING.payeBands)).toBe(tax);
  });
});

describe('instalment and fees (BR-14, BR-15)', () => {
  it('rounds up to the nearest TZS 100', () => {
    expect(calc.instalment(1000000, 12, 600, 100) % 100).toBe(0);
    expect(calc.instalment(1000000, 12, 600, 100)).toBe(86100);
  });

  it('handles zero interest', () => {
    expect(calc.instalment(1200000, 12, 0, 100)).toBe(100000);
  });

  it.each([
    [10000000, 36, 180000],
    [10000000, 18, 90000],
  ])('insurance on %i over %i months is %i (BR-15, decision 20)', (amount, tenor, fee) => {
    expect(calc.quote({ amount, tenor, pay: neema, pricing: PRICING }).insuranceFee).toBe(fee);
  });

  it('flags an instalment above the limit (BR-06)', () => {
    const q = calc.quote({ amount: 50000000, tenor: 12, pay: neema, pricing: PRICING });
    expect(q.pass).toBe(false);
    expect(q.headroom).toBeLessThan(0);
  });
});

describe('repayment schedule (FR-24)', () => {
  const rows = calc.schedule(4500000, 36, 600, 100, '2026-11-25');

  it('has one row per month on the due day, ending at zero', () => {
    expect(rows).toHaveLength(36);
    expect(rows[0]).toMatchObject({ n: 1, due: '2026-11-25', interest: 22500, principal: 114400, payment: 136900, balance: 4385600 });
    expect(rows[1].due).toBe('2026-12-25');
    expect(rows[2].due).toBe('2027-01-25');
    expect(rows.at(-1).balance).toBe(0);
    expect(rows.reduce((s, r) => s + r.principal, 0)).toBe(4500000);
  });

  it('first instalment is the 25th of the following month, clamped to short months', () => {
    expect(calc.firstDueDate('2026-10-29')).toBe('2026-11-25');
    expect(calc.firstDueDate('2026-12-31')).toBe('2027-01-25');
    expect(calc.firstDueDate('2027-01-15', 31)).toBe('2027-02-28');
  });

  it('adds months to calendar days', () => {
    expect(calc.addMonthsToDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(calc.addMonthsToDay('2026-11-25', 14)).toBe('2028-01-25');
  });
});

'use strict';

// BRD 10, BR-14, BR-15, against the prototype's worked example (handover §7).

const calc = require('../../src/services/calc/loanCalculator');
const { PRICING } = require('../../seed/products');

const neema = { basic: 1850000, allowances: 220000, commission: 0, medical: 0, otherDeductions: 0, existingLfbInstalments: 0, otherBankInstalments: 0 };

describe('payslip and limit (BRD 10 steps 1 to 5)', () => {
  const q = calc.quote({ amount: 4500000, tenor: 36, pay: neema, pricing: PRICING, startDay: '2026-10-29' });

  it('matches the prototype worked example', () => {
    expect(q.payslip).toMatchObject({ basic: 1850000, pension: 185000, taxable: 1665000, tax: 327500, net: 1337500 });
    expect(q.adjusted).toBe(1337500);
    expect(q.maxInstalment).toBe(668750);
    expect(q.instalment).toBe(136900);
    expect(q.totalInterest).toBe(428351);
    expect(q.totalRepayable).toBe(4928351);
    expect(q.processingFee).toBe(45000);
    expect(q.insuranceFee).toBe(81000);
    expect(q.pass).toBe(true);
  });

  it('ignores allowances (decision 26)', () => {
    const more = calc.quote({ amount: 4500000, tenor: 36, pay: { ...neema, allowances: 5000000 }, pricing: PRICING, startDay: '2026-10-29' });
    expect(more.maxInstalment).toBe(q.maxInstalment);
  });

  it('subtracts existing staff loans, medical aid, other deductions and other bank loans', () => {
    const p = calc.payslip({ ...neema, existingLfbInstalments: 100000, medical: 20000, otherDeductions: 5000, otherBankInstalments: 150000 }, PRICING);
    expect(p.net).toBe(1337500 - 100000 - 25000 - 150000);
  });

  it('adds back the instalment of the loan being topped up (step 4, BR-09)', () => {
    const t = calc.quote({ amount: 4500000, tenor: 36, topUp: true, topUpInstalment: 90000, pay: { ...neema, existingLfbInstalments: 90000 }, pricing: PRICING, startDay: '2026-10-29' });
    expect(t.addBack).toBe(90000);
    expect(t.adjusted).toBe(1337500);
    expect(t.processingFee).toBe(22500); // 0.5% on a top-up
  });

  it('commission is taxable pay', () => {
    expect(calc.payslip({ basic: 1000000, commission: 200000 }, PRICING).taxable).toBe(1100000);
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

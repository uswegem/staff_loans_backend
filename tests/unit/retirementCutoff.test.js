'use strict';

// Retirement cutoff (D-82): verified date of birth + 60 years − 60 days, in calendar
// arithmetic; the tenor is capped by the whole instalments that fall on or before it.

const calc = require('../../src/services/calc/loanCalculator');
const rules = require('../../src/services/applications/rules');
const { cutoffProblem } = require('../../src/services/staff/retirement');
const { ageOn, problemWith } = require('../../src/services/staff/dobService');

const SETTINGS = { retirementAge: 60, retirementBufferDays: 60, firstDueDay: 25, dobMinAge: 18, dobMaxAge: 60 };
const VERSION = { name: 'Personal Loan', minTenor: 6, maxTenor: 60 };
const staff = (dob, extra = {}) => ({ dateOfBirth: dob ? { value: dob, verifiedAt: new Date() } : {}, ...extra });

describe('cutoff date', () => {
  it('is the 60th birthday less 60 calendar days', () => {
    expect(calc.retirementCutoff('1985-06-15', 60, 60)).toBe('2045-04-16');
    expect(calc.retirementCutoff('1990-01-01', 60, 60)).toBe('2049-11-02'); // across a year end
  });

  it('a 29 February birthday: 29 February in a leap year, 28 February otherwise', () => {
    expect(calc.retirementCutoff('1980-02-29', 60, 0)).toBe('2040-02-29');
    expect(calc.retirementCutoff('1980-02-29', 60, 60)).toBe('2039-12-31');
    expect(calc.retirementCutoff('1996-02-29', 61, 0)).toBe('2057-02-28');
    expect(calc.retirementCutoff('1996-02-29', 61, 60)).toBe('2056-12-30'); // 2056 is a leap year
  });

  it('age and buffer come from the settings', () => {
    expect(calc.retirementCutoff('1985-06-15', 65, 30)).toBe('2050-05-16');
    expect(rules.cutoffFor(staff('1985-06-15'), { retirementAge: 62, retirementBufferDays: 0 })).toBe('2047-06-15');
  });

  it('is null without a verified date of birth: a pending one is never used', () => {
    expect(rules.cutoffFor({ dateOfBirth: { pending: { changeId: 'x', proposed: '1985-06-15' } } }, SETTINGS)).toBeNull();
  });
});

describe('instalments before the cutoff', () => {
  it('counts whole instalments falling on or before the cutoff', () => {
    expect(calc.instalmentsBefore('2027-04-25', '2026-12-25')).toBe(5); // Dec, Jan, Feb, Mar, Apr
    expect(calc.instalmentsBefore('2027-04-24', '2026-12-25')).toBe(4);
    expect(calc.instalmentsBefore('2026-12-24', '2026-12-25')).toBe(0);
  });

  it('the maximum tenor is the lower of the product maximum and what fits', () => {
    // Cutoff 2045-04-16; from 2026-11-01 the first instalment is 2026-12-25 and the last that fits 2045-03-25.
    const s = staff('1985-06-15');
    expect(rules.longestTenor(VERSION, s, '2026-11-01', 25, SETTINGS)).toBe(60); // the product maximum is lower
    expect(rules.longestTenor({ ...VERSION, maxTenor: 300 }, s, '2026-11-01', 25, SETTINGS)).toBe(220);
    expect(calc.addMonthsToDay('2026-12-25', 219)).toBe('2045-03-25');
  });

  it('a staff member very close to the cutoff gets only what fits', () => {
    // Cutoff 2027-04-16: first instalment 2026-12-25, last that fits 2027-03-25 → 4 instalments.
    const s = staff('1967-06-15');
    expect(calc.retirementCutoff('1967-06-15', 60, 60)).toBe('2027-04-16');
    expect(rules.longestTenor({ ...VERSION, minTenor: 1 }, s, '2026-11-01', 25, SETTINGS)).toBe(4);
    expect(cutoffProblem(s, { ...VERSION, minTenor: 1 }, SETTINGS, '2026-11-01')).toBeNull();
    expect(cutoffProblem(s, VERSION, SETTINGS, '2026-11-01')).toBe('Personal Loan needs at least 6 months, but only 4 monthly instalments fall on or before 2027-04-16 (60 days before you turn 60).');
  });
});

describe('the cutoff check on the schedule', () => {
  const s = staff('1967-06-15'); // cutoff 2027-04-16
  const lastDue = (tenor) => calc.schedule(1000000, tenor, 600, 100, calc.firstDueDate('2026-11-01', 25)).at(-1).due;
  const v = { ...VERSION, minTenor: 1 };

  it('a last instalment exactly on the cutoff is allowed', () => {
    const exact = staff('1967-06-15');
    // With buffer 0 the cutoff is 2027-06-15; with the due day 15 the 7th instalment falls exactly on it.
    const settings = { ...SETTINGS, retirementBufferDays: 0, firstDueDay: 15 };
    const last = calc.schedule(1000000, 7, 600, 100, calc.firstDueDate('2026-11-01', 15)).at(-1).due;
    expect(last).toBe('2027-06-15');
    expect(rules.cutoffCheck({ staff: exact, settings, version: v, tenor: 7, lastDue: last, startDay: '2026-11-01' })).toMatchObject({ ok: true, cutoff: '2027-06-15', maxTenor: 7 });
  });

  it('one instalment past it is refused with the cutoff and the maximum tenor', () => {
    expect(rules.cutoffCheck({ staff: s, settings: SETTINGS, version: v, tenor: 4, lastDue: lastDue(4), startDay: '2026-11-01' }).ok).toBe(true);
    const over = rules.cutoffCheck({ staff: s, settings: SETTINGS, version: v, tenor: 5, lastDue: lastDue(5), startDay: '2026-11-01' });
    expect(over).toMatchObject({ ok: false, code: 'CUTOFF_EXCEEDED', cutoff: '2027-04-16', lastDue: '2027-04-25', maxTenor: 4 });
    expect(over.message).toBe('The last instalment would be due on 2027-04-25, after the cutoff of 2027-04-16 (60 days before you turn 60). The longest tenor allowed is 4 months; 5 months is too long.');
  });
});

describe('eligibility from the date of birth', () => {
  it('no verified date of birth: cannot apply, with what to do', () => {
    expect(cutoffProblem(staff(null), VERSION, SETTINGS, '2026-11-01')).toBe('Add your date of birth in your profile (Personal details) and wait for People and Culture to verify it. You can apply once it is verified.');
    expect(cutoffProblem({ dateOfBirth: { pending: { changeId: 'c1', proposed: '1990-03-01' } } }, VERSION, SETTINGS, '2026-11-01')).toBe('Your date of birth (1990-03-01) is waiting for People and Culture to verify it. You can apply once it is verified.');
  });

  it('already past the cutoff, or no instalment fits: not eligible', () => {
    expect(cutoffProblem(staff('1966-11-20'), VERSION, SETTINGS, '2026-11-01')).toBe('You cannot take a new loan: it must be repaid by 2026-09-21 (60 days before you turn 60), and no monthly instalment falls on or before that date.');
    expect(cutoffProblem(staff('1967-02-20'), { ...VERSION, minTenor: 1 }, SETTINGS, '2026-11-01')).toMatch(/^You cannot take a new loan: it must be repaid by 2026-12-22/);
  });
});

describe('date of birth validation', () => {
  it('not in the future and an age of 18 to 60 on the day it is entered', () => {
    expect(problemWith('2030-01-01', SETTINGS, '2026-11-01')).toBe('The date of birth cannot be in the future.');
    expect(problemWith('2010-01-01', SETTINGS, '2026-11-01')).toBe('This date of birth gives an age of 16. It must be between 18 and 60.');
    expect(problemWith('1960-01-01', SETTINGS, '2026-11-01')).toBe('This date of birth gives an age of 66. It must be between 18 and 60.');
    expect(problemWith('1990-02-30', SETTINGS, '2026-11-01')).toBe('Enter a real date of birth.');
    expect(problemWith('1990-02-28', SETTINGS, '2026-11-01')).toBeNull();
  });

  it('counts whole years', () => {
    expect(ageOn('1990-11-02', '2026-11-01')).toBe(35);
    expect(ageOn('1990-11-01', '2026-11-01')).toBe(36);
  });
});

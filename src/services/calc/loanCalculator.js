'use strict';

// Loan calculator (BRD 10, BR-14, BR-15). Pure functions with no dependencies, used by
// the API and, through a generated copy, by the web app's live calculator
// (scripts/sync-calc.js). Money is integer shillings; rates are basis points
// (DECISIONS D-07). Dates are calendar days as 'YYYY-MM-DD' strings.
//
// Affordability (DECISIONS D-78, D-87, D-101):
//   Pension = 10% of Basic Pay; Taxable Pay = Basic Pay − Pension; PAYE on Taxable Pay
//   (Tanzania bands); Total Deductions = Pension + PAYE; Net Pay = Basic Pay − Total
//   Deductions. The combined limit is 50% of Net Pay for all staff loans together.
//   Room, the instalment the staff member can afford, is the combined limit less the staff
//   loan deductions on the payslip (for a top-up, less those other than the line topped
//   up) and less the SLAS loans the payslip cannot show yet. Basic Pay comes from the payslip.
//
// Worked example (Neema Mushi, basic 1,850,000, no other SLAS loans, TZS 4,500,000 over
// 36 months): pension 185,000; PAYE 327,500; net 1,337,500; cap 668,750; instalment
// 136,900; total interest 428,351; processing 45,000; insurance 81,000.

const BPS = 10000;

/** PAYE from taxable pay: base + rate × (taxable − from) of the highest band reached. */
function paye(taxable, bands) {
  let tax = 0;
  for (const b of bands) {
    if (taxable >= b.from) tax = b.base + Math.round((b.rateBps * (taxable - b.from)) / BPS);
  }
  return Math.max(0, tax);
}

/**
 * The payslip steps. pay: { basic }, Basic Pay as read from the payslip.
 * Returns every figure the calculator shows, in order.
 */
function payslip(pay, pricing) {
  const basic = pay.basic || 0;
  const pension = Math.round((basic * pricing.pensionBps) / BPS);
  const taxable = basic - pension;
  const tax = paye(taxable, pricing.payeBands);
  const totalDeductions = pension + tax;
  const net = basic - totalDeductions;
  return { basic, pension, taxable, tax, totalDeductions, net };
}

/** The affordability share (50%) of a salary figure, whole shillings. */
const maxInstalmentFor = (figure, affordabilityBps) => Math.max(0, Math.floor((figure * affordabilityBps) / BPS));

/**
 * Room inputs (D-101) from the payslip's staff loan lines and the SLAS loans it cannot show.
 * lines: [{ amount, replaced }] in payslip order; replaced marks a line a SLAS top-up has
 * already replaced, so it is not counted twice. topUpLine: index of the line being topped
 * up, or -1 for a new loan. slas: [{ applicationId, instalment }], SLAS loans not yet on the
 * payslip; topUpLoanId: the SLAS loan being topped up, which is not counted.
 */
function roomInputs({ lines = [], topUpLine = -1, slas = [], topUpLoanId = null } = {}) {
  const payslipDeductions = lines.reduce((sum, l, i) => (l.replaced || i === topUpLine ? sum : sum + (l.amount || 0)), 0);
  const slasNotOnPayslip = slas.filter((l) => !topUpLoanId || String(l.applicationId) !== String(topUpLoanId)).reduce((sum, l) => sum + (l.instalment || 0), 0);
  return { payslipDeductions, slasNotOnPayslip, topUp: topUpLine >= 0 };
}

/**
 * The combined limit and Room (D-87, D-101). The limit is 50% of Net Pay (Basic − Pension −
 * PAYE), for all staff loans together. Room = limit − staff loan deductions on the payslip
 * (other than the line topped up) − SLAS loans not yet on the payslip, never below 0. The
 * new instalment must fit in Room.
 * existing: roomInputs(...) — { payslipDeductions, slasNotOnPayslip, topUp }.
 */
function combinedCap(net, affordabilityBps, existing = {}, newInstalment = 0) {
  const cap = maxInstalmentFor(net, affordabilityBps);
  const payslipDeductions = existing.payslipDeductions || 0;
  const slasNotOnPayslip = existing.slasNotOnPayslip || 0;
  const available = Math.max(0, cap - payslipDeductions - slasNotOnPayslip);
  return { basis: 'payslip', cap, payslipDeductions, slasNotOnPayslip, topUp: !!existing.topUp, available, newInstalment, remaining: available - newInstalment };
}

/** Monthly instalment on a reducing balance, rounded up (BR-14). */
function instalment(principal, months, interestBps, rounding = 100) {
  if (!principal || !months) return 0;
  const r = interestBps / BPS / 12;
  const raw = r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months);
  return Math.ceil(raw / rounding) * rounding;
}

/**
 * Reverse calculation: the largest amount, in whole steps of `step` shillings, whose
 * rounded instalment over `months` stays within `maxInst`, capped at `cap`.
 */
function maxAmount(maxInst, months, interestBps, rounding = 100, { cap = Infinity, step = 1000 } = {}) {
  if (!(maxInst > 0) || !(months > 0)) return 0;
  const r = interestBps / BPS / 12;
  const pv = r === 0 ? maxInst * months : (maxInst * (1 - (1 + r) ** -months)) / r;
  let amount = Math.min(cap, Math.floor(pv / step) * step);
  while (amount > 0 && instalment(amount, months, interestBps, rounding) > maxInst) amount -= step;
  return Math.max(0, amount);
}

// ---------- calendar days ----------

function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

const pad = (n) => String(n).padStart(2, '0');

/** Adds months to a calendar day, clamping to the month end. */
function addMonthsToDay(day, months) {
  const { y, m, d } = parseDay(day);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

/** Adds (or, when negative, subtracts) calendar days. */
function addDaysToDay(day, days) {
  const { y, m, d } = parseDay(day);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Retirement cutoff (D-82): the date of birth plus ageYears calendar years (a
 * 29 February birthday falls on 28 February in a common year), less bufferDays days.
 * The last instalment of a loan must fall on or before this day.
 */
function retirementCutoff(dobDay, ageYears = 60, bufferDays = 60) {
  if (!dobDay) return null;
  return addDaysToDay(addMonthsToDay(dobDay, ageYears * 12), -bufferDays);
}

/** How many monthly instalments, the first due on firstDue, fall on or before cutoff. */
function instalmentsBefore(cutoff, firstDue) {
  if (!cutoff || !firstDue || firstDue > cutoff) return 0;
  const a = parseDay(firstDue);
  const b = parseDay(cutoff);
  let k = (b.y - a.y) * 12 + (b.m - a.m);
  while (k > 0 && addMonthsToDay(firstDue, k) > cutoff) k -= 1;
  return k + 1;
}

/** First instalment: the due day of the month after the start day (prototype: the 25th). */
function firstDueDate(startDay, dueDay = 25) {
  const { y, m } = parseDay(startDay);
  const next = addMonthsToDay(`${y}-${pad(m)}-01`, 1);
  const { y: ny, m: nm } = parseDay(next);
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(dueDay, last))}`;
}

/**
 * Repayment schedule (FR-24): instalment number, due date, payment, principal,
 * interest, closing balance. Interest is rounded to the shilling each month and the
 * last row clears the balance.
 */
function schedule(principal, months, interestBps, rounding, firstDue) {
  const inst = instalment(principal, months, interestBps, rounding);
  const rows = [];
  let balance = principal;
  for (let n = 1; n <= months; n += 1) {
    const interest = Math.round((balance * interestBps) / (BPS * 12));
    let principalPart = inst - interest;
    if (n === months || principalPart > balance) principalPart = balance;
    balance -= principalPart;
    rows.push({ n, due: addMonthsToDay(firstDue, n - 1), payment: principalPart + interest, principal: principalPart, interest, balance });
  }
  return rows;
}

/**
 * Full quote (BR-14, BR-15, D-78, D-101). existing: roomInputs(...). A top-up also
 * changes the processing fee rate.
 * { amount, tenor, topUp, pay, existing, pricing, startDay, dueDay, maxTenor, maxAmountCap }
 * maxTenor: the longest tenor this person may take (product maximum, cut short by
 * retirement or contract end); maxAmountCap: the product's maximum amount.
 */
function quote({ amount, tenor, topUp = false, pay, existing = {}, pricing, startDay, dueDay = 25, maxTenor = 0, maxAmountCap = Infinity }) {
  const ps = payslip(pay, pricing);
  const limitTenor = maxTenor || tenor || 0;
  const inst = instalment(amount, tenor, pricing.interestBps, pricing.instalmentRounding);
  const combined = combinedCap(ps.net, pricing.affordabilityBps, existing, inst);
  // The new loan may use Room (D-101).
  const maxInstalment = combined.available;
  const first = startDay ? firstDueDate(startDay, dueDay) : null;
  const rows = amount && tenor && first ? schedule(amount, tenor, pricing.interestBps, pricing.instalmentRounding, first) : [];
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const processingFee = Math.round((amount * (topUp ? pricing.processingFeeTopUpBps : pricing.processingFeeBps)) / BPS);
  const insuranceFee = Math.round((amount * pricing.insuranceBps * tenor) / (BPS * 12));
  return {
    payslip: ps,
    combined,
    maxInstalment,
    // Reverse calculation (D-78): at the longest tenor allowed, and at the chosen one.
    maxTenor: limitTenor,
    maxAmount: maxAmount(maxInstalment, limitTenor, pricing.interestBps, pricing.instalmentRounding, { cap: maxAmountCap }),
    maxAmountAtTenor: tenor ? maxAmount(maxInstalment, tenor, pricing.interestBps, pricing.instalmentRounding, { cap: maxAmountCap }) : 0,
    instalment: inst,
    pass: inst > 0 && inst <= maxInstalment,
    headroom: maxInstalment - inst,
    firstDueDate: first,
    schedule: rows,
    totalInterest,
    totalRepayable: amount + totalInterest,
    processingFee,
    insuranceFee,
    fees: processingFee + insuranceFee,
    rates: {
      interestBps: pricing.interestBps,
      processingFeeBps: topUp ? pricing.processingFeeTopUpBps : pricing.processingFeeBps,
      insuranceBps: pricing.insuranceBps,
      affordabilityBps: pricing.affordabilityBps,
      pensionBps: pricing.pensionBps,
    },
  };
}

module.exports = { paye, payslip, maxInstalmentFor, roomInputs, combinedCap, maxAmount, instalment, schedule, quote, addMonthsToDay, addDaysToDay, firstDueDate, retirementCutoff, instalmentsBefore };

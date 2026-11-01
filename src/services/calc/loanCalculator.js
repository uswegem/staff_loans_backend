'use strict';

// Loan calculator (BRD 10, BR-14, BR-15). Pure functions with no dependencies, used by
// the API and, through a generated copy, by the web app's live calculator
// (scripts/sync-calc.js). Money is integer shillings; rates are basis points
// (DECISIONS D-07). Dates are calendar days as 'YYYY-MM-DD' strings.
//
// Affordability (DECISIONS D-78, from the bank's instruction of 30 Oct 2026):
//   Pension = 10% of Basic Pay; Taxable Pay = Basic Pay − Pension; PAYE on Taxable Pay
//   (Tanzania bands); Total Deductions = Pension + PAYE; Net Pay = Basic Pay − Total
//   Deductions; Adjusted Net Pay = Net Pay + LFB deductions; Maximum Instalment = 50%
//   of Adjusted Net Pay. Basic Pay and LFB deductions come from the applicant's payslip.
//
// Worked example (Neema Mushi, basic 1,850,000, no LFB deductions, TZS 4,500,000 over
// 36 months): pension 185,000; PAYE 327,500; net 1,337,500; limit 668,750; instalment
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
 * The payslip steps. pay: { basic, lfbDeductions }, both read from the payslip.
 * Returns every figure the calculator shows, in order.
 */
function payslip(pay, pricing) {
  const basic = pay.basic || 0;
  const lfbDeductions = pay.lfbDeductions || 0;
  const pension = Math.round((basic * pricing.pensionBps) / BPS);
  const taxable = basic - pension;
  const tax = paye(taxable, pricing.payeBands);
  const totalDeductions = pension + tax;
  const net = basic - totalDeductions;
  const adjusted = net + lfbDeductions;
  return { basic, pension, taxable, tax, totalDeductions, net, lfbDeductions, adjusted };
}

/** Maximum instalment: the affordability share of adjusted net pay, whole shillings. */
const maxInstalmentFor = (adjusted, affordabilityBps) => Math.max(0, Math.floor((adjusted * affordabilityBps) / BPS));

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
 * Full quote (BR-14, BR-15, D-78). A top-up changes only the processing fee rate: the
 * old loan's instalment is already among the LFB deductions on the payslip.
 * { amount, tenor, topUp, pay, pricing, startDay, dueDay, maxTenor, maxAmountCap }
 * maxTenor: the longest tenor this person may take (product maximum, cut short by
 * retirement or contract end); maxAmountCap: the product's maximum amount.
 */
function quote({ amount, tenor, topUp = false, pay, pricing, startDay, dueDay = 25, maxTenor = 0, maxAmountCap = Infinity }) {
  const ps = payslip(pay, pricing);
  const { adjusted } = ps;
  const maxInstalment = maxInstalmentFor(adjusted, pricing.affordabilityBps);
  const limitTenor = maxTenor || tenor || 0;
  const inst = instalment(amount, tenor, pricing.interestBps, pricing.instalmentRounding);
  const first = startDay ? firstDueDate(startDay, dueDay) : null;
  const rows = amount && tenor && first ? schedule(amount, tenor, pricing.interestBps, pricing.instalmentRounding, first) : [];
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const processingFee = Math.round((amount * (topUp ? pricing.processingFeeTopUpBps : pricing.processingFeeBps)) / BPS);
  const insuranceFee = Math.round((amount * pricing.insuranceBps * tenor) / (BPS * 12));
  return {
    payslip: ps,
    adjusted,
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

module.exports = { paye, payslip, maxInstalmentFor, maxAmount, instalment, schedule, quote, addMonthsToDay, addDaysToDay, firstDueDate, retirementCutoff, instalmentsBefore };

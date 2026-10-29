'use strict';

// Loan calculator (BRD 10, BR-14, BR-15). Pure functions with no dependencies, used by
// the API and, through a generated copy, by the web app's live calculator
// (scripts/sync-calc.js). Money is integer shillings; rates are basis points
// (DECISIONS D-07). Dates are calendar days as 'YYYY-MM-DD' strings.
//
// Worked example (prototype handover, Neema Mushi, TZS 4,500,000 over 36 months):
// pension 185,000; PAYE 327,500; net 1,337,500; limit 668,750; instalment 136,900;
// total interest 428,351; processing 45,000; insurance 81,000.

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
 * The payslip steps (BRD 10, steps 1 to 3). Allowances are ignored (decision 26).
 * pay: { basic, allowances, commission, medical, otherDeductions, existingLfbInstalments, otherBankInstalments }
 */
function payslip(pay, pricing) {
  const basic = pay.basic || 0;
  const commission = pay.commission || 0;
  const pension = Math.round((basic * pricing.pensionBps) / BPS);
  const taxable = basic + commission - pension;
  const tax = paye(taxable, pricing.payeBands);
  const existingLfb = pay.existingLfbInstalments || 0;
  const declared = (pay.medical || 0) + (pay.otherDeductions || 0);
  const otherBank = pay.otherBankInstalments || 0;
  const net = basic - pension - tax - existingLfb - declared - otherBank;
  return { basic, allowances: pay.allowances || 0, commission, pension, taxable, tax, existingLfb, declared, otherBank, net };
}

/** Monthly instalment on a reducing balance, rounded up (BR-14). */
function instalment(principal, months, interestBps, rounding = 100) {
  if (!principal || !months) return 0;
  const r = interestBps / BPS / 12;
  const raw = r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months);
  return Math.ceil(raw / rounding) * rounding;
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
 * Full quote (BRD 10 steps 1 to 6, BR-14, BR-15).
 * { amount, tenor, topUp, topUpInstalment, pay, pricing, startDay, dueDay }
 */
function quote({ amount, tenor, topUp = false, topUpInstalment = 0, pay, pricing, startDay, dueDay = 25 }) {
  const ps = payslip(pay, pricing);
  const addBack = topUp ? topUpInstalment || 0 : 0;
  const adjusted = ps.net + addBack;
  const maxInstalment = Math.max(0, Math.floor((adjusted * pricing.affordabilityBps) / BPS));
  const inst = instalment(amount, tenor, pricing.interestBps, pricing.instalmentRounding);
  const first = startDay ? firstDueDate(startDay, dueDay) : null;
  const rows = amount && tenor && first ? schedule(amount, tenor, pricing.interestBps, pricing.instalmentRounding, first) : [];
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const processingFee = Math.round((amount * (topUp ? pricing.processingFeeTopUpBps : pricing.processingFeeBps)) / BPS);
  const insuranceFee = Math.round((amount * pricing.insuranceBps * tenor) / (BPS * 12));
  return {
    payslip: ps,
    addBack,
    adjusted,
    maxInstalment,
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

module.exports = { paye, payslip, instalment, schedule, quote, addMonthsToDay, firstDueDate };

'use strict';

// Application rules (BRD 10: BR-01 to BR-12; NS-01, NS-02). Hard rules block starting
// or submitting with the prototype's messages (handover §8). The product version and
// pricing supply every value; nothing here branches on a product.

const calc = require('../calc/loanCalculator');
const { cooling, coolingMessage, recordProblems } = require('../staff/eligibilityService');
const { probationInfo } = require('../staff/staffService');
const { cutoffFor, cutoffRule, cutoffProblem } = require('../staff/retirement');
const { OPEN } = require('../../constants/statuses');
const { matchLines, normLabel } = require('../payslip/deductionLines');
const { localDay } = require('../../utils/dates');

const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;
const day = (d) => (d ? localDay(d) : null);

function monthsBetweenDays(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

/**
 * A SLAS loan is running from final approval (approved, not yet disbursed, counts) until
 * its last instalment is due, unless a top-up has replaced it: a top-up that has final
 * approval takes over its deduction (D-87).
 */
function runningLoans(apps, excludeId, today) {
  const replaced = new Set(apps.filter((a) => a.topUp?.on && a.topUp.applicationId && ['pending_disbursement', 'disbursed'].includes(a.status)).map((a) => String(a.topUp.applicationId)));
  return apps.filter((a) => {
    if (String(a._id) === String(excludeId) || replaced.has(String(a._id)) || a.settledByTopUp?.applicationId) return false;
    if (!['pending_disbursement', 'disbursed'].includes(a.status) || !a.approved?.tenor) return false;
    const lastDue = a.schedule?.length ? a.schedule.at(-1).due : calc.addMonthsToDay(calc.firstDueDate(day(a.finalApprovedAt || a.updatedAt)), a.approved.tenor - 1);
    return lastDue >= today;
  });
}

/** Calculator inputs: Basic Pay as read from the payslip (D-78). */
function payInputs(payslip) {
  return { basic: payslip?.basic || 0 };
}

/** First instalment of a SLAS loan: from its schedule, or the due day after final approval. */
const firstDueOf = (a) => a.schedule?.[0]?.due || calc.firstDueDate(day(a.finalApprovedAt || a.updatedAt));

/**
 * What Room is worked out from (D-101): the payslip's staff loan lines matched to products,
 * the line being topped up, and the running SLAS loans the payslip cannot show yet (approved
 * but not paid out, or first instalment after the pay date). A SLAS loan the payslip already
 * shows is not counted twice; neither is a line a SLAS top-up has replaced since the pay date.
 * { apps, appId, today, products, productId, payslip, topUp }; products: productLabels(...).
 * Returns { lines, ownLines, topUpLine, topUpLoan, topUpCandidate, loans, slas, unmatched, inputs }.
 */
function deductions({ apps, appId, today, products = [], productId, payslip, topUp }) {
  const payDate = payslip?.payDate || null;
  const loans = runningLoans(apps, appId, today).map((a) => ({ applicationId: String(a._id), ref: a.ref, productId: String(a.productId), status: a.status, instalment: a.approved?.instalment || 0, firstDue: firstDueOf(a), topUp: a.topUp }));
  const slas = loans
    .filter((l) => !payDate || l.status === 'pending_disbursement' || l.firstDue > payDate)
    .map(({ topUp: t, ...l }) => ({ ...l, replaces: t?.on ? t : null }));
  const lines = matchLines(payslip?.lfbLines, products);
  // A SLAS top-up not yet on the payslip replaces a line still printed there: count only the new instalment.
  slas.forEach((l) => {
    if (!l.replaces) return;
    const amount = l.replaces.payslipLine?.amount ?? apps.find((a) => String(a._id) === String(l.replaces.applicationId))?.approved?.instalment;
    const i = lines.findIndex((x) => !x.replaced && x.productId === l.productId && x.amount === amount && (!l.replaces.payslipLine?.label || normLabel(x.label) === normLabel(l.replaces.payslipLine.label)));
    if (i >= 0) lines[i].replaced = l.ref;
  });
  const ownLines = lines.map((l, i) => (!l.replaced && productId && l.productId === String(productId) ? i : -1)).filter((i) => i >= 0);
  let topUpLine = -1;
  if (topUp?.on) {
    const chosen = topUp.payslipLine;
    if (ownLines.length === 1) [topUpLine] = ownLines;
    else if (chosen) topUpLine = ownLines.find((i) => lines[i].amount === chosen.amount && normLabel(lines[i].label) === normLabel(chosen.label)) ?? -1;
  }
  // A running SLAS loan of this product stays linked to a top-up, so it is settled at
  // disbursement; the candidate is worked out even before top-up is chosen, for the live calculator.
  const mine = loans.filter((l) => l.productId === String(productId));
  const lineFor = topUpLine >= 0 ? topUpLine : ownLines.length === 1 ? ownLines[0] : -1;
  const candidate = mine.find((l) => topUp?.applicationId && l.applicationId === String(topUp.applicationId)) || mine.find((l) => lineFor >= 0 && l.instalment === lines[lineFor].amount) || mine[0] || null;
  const topUpLoan = topUp?.on ? candidate : null;
  const inputs = calc.roomInputs({ lines, topUpLine: topUp?.on ? topUpLine : -1, slas, topUpLoanId: topUpLoan?.applicationId });
  const clean = (l) => ({ applicationId: l.applicationId, ref: l.ref, productId: l.productId, status: l.status, instalment: l.instalment, firstDue: l.firstDue });
  return {
    lines,
    ownLines,
    topUpLine,
    topUpLoan: topUpLoan && clean(topUpLoan),
    topUpCandidate: candidate && clean(candidate),
    loans: loans.map(clean),
    slas: slas.map(clean),
    unmatched: lines.filter((l) => !l.productId && !l.replaced),
    inputs,
  };
}

/** Days from one calendar day to another (both 'YYYY-MM-DD'). */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** D-79: the payslip must be attached and at most payslipMaxAgeDays old. */
function payslipProblem(payslip, settings, today) {
  if (!payslip?.fileId) return 'Attach your latest payslip. Basic Pay and LFB deductions are read from it.';
  const maxAge = settings.payslipMaxAgeDays || 45;
  const age = daysBetween(payslip.payDate, today);
  if (age > maxAge) return `Your payslip is dated ${payslip.payDate}, ${age} days ago. Attach one not older than ${maxAge} days.`;
  if (age < -31) return `Your payslip is dated ${payslip.payDate}, in the future. Attach your latest payslip.`;
  return null;
}

/**
 * The longest tenor this person may take (D-82, BR-04): the lowest of the product
 * maximum, the whole instalments that fall on or before the retirement cutoff, and those
 * before a contract end. 0 when not even the product minimum fits.
 */
function longestTenor(version, staff, startDay, dueDay, settings = {}) {
  const first = calc.firstDueDate(startDay, dueDay);
  const limits = [version.maxTenor];
  const cutoff = cutoffFor(staff, settings);
  if (cutoff) limits.push(calc.instalmentsBefore(cutoff, first));
  if (staff.contractEndDate) limits.push(calc.instalmentsBefore(day(staff.contractEndDate), first));
  const n = Math.min(...limits);
  return n >= version.minTenor ? n : 0;
}

/**
 * The cutoff check on a schedule (D-82): the actual last instalment date must be on or
 * before the cutoff. Used at entry, at submission and again at every approval.
 * Returns { ok, lastDue, cutoff, maxTenor } or { ok: false, message }.
 */
function cutoffCheck({ staff, settings, version, tenor, lastDue, startDay }) {
  const cutoff = cutoffFor(staff, settings);
  if (!cutoff) return { ok: false, message: 'The applicant has no verified date of birth.', code: 'DOB_NOT_VERIFIED' };
  const maxTenor = longestTenor(version, staff, startDay, settings.firstDueDay || 25, settings);
  if (lastDue && lastDue > cutoff) {
    return { ok: false, cutoff, lastDue, maxTenor, code: 'CUTOFF_EXCEEDED', message: `The last instalment would be due on ${lastDue}, after the cutoff of ${cutoff} (${cutoffRule(settings)}). The longest tenor allowed is ${maxTenor} months; ${tenor} months is too long.` };
  }
  return { ok: true, cutoff, lastDue, maxTenor };
}

/**
 * Can this staff member start (or keep) an application for this product?
 * ctx: { staff, profile, settings, product, version, apps, appId, topUp, today }
 */
function eligibility(ctx) {
  const { staff, profile, version: v, settings, apps, today } = ctx;
  const out = [];
  if (staff.status !== 'active') out.push('Your staff record is not active. Contact People and Culture.');
  // When the date of birth is all that is missing, its own message (below) says what to do (D-82).
  if (!profile.complete && !profile.missing.every((m) => m.key === 'personal.dob')) out.push(`You can apply once your profile is complete. Missing: ${profile.missing.map((m) => m.label).join(', ')}.`);
  // D-91, D-100: People and Culture must record the date joined first.
  out.push(...recordProblems(staff));
  if (staff.employmentType === 'Contract' && !v.contractStaffAllowed) out.push(`${v.name} is for permanent staff only.`);
  if (!v.eligibleCategories.includes(staff.category)) out.push(`${v.name} is not open to ${staff.category.toLowerCase()} staff.`);

  const probation = probationInfo(staff, settings.probationMonths, new Date(`${today}T12:00:00+03:00`));
  const onProbation = probation.onProbation || staff.employmentType === 'Probation';
  const service = staff.dateJoined ? monthsBetweenDays(day(staff.dateJoined), today) : 0;
  // NS-01 (D-25, C-02): during probation a verified reason waives the service shortfall.
  if (staff.dateJoined && service < v.minServiceMonths && !onProbation) out.push(`You need at least ${v.minServiceMonths} months' service. You have ${Math.max(0, service)}.`);

  const open = apps.find((a) => String(a.productId) === String(ctx.product._id) && OPEN.includes(a.status) && String(a._id) !== String(ctx.appId));
  if (open) out.push(`You already have an open ${v.name} application (${open.ref}). Finish or withdraw it first.`);

  const running =
    runningLoans(apps, ctx.appId, today).filter((a) => String(a.productId) === String(ctx.product._id)).length +
    (staff.existingLfbLoans || []).filter((l) => l.productId && String(l.productId) === String(ctx.product._id)).length;
  if (running >= v.maxConcurrent && !ctx.topUp?.on) out.push(`You already have ${running} running ${v.name}. The limit is ${v.maxConcurrent}.`);

  const c = cooling(staff, ctx.product._id, v.reapplyCoolingMonths, new Date(`${today}T12:00:00+03:00`));
  if (c && c.daysRemaining > 0) out.push(coolingMessage(v.name, c));
  const cut = cutoffProblem(staff, v, settings, today);
  if (cut) out.push(cut);
  return { messages: out, onProbation, probation, service };
}

const blank = (x) => x === undefined || x === null || String(x).trim() === '';

/** Missing or malformed form fields: { field: message }. */
function fieldErrors(input, version, { onProbation }, ded) {
  const e = {};
  if (!input.amount) e.amount = 'Enter the amount you want to borrow.';
  if (!input.tenor) e.tenor = 'Enter the tenor in months.';
  if (blank(input.purpose)) e.purpose = 'Say what the loan is for.';
  for (const f of version.fields) {
    const val = input.productFields?.[f.key];
    const key = `productFields.${f.key}`;
    if (blank(val)) {
      if (f.mandatory) e[key] = `Enter ${f.label.charAt(0).toLowerCase()}${f.label.slice(1).replace(/[?.:]+$/, '')}.`;
      continue;
    }
    if (f.type === 'number' && !Number.isFinite(Number(val))) e[key] = `${f.label} must be a number.`;
    if (f.type === 'money' && !(Number.isInteger(Number(val)) && Number(val) >= 0)) e[key] = `${f.label} must be whole shillings.`;
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(val))) e[key] = `${f.label} must be a date.`;
    if (f.type === 'select' && !f.options.includes(val)) e[key] = `Choose one of the options for ${f.label.toLowerCase()}.`;
  }
  if (input.topUp?.on) {
    // D-101: a top-up is of a deduction on the payslip, recorded in Staff Loans or not.
    if (!version.topUpAllowed) e['topUp.on'] = `${version.name} cannot be topped up.`;
    else if (input.payslip?.fileId && ded) {
      if (!String(version.payslipLabel || '').trim()) e['topUp.on'] = `${version.name} has no payslip deduction label yet, so a top-up cannot be matched to your payslip. Ask the Head of Credit to set it.`;
      else if (!ded.ownLines.length) e['topUp.on'] = `Your payslip shows no ${version.name} deduction (${version.payslipLabel}), so there is no loan to top up. Untick top-up to apply for a new loan, or attach a payslip that shows it.`;
      else if (ded.topUpLine < 0) e['topUp.payslipLine'] = `Your payslip shows ${ded.ownLines.length} ${version.name} deductions. Choose the one being topped up.`;
    }
  }
  if (onProbation && blank(input.probationReason)) e.probationReason = 'Say why you are applying during probation. People and Culture will verify it.';
  return e;
}

/** Amount, tenor and affordability (BR-03 to BR-06, D-78). */
function loanChecks(input, version, staff, q, settings = {}) {
  const out = [];
  const { amount, tenor } = input;
  if (amount && amount < version.minAmount) out.push(`The minimum for ${version.name} is ${tzs(version.minAmount)}.`);
  if (amount && amount > version.maxAmount) out.push(`The maximum for ${version.name} is ${tzs(version.maxAmount)}.`);
  if (tenor && (tenor < version.minTenor || tenor > version.maxTenor)) out.push(`Choose a tenor between ${version.minTenor} and ${version.maxTenor} months.`);
  const lastDue = q.schedule.at(-1)?.due;
  // D-82: the cutoff from the verified date of birth, on the schedule's actual last date. It is
  // never shortened silently; the message gives the cutoff and the longest tenor allowed.
  const cutoff = cutoffFor(staff, settings);
  if (lastDue && cutoff && lastDue > cutoff) {
    out.push(`Your last instalment would be due on ${lastDue}, after your cutoff of ${cutoff} (${cutoffRule(settings)}). The longest tenor you can take is ${q.maxTenor} months.`);
  }
  if (lastDue && staff.contractEndDate && lastDue > day(staff.contractEndDate)) out.push('The loan must be repaid before your contract ends. Shorten the tenor.');
  if (input.payslip && amount && tenor && !q.pass) {
    const c = q.combined;
    out.push(`The instalment of ${tzs(q.instalment)} is above your Room of ${tzs(c.available)} a month: ${q.rates.affordabilityBps / 100}% of Net Pay is ${tzs(c.cap)}, less ${tzs(c.payslipDeductions)} of staff loan deductions on your payslip and ${tzs(c.slasNotOnPayslip)} of Staff Loans loans not yet on it. Borrow up to ${tzs(q.maxAmountAtTenor)} over ${tenor} months, or up to ${tzs(q.maxAmount)} over ${q.maxTenor} months.`);
  }
  return out;
}

/**
 * Everything the wizard and submission need.
 * ctx: { staff, profile, settings, product, version, pricing, apps, appId, today }
 * input: { amount, tenor, purpose, productFields, repayment, topUp, probationReason }
 */
function evaluate(ctx, input) {
  const elig = eligibility({ ...ctx, topUp: input.topUp });
  const pay = payInputs(input.payslip);
  const ded = deductions({ apps: ctx.apps, appId: ctx.appId, today: ctx.today, products: ctx.products, productId: ctx.product._id, payslip: input.payslip, topUp: input.topUp });
  const dueDay = ctx.settings.firstDueDay || 25;
  const q = calc.quote({
    amount: input.amount || 0,
    tenor: input.tenor || 0,
    topUp: !!input.topUp?.on,
    pay,
    existing: ded.inputs,
    pricing: ctx.pricing,
    startDay: ctx.today,
    dueDay,
    maxTenor: longestTenor(ctx.version, ctx.staff, ctx.today, dueDay, ctx.settings),
    maxAmountCap: ctx.version.maxAmount,
  });
  const fields = fieldErrors({ ...input, productId: ctx.product._id }, ctx.version, elig, ded);
  const slip = payslipProblem(input.payslip, ctx.settings, ctx.today);
  if (slip) fields.payslip = slip;
  const checks = loanChecks(input, ctx.version, ctx.staff, q, ctx.settings);
  const flags = elig.onProbation ? ['Applied during probation: verify the reason (NS-01).'] : [];
  // No salary record to compare the payslip with (D-100): HR confirm Basic Pay from the payslip.
  // D-101: a staff loan line that matches no product still counts against Room; reviewers are told.
  ded.unmatched.forEach((l) => flags.push(`The payslip shows a staff loan deduction that matches no product: ${l.label}, ${tzs(l.amount)}. It is counted against Room; confirm it with Payroll.`));
  // A linked SLAS loan's instalment should be the payslip line topped up.
  if (ded.topUpLoan && ded.topUpLine >= 0 && ded.lines[ded.topUpLine].amount !== ded.topUpLoan.instalment) {
    const line = ded.lines[ded.topUpLine];
    flags.push(`Top-up of ${ded.topUpLoan.ref}: its instalment in Staff Loans is ${tzs(ded.topUpLoan.instalment)}, but the payslip line ${line.label} shows ${tzs(line.amount)}. Confirm the deduction with Payroll.`);
  }
  return {
    eligibility: elig.messages,
    fieldErrors: fields,
    checks,
    flags,
    onProbation: elig.onProbation,
    probation: elig.probation,
    pay,
    deductions: ded,
    quote: q,
    cutoff: cutoffFor(ctx.staff, ctx.settings),
    canSubmit: !elig.messages.length && !Object.keys(fields).length && !checks.length,
  };
}

module.exports = { evaluate, eligibility, fieldErrors, loanChecks, payInputs, deductions, payslipProblem, longestTenor, cutoffFor, cutoffProblem, cutoffCheck, runningLoans, monthsBetweenDays };

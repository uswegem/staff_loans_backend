'use strict';

// Application rules (BRD 10: BR-01 to BR-12; NS-01, NS-02). Hard rules block starting
// or submitting with the prototype's messages (handover §8). The product version and
// pricing supply every value; nothing here branches on a product.

const calc = require('../calc/loanCalculator');
const { cooling, coolingMessage } = require('../staff/eligibilityService');
const { probationInfo } = require('../staff/staffService');
const { OPEN } = require('../../constants/statuses');
const { localDay } = require('../../utils/dates');

const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;
const day = (d) => (d ? localDay(d) : null);

function monthsBetweenDays(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

/** A loan is running until its last instalment is due (approved instalment and tenor). */
function runningLoans(apps, excludeId, today) {
  return apps.filter((a) => {
    if (String(a._id) === String(excludeId)) return false;
    if (!['pending_disbursement', 'disbursed'].includes(a.status) || !a.approved?.tenor) return false;
    const start = day(a.finalApprovedAt || a.updatedAt);
    return calc.addMonthsToDay(calc.firstDueDate(start), a.approved.tenor - 1) >= today;
  });
}

/** Calculator inputs: Basic Pay and LFB deductions as read from the payslip (D-78). */
function payInputs(payslip) {
  return { basic: payslip?.basic || 0, lfbDeductions: payslip?.lfbDeductions || 0 };
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
 * The longest tenor this person may take: the product maximum, cut short so the last
 * instalment falls before retirement or contract end (BR-04, BR-05).
 */
function longestTenor(version, staff, startDay, dueDay) {
  const first = calc.firstDueDate(startDay, dueDay);
  const ends = [staff.retirementDate, staff.contractEndDate].filter(Boolean).map(day);
  let n = version.maxTenor;
  while (n >= version.minTenor && ends.some((end) => calc.addMonthsToDay(first, n - 1) > end)) n -= 1;
  return n >= version.minTenor ? n : 0;
}

/**
 * Can this staff member start (or keep) an application for this product?
 * ctx: { staff, profile, settings, product, version, apps, appId, topUp, today }
 */
function eligibility(ctx) {
  const { staff, profile, version: v, settings, apps, today } = ctx;
  const out = [];
  if (staff.status !== 'active') out.push('Your staff record is not active. Contact People and Culture.');
  if (!profile.complete) out.push(`You can apply once your profile is complete. Missing: ${profile.missing.map((m) => m.label).join(', ')}.`);
  if (staff.employmentType === 'Contract' && !v.contractStaffAllowed) out.push(`${v.name} is for permanent staff only.`);
  if (!v.eligibleCategories.includes(staff.category)) out.push(`${v.name} is not open to ${staff.category.toLowerCase()} staff.`);

  const probation = probationInfo(staff, settings.probationMonths, new Date(`${today}T12:00:00+03:00`));
  const onProbation = probation.onProbation || staff.employmentType === 'Probation';
  const service = monthsBetweenDays(day(staff.dateJoined), today);
  // NS-01 (D-25, C-02): during probation a verified reason waives the service shortfall.
  if (service < v.minServiceMonths && !onProbation) out.push(`You need at least ${v.minServiceMonths} months' service. You have ${Math.max(0, service)}.`);

  const open = apps.find((a) => String(a.productId) === String(ctx.product._id) && OPEN.includes(a.status) && String(a._id) !== String(ctx.appId));
  if (open) out.push(`You already have an open ${v.name} application (${open.ref}). Finish or withdraw it first.`);

  const running =
    runningLoans(apps, ctx.appId, today).filter((a) => String(a.productId) === String(ctx.product._id)).length +
    (staff.existingLfbLoans || []).filter((l) => l.productId && String(l.productId) === String(ctx.product._id)).length;
  if (running >= v.maxConcurrent && !ctx.topUp?.on) out.push(`You already have ${running} running ${v.name}. The limit is ${v.maxConcurrent}.`);

  const c = cooling(staff, ctx.product._id, v.reapplyCoolingMonths, new Date(`${today}T12:00:00+03:00`));
  if (c && c.daysRemaining > 0) out.push(coolingMessage(v.name, c));
  return { messages: out, onProbation, probation, service };
}

const blank = (x) => x === undefined || x === null || String(x).trim() === '';

/** Missing or malformed form fields: { field: message }. */
function fieldErrors(input, version, { onProbation }) {
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
  if (!version.repaymentMethods.includes(input.repayment?.method)) e['repayment.method'] = 'Choose how you will repay.';
  if (input.repayment?.method === 'account' && ['bank', 'branch', 'accountName', 'accountNo'].some((k) => blank(input.repayment[k]))) {
    e['repayment.method'] = 'Add your bank, branch, account name and number in your profile to repay by account debit.';
  }
  if (input.topUp?.on) {
    if (!version.topUpAllowed) e['topUp.on'] = `${version.name} cannot be topped up.`;
    if (blank(input.topUp.loanRef)) e['topUp.loanRef'] = 'Enter the loan being topped up.';
  }
  if (onProbation && blank(input.probationReason)) e.probationReason = 'Say why you are applying during probation. People and Culture will verify it.';
  return e;
}

/** Amount, tenor and affordability (BR-03 to BR-06, D-78). */
function loanChecks(input, version, staff, q) {
  const out = [];
  const { amount, tenor } = input;
  if (amount && amount < version.minAmount) out.push(`The minimum for ${version.name} is ${tzs(version.minAmount)}.`);
  if (amount && amount > version.maxAmount) out.push(`The maximum for ${version.name} is ${tzs(version.maxAmount)}.`);
  if (tenor && (tenor < version.minTenor || tenor > version.maxTenor)) out.push(`Choose a tenor between ${version.minTenor} and ${version.maxTenor} months.`);
  const lastDue = q.schedule.at(-1)?.due;
  if (lastDue && staff.retirementDate && lastDue > day(staff.retirementDate)) out.push('The loan must be repaid before your retirement date. Shorten the tenor.');
  if (lastDue && staff.contractEndDate && lastDue > day(staff.contractEndDate)) out.push('The loan must be repaid before your contract ends. Shorten the tenor.');
  if (input.payslip && amount && tenor && !q.pass) {
    out.push(`The instalment of ${tzs(q.instalment)} is above your limit of ${tzs(q.maxInstalment)} (${q.rates.affordabilityBps / 100}% of adjusted net pay). Borrow up to ${tzs(q.maxAmountAtTenor)} over ${tenor} months, or up to ${tzs(q.maxAmount)} over ${q.maxTenor} months.`);
  }
  return out;
}

/**
 * Everything the wizard and submission need.
 * ctx: { staff, salary, profile, settings, product, version, pricing, apps, appId, today }
 * input: { amount, tenor, purpose, productFields, repayment, topUp, probationReason }
 */
function evaluate(ctx, input) {
  const elig = eligibility({ ...ctx, topUp: input.topUp });
  const pay = payInputs(input.payslip);
  const dueDay = ctx.settings.firstDueDay || 25;
  const q = calc.quote({
    amount: input.amount || 0,
    tenor: input.tenor || 0,
    topUp: !!input.topUp?.on,
    pay,
    pricing: ctx.pricing,
    startDay: ctx.today,
    dueDay,
    maxTenor: longestTenor(ctx.version, ctx.staff, ctx.today, dueDay),
    maxAmountCap: ctx.version.maxAmount,
  });
  const fields = fieldErrors(input, ctx.version, elig);
  const slip = payslipProblem(input.payslip, ctx.settings, ctx.today);
  if (slip) fields.payslip = slip;
  const checks = loanChecks(input, ctx.version, ctx.staff, q);
  const flags = elig.onProbation ? ['Applied during probation: verify the reason (NS-01).'] : [];
  // People and Culture's salary record is the check on the payslip (D-79).
  if (input.payslip?.basic && ctx.salary?.basic && input.payslip.basic !== ctx.salary.basic) {
    flags.push(`Basic Pay on the payslip (${tzs(input.payslip.basic)}) differs from the staff record (${tzs(ctx.salary.basic)}): confirm with Payroll.`);
  }
  return {
    eligibility: elig.messages,
    fieldErrors: fields,
    checks,
    flags,
    onProbation: elig.onProbation,
    probation: elig.probation,
    pay,
    quote: q,
    canSubmit: !elig.messages.length && !Object.keys(fields).length && !checks.length,
  };
}

module.exports = { evaluate, eligibility, fieldErrors, loanChecks, payInputs, payslipProblem, longestTenor, runningLoans, monthsBetweenDays };

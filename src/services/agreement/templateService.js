'use strict';

// Agreement template versions (FR-40, prototype #/admin/templates). An administrator
// loads a new version after Legal approves the text. A version is in use from its
// effective date; the newest effective version is the current one, so a version can
// be loaded ahead of time without a job. Each agreement keeps the version it was
// signed on (FR-61). Template text uses the SLAS markup (renderer.js); it is checked
// by rendering a sample agreement before it is saved.

const AgreementTemplate = require('../../models/AgreementTemplate');
const Agreement = require('../../models/Agreement');
const audit = require('../audit/auditService');
const calc = require('../calc/loanCalculator');
const { values, scheduleTable } = require('./agreementService');
const { render } = require('./renderer');
const { livePricing } = require('../products/productService');
const { fullName } = require('../review/reviewView');
const { localDay, localMidnight } = require('../../utils/dates');
const { badRequest, conflict } = require('../../utils/errors');

/**
 * Values every agreement must show (BRD 8 pre-filled fields). {{requestClause}} states
 * the amount, tenor and instalment in figures and words, for an original or a revised
 * agreement, so it stands for those three.
 */
const REQUIRED = ['ref', 'fullName', 'staffNo', 'requestClause', 'effectClause', 'interestRate', 'totalRepayable', 'firstDueDate', 'repaymentMethod'];

/** A fictional applicant used only to check and preview a template. */
async function sampleInput() {
  const pricing = (await livePricing()) || { interestBps: 600, processingFeeBps: 100, processingFeeTopUpBps: 50, insuranceBps: 60, affordabilityBps: 5000, pensionBps: 1000, instalmentRounding: 100, payeBands: [] };
  const today = localDay();
  const pay = { basic: 1850000, allowances: 220000, commission: 0, medical: 0, otherDeductions: 0, otherBankInstalments: 0, existingLfbInstalments: 0 };
  const q = calc.quote({ amount: 4500000, tenor: 36, pay, pricing, startDay: today, dueDay: 25 });
  return {
    ref: 'SL-0000-00000',
    kind: 'original',
    agreementNumber: 'MKT-0000-00000',
    staff: { firstName: 'Mfano', lastName: 'Mwajiriwa', staffNo: 'LFB0000', personal: { poBox: 'S.L.P. 1', residence: 'Dar es Salaam', mobile: '+255 700 000 000' } },
    product: { name: 'Mkopo wa mfano' }, // sample name; code never names a real product
    quote: q,
    amount: 4500000,
    tenor: 36,
    repayment: { method: 'payroll' },
    topUp: { on: false },
  };
}

/** Renders the body with the sample; returns { blocks, textSha256 } or throws 400 with the problems. */
async function check(body, version = 'preview') {
  const input = await sampleInput();
  let out;
  try {
    out = render(body, values(input, version), scheduleTable(input.quote.schedule));
  } catch (err) {
    throw badRequest(err.message.replace('Agreement template uses an unknown value', 'The text uses an unknown value'), { body: [err.message] }, 'TEMPLATE_INVALID');
  }
  const used = new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  const missing = REQUIRED.filter((k) => !used.has(k));
  if (!used.has('schedule')) missing.push('schedule');
  if (missing.length) throw badRequest(`The text must include ${missing.map((k) => `{{${k}}}`).join(', ')}.`, { body: missing.map((k) => `Missing {{${k}}}`) }, 'TEMPLATE_INCOMPLETE');
  return { blocks: out.blocks, textSha256: out.textSha256, placeholders: [...used].sort() };
}

const preview = (body) => check(body);

async function list() {
  const now = new Date();
  const rows = await AgreementTemplate.find().sort({ effectiveFrom: -1, createdAt: -1 }).lean();
  const current = await AgreementTemplate.active();
  const counts = new Map((await Agreement.aggregate([{ $group: { _id: '$templateVersion', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
  const loaders = await require('../review/reviewView').namesOf(rows.map((r) => r.loadedBy).filter(Boolean));
  return rows.map((t) => ({
    id: String(t._id),
    version: t.version,
    state: current && String(current._id) === String(t._id) ? 'current' : t.effectiveFrom && t.effectiveFrom > now ? 'scheduled' : 'retired',
    effectiveFrom: t.effectiveFrom ? localDay(t.effectiveFrom) : null,
    legalApproved: t.legalApproved,
    legalApprovalRef: t.legalApprovalRef || null,
    sample: !!t.sample,
    note: t.note || '',
    loadedAt: t.createdAt,
    loadedBy: loaders.get(String(t.loadedBy))?.name || null,
    agreements: counts.get(t.version) || 0,
  }));
}

async function get(id) {
  const t = await AgreementTemplate.findById(id).lean();
  if (!t) return null;
  return { id: String(t._id), version: t.version, body: t.body, ...(await check(t.body, t.version)) };
}

/** body: { version, effectiveFrom, body, legalApproved, legalApprovalRef, note } */
async function load(req, body) {
  if (body.legalApproved !== true) throw badRequest('Legal must approve the text before it is loaded.', { legalApproved: ['Legal approval is required.'] }, 'LEGAL_APPROVAL_REQUIRED');
  if (await AgreementTemplate.exists({ version: body.version })) throw conflict(`Version ${body.version} is already loaded. Use a new version number.`, 'VERSION_EXISTS');
  if (body.effectiveFrom < localDay()) throw badRequest('The date it is used from cannot be in the past.', { effectiveFrom: ['Today or later.'] }, 'DATE_INVALID');
  const checked = await check(body.body, body.version);
  const t = await AgreementTemplate.create({
    version: body.version,
    status: 'active',
    body: body.body,
    legalApproved: true,
    legalApprovalRef: body.legalApprovalRef || null,
    sample: false,
    effectiveFrom: localMidnight(body.effectiveFrom),
    loadedBy: req.auth.user._id,
    note: body.note || '',
  });
  const staffName = fullName(req.auth.staff || {});
  await audit.record({
    req,
    action: 'template.load',
    description: `Agreement template ${t.version} loaded (Legal approved${body.legalApprovalRef ? `, ${body.legalApprovalRef}` : ''}), used from ${body.effectiveFrom}${staffName ? ` by ${staffName}` : ''}`,
    entity: 'AgreementTemplate',
    entityId: String(t._id),
    after: { version: t.version, effectiveFrom: body.effectiveFrom, placeholders: checked.placeholders, sampleSha256: checked.textSha256 },
  });
  return t;
}

module.exports = { list, get, load, preview, REQUIRED };

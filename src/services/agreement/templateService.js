'use strict';

// Agreement template versions (FR-40, D-88). The Legal Officer (admin.templates) uploads
// or edits a version, which waits as "Pending Legal Approval"; the Head of Legal
// (templates.approve) approves it, or rejects it with a reason. Nobody approves a version
// they uploaded or edited. Only approved versions generate agreements; the version in use
// is the newest approved one whose effective date has come, so editing an approved
// version (a new version) leaves the current one in use until the new one is approved.
// Template text uses the SLAS markup (renderer.js) and is checked by rendering a sample
// agreement before it is saved.

const AgreementTemplate = require('../../models/AgreementTemplate');
const Agreement = require('../../models/Agreement');
const audit = require('../audit/auditService');
const calc = require('../calc/loanCalculator');
const { values, scheduleTable } = require('./agreementService');
const { render } = require('./renderer');
const { livePricing } = require('../products/productService');
const { namesOf } = require('../review/reviewView');
const { localDay, localMidnight } = require('../../utils/dates');
const { badRequest, conflict, forbidden, notFound } = require('../../utils/errors');

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
  const pay = { basic: 1850000, lfbDeductions: 0 };
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

const STATE_LABEL = { pending_legal_approval: 'Pending Legal Approval', approved: 'Approved', rejected: 'Rejected' };

async function list() {
  const now = new Date();
  const rows = await AgreementTemplate.find().sort({ createdAt: -1 }).lean();
  const current = await AgreementTemplate.active();
  const counts = new Map((await Agreement.aggregate([{ $group: { _id: '$templateVersion', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
  const names = await namesOf(rows.flatMap((r) => [r.loadedBy, r.approvedBy, r.rejectedBy]).filter(Boolean));
  const who = (id) => (id ? names.get(String(id))?.name || null : null);
  return rows.map((t) => {
    let state = t.status;
    if (t.status === 'approved') state = current && String(current._id) === String(t._id) ? 'current' : t.effectiveFrom && t.effectiveFrom > now ? 'scheduled' : 'retired';
    return {
      id: String(t._id),
      version: t.version,
      status: t.status,
      statusLabel: STATE_LABEL[t.status],
      state,
      effectiveFrom: t.effectiveFrom ? localDay(t.effectiveFrom) : null,
      sample: !!t.sample,
      note: t.note || '',
      basedOn: t.basedOnId ? String(t.basedOnId) : null,
      loadedAt: t.createdAt,
      loadedBy: who(t.loadedBy),
      editorIds: (t.editors || []).map(String),
      approvedBy: who(t.approvedBy),
      approvedAt: t.approvedAt || null,
      rejectedBy: who(t.rejectedBy),
      rejectedAt: t.rejectedAt || null,
      rejectionReason: t.rejectionReason || null,
      agreements: counts.get(t.version) || 0,
    };
  });
}

async function get(id) {
  const t = await AgreementTemplate.findById(id).lean();
  if (!t) return null;
  return { id: String(t._id), version: t.version, status: t.status, statusLabel: STATE_LABEL[t.status], body: t.body, note: t.note || '', effectiveFrom: t.effectiveFrom ? localDay(t.effectiveFrom) : null, editorIds: (t.editors || []).map(String), rejectionReason: t.rejectionReason || null, ...(await check(t.body, t.version)) };
}

function checkDate(effectiveFrom) {
  if (effectiveFrom < localDay()) throw badRequest('The date it is used from cannot be in the past.', { effectiveFrom: ['Today or later.'] }, 'DATE_INVALID');
}

/** Upload a new version (Legal Officer). body: { version, effectiveFrom, body, note } */
async function upload(req, body) {
  if (await AgreementTemplate.exists({ version: body.version })) throw conflict(`Version ${body.version} already exists. Use a new version number.`, 'VERSION_EXISTS');
  checkDate(body.effectiveFrom);
  const checked = await check(body.body, body.version);
  const t = await AgreementTemplate.create({ version: body.version, status: 'pending_legal_approval', body: body.body, effectiveFrom: localMidnight(body.effectiveFrom), loadedBy: req.auth.user._id, editors: [req.auth.user._id], note: body.note || '' });
  await audit.record({ req, action: 'template.upload', description: `Agreement template ${t.version} uploaded; pending Legal approval`, entity: 'AgreementTemplate', entityId: String(t._id), after: { version: t.version, status: t.status, effectiveFrom: body.effectiveFrom, sampleSha256: checked.textSha256 } });
  return t;
}

/**
 * Edit (Legal Officer). A pending or rejected version is changed in place and waits for
 * approval again; an approved version is never changed: the edit becomes a new version
 * (body.version required), and the approved one stays in use until it is approved.
 */
async function edit(req, id, body) {
  const t = await AgreementTemplate.findById(id);
  if (!t) throw notFound('Template not found.');
  if (body.effectiveFrom) checkDate(body.effectiveFrom);
  const checked = await check(body.body, body.version || t.version);
  if (t.status === 'approved') {
    if (!body.version || body.version === t.version) throw badRequest('Give the edited text a new version number. The approved version stays in use until the new one is approved.', { version: ['A new version number is required.'] }, 'NEW_VERSION_REQUIRED');
    if (await AgreementTemplate.exists({ version: body.version })) throw conflict(`Version ${body.version} already exists. Use a new version number.`, 'VERSION_EXISTS');
    const next = await AgreementTemplate.create({ version: body.version, status: 'pending_legal_approval', body: body.body, effectiveFrom: localMidnight(body.effectiveFrom || localDay()), basedOnId: t._id, loadedBy: req.auth.user._id, editors: [req.auth.user._id], note: body.note || '' });
    await audit.record({ req, action: 'template.edit', description: `Agreement template ${t.version} edited as new version ${next.version}; pending Legal approval (${t.version} stays in use)`, entity: 'AgreementTemplate', entityId: String(next._id), before: { version: t.version, status: t.status }, after: { version: next.version, status: next.status, basedOn: t.version, sampleSha256: checked.textSha256 } });
    return next;
  }
  const before = { body: t.body, note: t.note, status: t.status, effectiveFrom: t.effectiveFrom ? localDay(t.effectiveFrom) : null };
  t.body = body.body;
  if (body.note !== undefined) t.note = body.note;
  if (body.effectiveFrom) t.effectiveFrom = localMidnight(body.effectiveFrom);
  t.status = 'pending_legal_approval';
  t.rejectedBy = undefined;
  t.rejectedAt = undefined;
  t.rejectionReason = undefined;
  if (!t.editors.some((e) => String(e) === String(req.auth.user._id))) t.editors.push(req.auth.user._id);
  await t.save();
  await audit.record({ req, action: 'template.edit', description: `Agreement template ${t.version} edited; pending Legal approval`, entity: 'AgreementTemplate', entityId: String(t._id), before, after: { body: t.body, note: t.note, status: t.status, effectiveFrom: t.effectiveFrom ? localDay(t.effectiveFrom) : null, sampleSha256: checked.textSha256 } });
  return t;
}

async function decidable(req, id) {
  const t = await AgreementTemplate.findById(id);
  if (!t) throw notFound('Template not found.');
  if (t.status !== 'pending_legal_approval') throw conflict('Only a version pending Legal approval can be approved or rejected.', 'NOT_PENDING');
  if ([t.loadedBy, ...(t.editors || [])].some((u) => u && String(u) === String(req.auth.user._id))) throw forbidden('You uploaded or edited this version, so another approver must decide it.', 'SOD_SELF_APPROVAL');
  return t;
}

/** Head of Legal approves: the version can generate agreements from its effective date. */
async function approve(req, id) {
  const t = await decidable(req, id);
  const now = new Date();
  const done = await AgreementTemplate.findOneAndUpdate({ _id: t._id, status: 'pending_legal_approval' }, { $set: { status: 'approved', approvedBy: req.auth.user._id, approvedAt: now } }, { new: true });
  if (!done) throw conflict('Someone else has just decided this version. Reload the list.', 'STATE_CHANGED');
  await audit.record({ req, action: 'template.approve', description: `Agreement template ${t.version} approved by the Head of Legal; used from ${localDay(t.effectiveFrom || now)}`, entity: 'AgreementTemplate', entityId: String(t._id), before: { status: 'pending_legal_approval' }, after: { status: 'approved', approvedAt: now } });
  return done;
}

async function reject(req, id, reason) {
  const why = (reason || '').trim();
  if (!why) throw badRequest('Give a reason for the rejection.', { reason: ['Give a reason for the rejection.'] }, 'REASON_REQUIRED');
  const t = await decidable(req, id);
  const now = new Date();
  const done = await AgreementTemplate.findOneAndUpdate({ _id: t._id, status: 'pending_legal_approval' }, { $set: { status: 'rejected', rejectedBy: req.auth.user._id, rejectedAt: now, rejectionReason: why } }, { new: true });
  if (!done) throw conflict('Someone else has just decided this version. Reload the list.', 'STATE_CHANGED');
  await audit.record({ req, action: 'template.reject', description: `Agreement template ${t.version} rejected by the Head of Legal: ${why}`, entity: 'AgreementTemplate', entityId: String(t._id), before: { status: 'pending_legal_approval' }, after: { status: 'rejected', reason: why } });
  return done;
}

module.exports = { list, get, upload, edit, approve, reject, preview, REQUIRED };

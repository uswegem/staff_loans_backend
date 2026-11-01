'use strict';

// What a reviewer sees (FR-14) and the limited-details projection (FR-55).
//
// The limited view is built from an allow-list, never by deleting fields from the full
// view, so nothing new can leak into it by accident: name, mobile number and NIDA
// number, the route and status, and the Credit Analyst's own bureau result and
// decisions. Product, amount, tenor, purpose, salary, affordability, documents, the
// agreement and other reviewers' comments are never included.

const Decision = require('../../models/Decision');
const Agreement = require('../../models/Agreement');
const Staff = require('../../models/Staff');
const User = require('../../models/User');
const StoredFile = require('../../models/StoredFile');
const ProductVersion = require('../../models/ProductVersion');
const PricingVersion = require('../../models/PricingVersion');
const calendar = require('../calendar/calendarService');
const workingTime = require('../calendar/workingTime');
const rules = require('../applications/rules');
const appSvc = require('../applications/applicationService');
const { STAGES, ROUTES } = require('../workflow/routes');
const { STATUS } = require('../../constants/statuses');
const { formatNida } = require('../staff/profileService');
const { localDay } = require('../../utils/dates');

const fullName = (s) => (s ? [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ') : '');
const stageName = (k) => (k ? STAGES[k].short || STAGES[k].label : null);

async function namesOf(ids) {
  const users = await User.find({ _id: { $in: ids.filter(Boolean) } }).select('staffId staffNo').lean();
  const staff = await Staff.find({ _id: { $in: users.map((u) => u.staffId) } }).select('firstName middleName lastName title').lean();
  const byId = new Map(staff.map((s) => [String(s._id), s]));
  return new Map(users.map((u) => [String(u._id), { name: fullName(byId.get(String(u.staffId))), title: byId.get(String(u.staffId))?.title, staffNo: u.staffNo }]));
}

async function due(app) {
  if (!app.currentStage || !app.stageEnteredAt) return null;
  const cal = await calendar.load();
  const target = STAGES[app.currentStage].target === 'ceo' ? cal.ceoTargetHours : cal.stageTargetHours;
  const d = workingTime.dueInfo(cal, app.stageEnteredAt, target);
  return { dueAt: d.dueAt, overdue: d.overdue, hoursLeft: Math.round(d.hoursLeft * 10) / 10, hoursOverdue: Math.round(d.hoursOverdue * 10) / 10, targetHours: target };
}

function routeInfo(app) {
  const r = ROUTES[app.route];
  return { key: app.route, label: r?.label, stages: app.stages, stageLabels: app.stages.map(stageName), limitedCredit: r?.limitedCredit };
}

/** Options for the decision panel at the current stage. */
function panelFor(app, actor) {
  if (!actor) return null;
  const stage = app.currentStage;
  const i = app.stages.indexOf(stage);
  const limited = ROUTES[app.route].limitedCredit;
  return {
    stage,
    stageLabel: stageName(stage),
    onBehalfOf: actor.onBehalfOfName || null,
    isFinal: i === app.stages.length - 1,
    nextStageLabel: stageName(app.stages[i + 1]) || null,
    needsCrb: stage === 'credit',
    canRecommend: stage === 'credit' && !limited,
    needsHrChecks: stage === 'hr' || stage === 'pcm',
    needsProbationCheck: (stage === 'hr' || stage === 'pcm') && !!app.probation?.onProbation,
    crbOutcomes: ['Clear', 'Adverse: minor', 'Adverse: serious', 'No record found'],
  };
}

/** Limited details (FR-55). Allow-list only. */
async function limitedView(auth, app, actor) {
  const [staff, mine] = await Promise.all([
    Staff.findById(app.applicantStaffId).select('firstName middleName lastName personal.mobile personal.nida').lean(),
    Decision.find({ applicationId: app._id, actorId: auth.user._id }).sort({ at: 1 }).lean(),
  ]);
  return {
    id: String(app._id),
    ref: app.ref,
    limited: true,
    status: app.status,
    statusLabel: STATUS[app.status],
    currentStage: app.currentStage,
    stageEnteredAt: app.stageEnteredAt,
    due: await due(app),
    route: routeInfo(app),
    submittedAt: app.submittedAt,
    applicant: { fullName: fullName(staff), mobile: staff?.personal?.mobile || null, nida: formatNida(staff?.personal?.nida) || null },
    crb: app.crb?.outcome ? { outcome: app.crb.outcome, reportDate: app.crb.reportDate ? localDay(app.crb.reportDate) : null } : null,
    myDecisions: mine.map((d) => ({ action: d.action, stage: d.stage, comment: d.comment, at: d.at })),
    panel: panelFor(app, actor),
  };
}

/** Full review view (FR-14). */
async function fullView(req, app, actor) {
  const [staff, decisions, agreements, docs, version, pricing] = await Promise.all([
    Staff.findById(app.applicantStaffId).lean(),
    Decision.find({ applicationId: app._id }).sort({ at: 1 }).lean(),
    Agreement.find({ applicationId: app._id }).sort({ createdAt: -1 }).select('-text -schedule').lean(),
    StoredFile.find({ _id: { $in: [...app.documentIds, app.crb?.fileId].filter(Boolean) }, removedAt: null }).lean(),
    ProductVersion.findById(app.productVersionId).lean(),
    PricingVersion.findById(app.pricingVersionId).lean(),
  ]);
  const names = await namesOf([...decisions.flatMap((d) => [d.actorId, d.onBehalfOfId]), app.recommended?.by]);

  // Fresh rule checks on the pinned versions, with the applicant's current record.
  const ctx = await appSvc.context(req, app.productId, {
    app,
    versions: { product: { _id: app.productId }, version, pricing },
    applicant: { userId: app.applicantUserId, staffId: app.applicantStaffId },
  });
  const result = rules.evaluate(ctx, appSvc.inputOf(app));
  const snapshot = app.calcSnapshot ? { ...app.calcSnapshot, schedule: undefined } : null;
  const running = ctx.apps.filter((a) => String(a._id) !== String(app._id) && ['pending_disbursement', 'disbursed'].includes(a.status));

  return {
    id: String(app._id),
    ref: app.ref,
    limited: false,
    status: app.status,
    statusLabel: STATUS[app.status],
    currentStage: app.currentStage,
    stageEnteredAt: app.stageEnteredAt,
    due: await due(app),
    route: routeInfo(app),
    cycle: app.cycle,
    submittedAt: app.submittedAt,
    lastSubmittedAt: app.lastSubmittedAt,
    product: { id: String(app.productId), versionId: String(version._id), version: version.version, name: version.name, fields: version.fields, disbursementConditions: version.disbursementConditions },
    amount: app.amount,
    tenor: app.tenor,
    purpose: app.purpose,
    productFields: app.productFields || {},
    repayment: app.repayment,
    topUp: app.topUp,
    probation: app.probation?.onProbation ? { onProbation: true, reason: app.probation.reason, verifiedAt: app.probation.verifiedAt } : { onProbation: false },
    ruleFlags: app.ruleFlags,
    calcAtSubmission: snapshot,
    checks: [...result.eligibility.filter((m) => !/open .* application/.test(m) && !/You applied for/.test(m)), ...result.checks],
    crb: app.crb?.outcome ? { outcome: app.crb.outcome, reportDate: app.crb.reportDate ? localDay(app.crb.reportDate) : null, fileId: app.crb.fileId ? String(app.crb.fileId) : null } : null,
    appraisalNote: app.appraisalNote || null,
    arrearsNote: app.arrearsNote || null,
    recommended: app.recommended?.amount ? { amount: app.recommended.amount, tenor: app.recommended.tenor, reason: app.recommended.reason, by: names.get(String(app.recommended.by))?.name } : null,
    hrChecks: app.hrChecks || null,
    approved: app.approved?.amount ? app.approved : null,
    applicant: {
      fullName: fullName(staff),
      staffNo: staff.staffNo,
      title: staff.title,
      department: staff.department,
      station: staff.station,
      category: staff.category,
      employmentType: staff.employmentType,
      dateJoined: localDay(staff.dateJoined),
      retirementDate: staff.retirementDate ? localDay(staff.retirementDate) : null,
      contractEndDate: staff.contractEndDate ? localDay(staff.contractEndDate) : null,
      nida: formatNida(staff.personal?.nida),
      mobile: staff.personal?.mobile,
      nextOfKin: staff.nextOfKin?.[0] || null,
      existingLfbLoans: (staff.existingLfbLoans || []).map((l) => ({ description: l.description, instalment: l.instalment })),
      salaryAtSubmission: app.applicantSnapshot?.salary || null, // People and Culture's record, to check the payslip against
      runningLoans: running.map((r) => ({ ref: r.ref, amount: r.approved?.amount, status: r.status })),
    },
    documents: docs.filter((d) => d.kind === 'document').map(appSvc.DOC_VIEW),
    // D-79: what affordability used, and the payslip it was read from.
    payslip: app.payslip?.fileId ? { fileId: String(app.payslip.fileId), originalName: app.payslip.originalName, payDate: app.payslip.payDate, basic: app.payslip.basic, lfbDeductions: app.payslip.lfbDeductions, lfbLines: app.payslip.lfbLines || [] } : null,
    crbReport: docs.find((d) => d.kind === 'crb_report') ? appSvc.DOC_VIEW(docs.find((d) => d.kind === 'crb_report')) : null,
    agreements: agreements.map((a) => ({ id: String(a._id), number: a.number, kind: a.kind, status: a.status, templateVersion: a.templateVersion, terms: a.terms, signedAt: a.acceptance?.at, effectiveAt: a.effectiveAt, voidAt: a.voidAt, voidReason: a.voidReason })),
    history: decisions.map((d) => ({
      action: d.action,
      stage: d.stage,
      stageLabel: stageName(d.stage),
      comment: d.comment,
      at: d.at,
      cycle: d.cycle,
      by: names.get(String(d.actorId))?.name || null,
      byTitle: names.get(String(d.actorId))?.title || null,
      onBehalfOf: d.onBehalfOfId ? names.get(String(d.onBehalfOfId))?.name : null,
      details: d.details || null,
    })),
    panel: panelFor(app, actor),
  };
}

async function reviewView(req, app, access) {
  const actor = access.actor;
  if (actor?.onBehalfOf) actor.onBehalfOfName = (await namesOf([actor.onBehalfOf])).get(actor.onBehalfOf)?.name;
  return access.limited ? limitedView(req.auth, app, actor) : fullView(req, app, actor);
}

/** A queue row: the same allow-list for limited applications. */
async function queueRow(app, { limited, actor, names }) {
  const staff = await Staff.findById(app.applicantStaffId).select('firstName middleName lastName title category').lean();
  const base = {
    id: String(app._id),
    ref: app.ref,
    limited,
    status: app.status,
    statusLabel: STATUS[app.status],
    currentStage: app.currentStage,
    stageLabel: stageName(app.currentStage),
    route: { key: app.route, label: ROUTES[app.route]?.label },
    due: await due(app),
    applicant: { fullName: fullName(staff) },
    onBehalfOf: actor?.onBehalfOf ? names?.get(actor.onBehalfOf)?.name || null : null,
  };
  if (limited) return base;
  const version = await ProductVersion.findById(app.productVersionId).select('name').lean();
  return { ...base, applicant: { ...base.applicant, title: staff.title, category: staff.category }, product: version?.name, amount: app.recommended?.amount || app.amount, tenor: app.recommended?.tenor || app.tenor };
}

module.exports = { reviewView, queueRow, namesOf, due, stageName, fullName };

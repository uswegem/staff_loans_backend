'use strict';

// The applicant's side of an application (BRD 9.2: FR-05 to FR-12; BRD 8: FR-33 to
// FR-37): drafts, live checks, the agreement preview, sign-and-submit and withdrawal.

const Application = require('../../models/Application');
const Agreement = require('../../models/Agreement');
const Decision = require('../../models/Decision');
const Notification = require('../../models/Notification');
const Staff = require('../../models/Staff');
const Salary = require('../../models/Salary');
const Settings = require('../../models/Settings');
const ProductVersion = require('../../models/ProductVersion');
const PricingVersion = require('../../models/PricingVersion');
const Counter = require('../../models/Counter');
const StoredFile = require('../../models/StoredFile');
const audit = require('../audit/auditService');
const notify = require('../notify/notificationService');
const calendar = require('../calendar/calendarService');
const workingTime = require('../calendar/workingTime');
const products = require('../products/productService');
const rules = require('./rules');
const agreementService = require('../agreement/agreementService');
const { agreementPdf } = require('../agreement/pdfService');
const fileStore = require('../files/fileStore');
const { completeness } = require('../staff/profileService');
const { routeFor, STAGES } = require('../workflow/routes');
const { STATUS, EDITABLE, WITHDRAWABLE } = require('../../constants/statuses');
const { withTransaction } = require('../../config/db');
const { localDay } = require('../../utils/dates');
const { AppError, badRequest, conflict, notFound } = require('../../utils/errors');

const fullName = (s) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

/**
 * Loads what the rules need for an applicant and a product (live versions unless pinned).
 * The applicant is the signed-in user, or opts.applicant { userId, staffId } for reviewers.
 */
async function context(req, productId, { app, versions, applicant } = {}) {
  const who = applicant || { userId: req.auth.user._id, staffId: req.auth.user.staffId };
  const staff = await Staff.findById(who.staffId);
  if (!staff) throw notFound('Your staff record was not found. Contact People and Culture.');
  const [salary, profile, settings, apps] = await Promise.all([
    Salary.inForce(staff._id),
    completeness(staff),
    Settings.get(),
    Application.find({ applicantUserId: who.userId }).lean(),
  ]);
  let product;
  let version;
  let pricing;
  if (versions) {
    ({ product, version, pricing } = versions);
  } else {
    const live = await products.liveProductVersion(productId);
    product = live.product;
    version = live.version;
    pricing = await products.livePricing();
    if (!version) throw new AppError(400, 'PRODUCT_UNAVAILABLE', 'This product is not available for new applications.');
    if (!pricing) throw new AppError(500, 'NO_PRICING', 'No pricing is in force. Contact the System Administrator.');
  }
  return { staff, salary, profile, settings, product, version, pricing, apps, appId: app?._id, today: localDay() };
}

function inputOf(app) {
  return {
    amount: app.amount,
    tenor: app.tenor,
    purpose: app.purpose,
    productFields: app.productFields || {},
    repayment: app.repayment || { method: 'payroll' },
    topUp: app.topUp || { on: false },
    probationReason: app.probation?.reason,
    payslip: app.payslip?.fileId ? app.payslip : null,
  };
}

async function own(req, id) {
  const app = await Application.findById(id);
  if (!app || String(app.applicantUserId) !== String(req.auth.user._id)) throw notFound('Application not found.');
  return app;
}

/** Product version shown for an application: pinned once submitted, live while a draft. */
async function versionsFor(app) {
  if (app.status === 'draft' || app.status === 'returned') {
    const live = await products.liveProductVersion(app.productId);
    const pricing = await products.livePricing();
    return { product: live.product, version: live.version || (await ProductVersion.findById(app.productVersionId)), pricing, live: !!live.version };
  }
  const [version, pricing] = await Promise.all([ProductVersion.findById(app.productVersionId), PricingVersion.findById(app.pricingVersionId)]);
  const { product } = await products.liveProductVersion(app.productId);
  return { product, version, pricing, live: true };
}

const DOC_VIEW = (f) => ({ id: String(f._id), label: f.label, originalName: f.originalName, mime: f.mime, size: f.size, uploadedAt: f.createdAt });

async function view(req, app) {
  const v = await versionsFor(app);
  const ctx = await context(req, app.productId, { app, versions: v });
  const result = rules.evaluate(ctx, inputOf(app));
  const [decisions, agreements, docs] = await Promise.all([
    Decision.find({ applicationId: app._id }).sort({ at: 1 }).lean(),
    Agreement.find({ applicationId: app._id }).sort({ createdAt: -1 }).select('-text -schedule').lean(),
    StoredFile.find({ _id: { $in: app.documentIds }, removedAt: null }).lean(),
  ]);
  const route = app.route ? { key: app.route, stages: app.stages } : (() => {
    const r = routeFor(req.auth.permissions, ctx.staff);
    return { key: r.key, stages: r.stages };
  })();
  return {
    id: String(app._id),
    ref: app.ref,
    status: app.status,
    statusLabel: STATUS[app.status],
    currentStage: app.currentStage,
    stageEnteredAt: app.stageEnteredAt,
    stageDueAt: app.stageDueAt,
    route: { ...route, stageLabels: route.stages.map((s) => STAGES[s].short || STAGES[s].label) },
    cycle: app.cycle,
    submittedAt: app.submittedAt,
    product: { id: String(app.productId), versionId: String(v.version._id), available: v.live, ...pick(v.version) },
    pricing: v.pricing ? { interestBps: v.pricing.interestBps, processingFeeBps: v.pricing.processingFeeBps, processingFeeTopUpBps: v.pricing.processingFeeTopUpBps, insuranceBps: v.pricing.insuranceBps, affordabilityBps: v.pricing.affordabilityBps, pensionBps: v.pricing.pensionBps, instalmentRounding: v.pricing.instalmentRounding, payeBands: v.pricing.payeBands } : null,
    amount: app.amount ?? null,
    tenor: app.tenor ?? null,
    purpose: app.purpose || '',
    productFields: app.productFields || {},
    repayment: app.repayment,
    topUp: app.topUp,
    probation: { onProbation: result.onProbation, endsOn: result.probation.endsOn, reason: app.probation?.reason || '' },
    approved: app.approved?.amount ? app.approved : null,
    // FR-25: the schedule for the agreement in force, from final approval or, once
    // OPS confirms, from the disbursement date (FR-21, FR-24).
    schedule: app.schedule?.length ? app.schedule : null,
    scheduleBasis: app.scheduleBasis || null,
    disbursement: app.disbursement?.date ? { date: localDay(app.disbursement.date), transactionRef: app.disbursement.transactionRef || null } : null,
    payslip: app.payslip?.fileId ? { fileId: String(app.payslip.fileId), originalName: app.payslip.originalName, payDate: app.payslip.payDate, basic: app.payslip.basic, lfbDeductions: app.payslip.lfbDeductions, lfbLines: app.payslip.lfbLines || [], readAt: app.payslip.readAt } : null,
    payslipMaxAgeDays: ctx.settings.payslipMaxAgeDays || 45,
    documents: docs.map(DOC_VIEW),
    agreements: agreements.map((a) => ({ id: String(a._id), number: a.number, kind: a.kind, status: a.status, templateVersion: a.templateVersion, terms: a.terms, signedAt: a.acceptance?.at, effectiveAt: a.effectiveAt, voidAt: a.voidAt, voidReason: a.voidReason })),
    history: decisions.map((d) => ({ action: d.action, stage: d.stage, comment: d.comment, at: d.at, cycle: d.cycle, mine: String(d.actorId) === String(req.auth.user._id) })),
    checks: { eligibility: result.eligibility, fieldErrors: result.fieldErrors, checks: result.checks, canSubmit: result.canSubmit },
    payInputs: result.pay,
    quote: summariseQuote(result.quote),
    firstDueDay: ctx.settings.firstDueDay || 25,
    editable: EDITABLE.includes(app.status),
    withdrawable: WITHDRAWABLE.includes(app.status),
    bank: ctx.staff.bank,
  };
}

function pick(v) {
  return {
    name: v.name,
    description: v.description,
    minAmount: v.minAmount,
    maxAmount: v.maxAmount,
    minTenor: v.minTenor,
    maxTenor: v.maxTenor,
    topUpAllowed: v.topUpAllowed,
    repaymentMethods: v.repaymentMethods,
    fields: v.fields,
    requiredDocuments: v.requiredDocuments,
    optionalDocuments: v.optionalDocuments,
  };
}

const summariseQuote = (q) => ({ ...q, schedule: undefined, scheduleLength: q.schedule.length, lastDueDate: q.schedule.at(-1)?.due || null });

async function nextRef(prefix, session) {
  const year = new Date().getFullYear();
  const seq = await Counter.next(`${prefix}-${year}`, session);
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

// ---------- drafts ----------

/** BRD 12: starting an application with an incomplete profile tells the applicant what is missing (once while unread). */
async function notifyProfileIncomplete(userId, profile) {
  if (await Notification.exists({ userId, type: 'profile.incomplete', readAt: null })) return;
  await notify.notifyUsers([userId], { type: 'profile.incomplete', text: `Complete your profile to apply. Missing: ${profile.missing.map((m) => m.label).join(', ')}.`, href: '/profile' });
}

async function createDraft(req, productId) {
  const ctx = await context(req, productId);
  const elig = rules.eligibility(ctx);
  if (!ctx.profile.complete) await notifyProfileIncomplete(req.auth.user._id, ctx.profile);
  if (elig.messages.length) throw badRequest(elig.messages[0], { eligibility: elig.messages }, 'NOT_ELIGIBLE');
  const app = await withTransaction(async (session) => {
    const [a] = await Application.create(
      [
        {
          ref: await nextRef('SL', session),
          applicantUserId: req.auth.user._id,
          applicantStaffId: ctx.staff._id,
          productId: ctx.product._id,
          productVersionId: ctx.version._id,
          status: 'draft',
          repayment: { method: ctx.version.repaymentMethods[0] },
          probation: { onProbation: elig.onProbation },
        },
      ],
      { session }
    );
    await Decision.create([{ applicationId: a._id, cycle: 0, action: 'create', actorId: req.auth.user._id, ip: req.ip }], { session });
    await audit.record({ req, action: 'application.create', description: `${a.ref} started (${ctx.version.name})`, entity: 'Application', entityId: String(a._id), appRef: a.ref }, { session });
    return a;
  });
  return app;
}

async function update(req, app, body) {
  if (!EDITABLE.includes(app.status)) throw conflict('This application can no longer be changed.', 'NOT_EDITABLE');
  const staff = await Staff.findById(app.applicantStaffId);
  const before = inputOf(app);
  ['amount', 'tenor', 'purpose', 'productFields'].forEach((k) => {
    if (body[k] !== undefined) app[k] = body[k];
  });
  if (body.repaymentMethod) {
    app.repayment = body.repaymentMethod === 'account' ? { method: 'account', bank: staff.bank?.bank, branch: staff.bank?.branch, accountName: staff.bank?.accountName, accountNo: staff.bank?.accountNo } : { method: 'payroll' };
  }
  if (body.topUp !== undefined) app.topUp = body.topUp.on ? body.topUp : { on: false };
  if (body.probationReason !== undefined) app.set('probation.reason', body.probationReason);
  app.markModified('productFields');
  await app.save();
  await audit.record({ req, action: 'application.update', description: `${app.ref} request edited`, entity: 'Application', entityId: String(app._id), appRef: app.ref, before, after: inputOf(app) });
  return app;
}

// ---------- agreement ----------

async function agreementFor(req, app, { session } = {}) {
  const ctx = await context(req, app.productId, { app });
  const result = rules.evaluate(ctx, inputOf(app));
  if (!result.canSubmit) {
    throw badRequest('Fix the application before you sign.', { eligibility: result.eligibility, fieldErrors: result.fieldErrors, checks: result.checks }, 'NOT_READY');
  }
  const doc = await agreementService.build(
    { ref: app.ref, kind: 'original', staff: ctx.staff, product: ctx.version, quote: result.quote, amount: app.amount, tenor: app.tenor, repayment: app.repayment, topUp: app.topUp },
    { session }
  );
  return { ctx, result, doc };
}

async function preview(req, app) {
  if (!EDITABLE.includes(app.status)) throw conflict('This application is not waiting for your signature.', 'NOT_EDITABLE');
  const { doc, result } = await agreementFor(req, app);
  const q = result.quote;
  return {
    blocks: doc.blocks,
    textSha256: doc.textSha256,
    template: doc.template,
    terms: { amount: app.amount, tenor: app.tenor, instalment: q.instalment, fees: q.fees, processingFee: q.processingFee, insuranceFee: q.insuranceFee, totalInterest: q.totalInterest, totalRepayable: q.totalRepayable, firstDueDate: q.firstDueDate },
    replaces: app.currentAgreementId ? String(app.currentAgreementId) : null,
  };
}

// ---------- sign and submit (FR-10, FR-33 to FR-37) ----------

async function signAndSubmit(req, app, body) {
  if (!EDITABLE.includes(app.status)) throw conflict('This application has already been submitted.', 'NOT_EDITABLE');
  const consentsGiven = ['truth', 'deduct', 'crb', 'sms'].every((k) => body.consents?.[k] === true);
  if (!consentsGiven || body.accepted !== true) throw badRequest('Tick every statement and the agreement to sign.', undefined, 'CONSENTS_REQUIRED');
  if (body.scrolledToEnd !== true) throw badRequest('Read the agreement to the end before you sign.', undefined, 'NOT_READ');

  const { ctx, result, doc } = await agreementFor(req, app);
  if (doc.textSha256 !== body.textSha256) {
    throw conflict('The agreement changed since you opened it. Read it again before you sign.', 'AGREEMENT_CHANGED', { textSha256: doc.textSha256 });
  }

  const AuthController = require('../../controllers/authController');
  const check = await AuthController.verifyPassword(req.auth.user, body.password, req);
  if (!check.ok) {
    if (check.remainingAttempts === 0) throw new AppError(423, 'ACCOUNT_LOCKED', 'Your account is locked after too many failed attempts. Contact the IT Service Desk to unlock it.');
    throw new AppError(401, 'PASSWORD_WRONG', 'Your password is not right.', { password: ['Your password is not right.'], remainingAttempts: check.remainingAttempts });
  }

  const now = new Date();
  const resubmission = app.status === 'returned';
  const route = app.route ? { key: app.route, stages: app.stages } : routeFor(req.auth.permissions, ctx.staff);
  const firstStage = route.stages[0];
  const cal = await calendar.load();
  const stageDueAt = workingTime.addWorkingHours(cal, now, STAGES[firstStage].target === 'ceo' ? cal.ceoTargetHours : cal.stageTargetHours);
  const staffName = fullName(ctx.staff);

  const number = await nextRef('MKT');
  const evidence = [
    ['Namba ya mkataba / Agreement number', number],
    ['Maombi / Application', app.ref],
    ['Mwajiriwa / Staff member', `${staffName} (${ctx.staff.staffNo})`],
    ['Tarehe na saa / Accepted at', `${now.toISOString()} (UTC)`],
    ['Anwani ya IP / IP address', req.ip],
    ['Toleo la mkataba / Template version', doc.template.version],
    ['Alama ya maandishi (SHA-256) / Text fingerprint', doc.textSha256],
    ['Idhini / Consents', 'Taarifa ni sahihi; makato; ofisi za kumbukumbu za mikopo; SMS'],
  ];
  const pdf = await agreementPdf({ blocks: doc.blocks, title: `Mkataba ${number} (${app.ref})`, evidence });

  await withTransaction(async (session) => {
    const fresh = await Application.findOne({ _id: app._id, status: { $in: EDITABLE } }).session(session);
    if (!fresh) throw conflict('This application has already been submitted.', 'NOT_EDITABLE');

    if (fresh.currentAgreementId) {
      await Agreement.updateOne({ _id: fresh.currentAgreementId, status: 'signed' }, { $set: { status: 'void', voidAt: now, voidReason: 'Replaced by a new signed version on resubmission' } }, { session });
    }
    const pdfFile = await fileStore.store(pdf, { kind: 'agreement_pdf', originalName: `${number}.pdf`, applicationId: fresh._id, ownerUserId: req.auth.user._id, uploadedBy: req.auth.user._id }, { session });
    const q = result.quote;
    const [agreement] = await Agreement.create(
      [
        {
          number,
          applicationId: fresh._id,
          kind: 'original',
          templateId: doc.template.id,
          templateVersion: doc.template.version,
          terms: { amount: fresh.amount, tenor: fresh.tenor, instalment: q.instalment, interestBps: q.rates.interestBps, processingFee: q.processingFee, insuranceFee: q.insuranceFee, totalInterest: q.totalInterest, totalRepayable: q.totalRepayable, firstDueDate: q.firstDueDate, repaymentMethod: fresh.repayment.method },
          schedule: q.schedule,
          text: doc.text,
          textSha256: doc.textSha256,
          pdfFileId: pdfFile._id,
          pdfSha256: pdfFile.sha256,
          acceptance: { userId: req.auth.user._id, staffNo: ctx.staff.staffNo, fullName: staffName, at: now, ip: req.ip, userAgent: req.get('User-Agent') },
          status: 'signed',
        },
      ],
      { session }
    );

    Object.assign(fresh, {
      status: STAGES[firstStage].status,
      currentStage: firstStage,
      route: route.key,
      stages: route.stages,
      stageEnteredAt: now,
      stageDueAt,
      cycle: (fresh.cycle || 0) + 1,
      submittedAt: fresh.submittedAt || now,
      lastSubmittedAt: now,
      productVersionId: ctx.version._id,
      pricingVersionId: ctx.pricing._id,
      consents: { ...body.consents, at: now },
      currentAgreementId: agreement._id,
      calcSnapshot: q,
      applicantSnapshot: {
        staffNo: ctx.staff.staffNo,
        fullName: staffName,
        category: ctx.staff.category,
        employmentType: ctx.staff.employmentType,
        title: ctx.staff.title,
        station: ctx.staff.station,
        dateJoined: ctx.staff.dateJoined,
        retirementDate: ctx.staff.retirementDate,
        salary: ctx.salary ? { basic: ctx.salary.basic, allowances: ctx.salary.allowances, effectiveFrom: ctx.salary.effectiveFrom } : null,
        pay: result.pay,
        payslip: { fileId: fresh.payslip.fileId, payDate: fresh.payslip.payDate, basic: fresh.payslip.basic, lfbDeductions: fresh.payslip.lfbDeductions, lfbLines: fresh.payslip.lfbLines },
      },
      ruleFlags: result.flags,
      recommended: undefined,
      approved: undefined,
      hrChecks: undefined,
    });
    fresh.set('probation.onProbation', result.onProbation);
    await fresh.save({ session });
    await Staff.updateOne({ _id: ctx.staff._id }, { $set: { lastAppliedAt: now } }, { session });

    await Decision.create(
      [{ applicationId: fresh._id, cycle: fresh.cycle, stage: null, action: resubmission ? 'resubmit' : 'submit', actorId: req.auth.user._id, comment: `${fresh.amount.toLocaleString('en-US')} over ${fresh.tenor} months, agreement ${number}`, details: { agreementNumber: number, textSha256: doc.textSha256 }, at: now, ip: req.ip }],
      { session }
    );
    await audit.record(
      { req, action: resubmission ? 'application.resubmit' : 'application.submit', description: `${fresh.ref} ${resubmission ? 'resubmitted' : 'submitted'}; agreement ${number} signed (template ${doc.template.version}, fingerprint ${doc.textSha256.slice(0, 16)}…)`, entity: 'Application', entityId: String(fresh._id), appRef: fresh.ref, after: { status: fresh.status, route: fresh.route, agreement: number, textSha256: doc.textSha256, pdfSha256: pdfFile.sha256 } },
      { session }
    );

    // Notifications (BRD 12): the applicant, and the first stage's reviewers (a delegate in
    // place of a holder who is away, FR-19).
    await notify.notifyUsers([req.auth.user._id], { type: 'application.submitted', text: `${fresh.ref} is submitted. Your agreement ${number} is signed and takes effect on final approval.`, href: `/applications/${fresh._id}`, entity: 'Application', entityId: String(fresh._id) }, { session });
    const actors = await require('../workflow/workflowService').stageActors(fresh, { session });
    const limited = ['mgmt', 'ceo', 'hrhead'].includes(route.key);
    await notify.notifyUsers(actors.map((a) => a.userId), { type: 'application.stage', text: `${fresh.ref} from ${staffName} is waiting for your ${STAGES[firstStage].short || STAGES[firstStage].label} review${limited && firstStage === 'credit' ? ' (limited details)' : ''}`, href: `/review/${fresh._id}`, entity: 'Application', entityId: String(fresh._id) }, { exclude: [req.auth.user._id], session });
  });
  return Application.findById(app._id);
}

// ---------- withdraw (FR-11) ----------

async function withdraw(req, app, reason) {
  if (!WITHDRAWABLE.includes(app.status)) throw conflict('This application can no longer be withdrawn.', 'NOT_WITHDRAWABLE');
  const now = new Date();
  await withTransaction(async (session) => {
    const fresh = await Application.findOneAndUpdate(
      { _id: app._id, status: { $in: WITHDRAWABLE } },
      { $set: { status: 'withdrawn', closedAtStage: app.currentStage, closedReason: reason || null, closedAt: now, currentStage: null } },
      { new: true, session }
    );
    if (!fresh) throw conflict('This application can no longer be withdrawn.', 'NOT_WITHDRAWABLE');
    if (app.currentAgreementId) await Agreement.updateOne({ _id: app.currentAgreementId, status: 'signed' }, { $set: { status: 'void', voidAt: now, voidReason: 'Application withdrawn' } }, { session });
    await Decision.create([{ applicationId: app._id, cycle: app.cycle, stage: app.currentStage, action: 'withdraw', actorId: req.auth.user._id, comment: reason, at: now, ip: req.ip }], { session });
    await audit.record({ req, action: 'application.withdraw', description: `${app.ref} withdrawn${reason ? `: ${reason}` : ''}`, entity: 'Application', entityId: String(app._id), appRef: app.ref, before: { status: app.status }, after: { status: 'withdrawn' } }, { session });
  });
  return Application.findById(app._id);
}

module.exports = { context, own, view, createDraft, update, preview, signAndSubmit, withdraw, inputOf, DOC_VIEW, nextRef, summariseQuote };

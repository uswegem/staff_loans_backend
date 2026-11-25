'use strict';

// Review decisions and what follows them (BRD 7, 8; FR-15 to FR-19, FR-24, FR-36,
// FR-39, FR-42, FR-54 to FR-56; NS-01).

const Application = require('../../models/Application');
const Agreement = require('../../models/Agreement');
const Decision = require('../../models/Decision');
const Staff = require('../../models/Staff');
const Settings = require('../../models/Settings');
const ProductVersion = require('../../models/ProductVersion');
const PricingVersion = require('../../models/PricingVersion');
const audit = require('../audit/auditService');
const notify = require('../notify/notificationService');
const calendar = require('../calendar/calendarService');
const workingTime = require('../calendar/workingTime');
const calc = require('../calc/loanCalculator');
const rules = require('../applications/rules');
const appSvc = require('../applications/applicationService');
const agreementService = require('../agreement/agreementService');
const { declarationsOf, allDeclared } = require('../agreement/renderer');
const { agreementPdf, textBlocks } = require('../agreement/pdfService');
const { translate } = require('../../i18n');
const dataProtection = require('../consent/dataProtection');
const fileStore = require('../files/fileStore');
const workflow = require('../workflow/workflowService');
const { capCheck } = require('../applications/capCheck');
const { namesOf, stageName, decisionStage, fullName } = require('./reviewView');
const { STAGES, PC_STAGES } = require('../workflow/routes');
const { validApprovals, returnTargets } = require('./approvals');
const { withTransaction } = require('../../config/db');
const { localDay, localMidnight } = require('../../utils/dates');
const { AppError, badRequest, conflict, forbidden, notFound } = require('../../utils/errors');
const StoredFile = require('../../models/StoredFile');
const AgreementTemplate = require('../../models/AgreementTemplate');

const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;
const DAY = 24 * 3600 * 1000;

async function notifyOps(text, href, entityId, session, type = 'application.ready_to_disburse') {
  return notify.notifyPermission('disb.confirm', { type, text, href, entity: 'Application', entityId }, { session });
}

/** D-107: a finally approved loan is booked in core banking by People and Culture first. */
async function notifyBookers(text, href, entityId, session, type = 'application.ready_to_book') {
  return notify.notifyPermission('loan.book', { type, text, href, entity: 'Application', entityId }, { session });
}

/** Approvals in this cycle, as printed "kwa niaba ya Mwajiri" (FR-36). */
async function approvalsFor(app, extra, session) {
  // Approvals still in force: one cancelled by a return to an earlier stage is not printed (D-106).
  const history = await Decision.find({ applicationId: app._id, cycle: app.cycle, action: { $in: ['approve', 'return'] } }).sort({ at: 1 }).session(session || null).lean();
  const rows = validApprovals(history, app.stages || []);
  const all = [...rows.map((d) => ({ actorId: d.actorId, onBehalfOfId: d.onBehalfOfId, stage: d.stage, details: d.details, at: d.at })), ...(extra ? [extra] : [])];
  const names = await namesOf(all.flatMap((a) => [a.actorId, a.onBehalfOfId]));
  return all.map((a) => ({ name: names.get(String(a.actorId))?.name, title: names.get(String(a.actorId))?.title, stage: decisionStage(a), at: a.at, onBehalfOf: a.onBehalfOfId ? names.get(String(a.onBehalfOfId))?.name : undefined }));
}

/** The in-force PDF: the accepted text, the acceptance evidence and the employer's approvals. */
async function inForcePdf(agreement, app, approvals, at = new Date()) {
  // D-109: in the language it was signed in (older agreements: their template's).
  const language = agreement.language || (await AgreementTemplate.findById(agreement.templateId).select('language').lean())?.language || 'sw';
  const stage = (s) => (language === 'sw' ? translate(s, 'sw') : s);
  // D-110: printed from the blocks kept with it; agreements stored before blocks were kept, from their text.
  return agreementPdf({
    blocks: agreement.blocks?.length ? agreement.blocks : textBlocks(agreement.text),
    language,
    agreementNumber: agreement.number,
    ref: app.ref,
    templateVersion: agreement.templateVersion,
    textSha256: agreement.textSha256,
    acceptance: agreement.acceptance,
    approvals: approvals.map((a) => ({ ...a, stage: stage(a.stage) })),
    inForceAt: at,
    dataProtection: dataProtection.pdfSection(agreement.dataProtection),
  });
}

/** Repayment schedule from today on the approved terms (FR-24). */
async function scheduleFrom(app, terms, startDay) {
  const [pricing, settings] = await Promise.all([PricingVersion.findById(app.pricingVersionId).lean(), Settings.get()]);
  const instalment = calc.instalment(terms.amount, terms.tenor, pricing.interestBps, pricing.instalmentRounding);
  const rows = calc.schedule(terms.amount, terms.tenor, pricing.interestBps, pricing.instalmentRounding, calc.firstDueDate(startDay, settings.firstDueDay || 25));
  return { instalment, rows };
}

/** NS-02: a successful application starts the reapply wait for its product. */
async function recordSuccess(app, now, session) {
  await Staff.updateOne(
    { _id: app.applicantStaffId },
    { $push: { loanHistory: { productId: app.productId, applicationId: app._id, ref: app.ref, appliedAt: app.lastSubmittedAt || app.submittedAt, approvedAt: now } } },
    { session }
  );
}

/** Puts the agreement in force (FR-18, FR-56) and sends the application to booking (D-107). */
async function putInForce(req, app, agreement, terms, now, session, approvals) {
  const pdf = await inForcePdf(agreement, app, approvals, now);
  const file = await fileStore.store(pdf, { kind: 'agreement_pdf', originalName: `${agreement.number}-in-force.pdf`, applicationId: app._id, ownerUserId: app.applicantUserId, uploadedBy: req.auth.user._id }, { session });
  await Agreement.updateOne({ _id: agreement._id }, { $set: { status: 'in_force', effectiveAt: now, inForcePdfFileId: file._id, approvals } }, { session });
  const sched = await scheduleFrom(app, terms, localDay(now));
  await Application.updateOne(
    { _id: app._id },
    { $set: { status: 'pending_booking', currentStage: null, stageEnteredAt: now, stageDueAt: null, approved: { amount: terms.amount, tenor: terms.tenor, instalment: sched.instalment }, schedule: sched.rows, scheduleBasis: 'final_approval' } },
    { session }
  );
  await recordSuccess(app, now, session);
  return sched;
}

// ---------- retirement cutoff (D-82) ----------

/**
 * Re-checks the cutoff with the latest verified date of birth and the schedule as it
 * would be generated now. Throws 409 CUTOFF_EXCEEDED (or DOB_NOT_VERIFIED). A viewer on
 * limited details (FR-55) gets a message without the terms.
 */
async function recheckCutoff(app, terms, now, { audience = 'reviewer', limited = false } = {}) {
  const [staff, settings, version, pricing] = await Promise.all([
    Staff.findById(app.applicantStaffId).lean(),
    Settings.get(),
    ProductVersion.findById(app.productVersionId).lean(),
    PricingVersion.findById(app.pricingVersionId).lean(),
  ]);
  const startDay = localDay(now);
  const rows = calc.schedule(terms.amount, terms.tenor, pricing.interestBps, pricing.instalmentRounding, calc.firstDueDate(startDay, settings.firstDueDay || 25));
  const res = rules.cutoffCheck({ staff, settings, version, tenor: terms.tenor, lastDue: rows.at(-1)?.due, startDay });
  if (res.ok) return;
  if (limited) throw conflict("This application cannot be approved now: the applicant's retirement cutoff no longer allows its terms. Return or reject it.", res.code);
  const lead = audience === 'applicant' ? 'You cannot accept these terms now.' : 'This application cannot be approved now.';
  const next = audience === 'applicant' ? 'Decline them, and apply again for a shorter tenor.' : 'Return it, reject it, or (Credit Analyst) recommend a shorter tenor.';
  throw conflict(`${lead} ${res.message} ${next}`, res.code, { cutoff: res.cutoff, maxTenor: res.maxTenor, lastDue: res.lastDue });
}

// ---------- decisions ----------

/**
 * body: { action, comment, crb: { outcome, reportDate, fileId },
 *         recommended: { amount, tenor, reason }, suggested: { amount, tenor }, hrChecks }
 */
async function decide(req, app, body) {
  const actor = await workflow.canAct(req.auth.user._id, app);
  if (!actor) {
    if (String(app.applicantUserId) === String(req.auth.user._id)) throw forbidden('You cannot review your own application.', 'SELF_REVIEW');
    if ((await workflow.otherStageApprovers(app)).includes(String(req.auth.user._id))) {
      throw forbidden('You approved an earlier stage of this application, so another person must decide this stage.', 'SEPARATE_STAGES');
    }
    throw forbidden('This application is not waiting for you.', 'NOT_YOUR_STAGE');
  }
  const stage = app.currentStage;
  const { action } = body;
  const comment = (body.comment || '').trim();
  const isFinal = app.stages.indexOf(stage) === app.stages.length - 1;

  if (action !== 'approve' && !comment) throw badRequest('Add a comment so the applicant knows what to do.', { comment: ['Add a comment so the applicant knows what to do.'] }, 'COMMENT_REQUIRED');
  // D-106: a return goes to the applicant (as before) or to an earlier stage passed in this cycle.
  let returnTo;
  if (action === 'return') {
    returnTo = body.returnTo || 'applicant';
    if (returnTo !== 'applicant') {
      const history = await Decision.find({ applicationId: app._id, action: { $in: ['approve', 'return'] } }).lean();
      if (!returnTargets(app, history).includes(returnTo)) {
        throw badRequest('Choose the applicant or an earlier stage this application has already passed.', { returnTo: ['Choose the applicant or an earlier stage this application has already passed.'] }, 'RETURN_TARGET_INVALID');
      }
    }
  }
  const set = {};
  let recommended = null;
  if (stage === 'credit') {
    if (action === 'approve' && !body.crb?.outcome) throw badRequest('Record the credit bureau outcome before approving.', { crb: ['Record the credit bureau outcome before approving.'] }, 'CRB_REQUIRED');
    if (action === 'approve' && !body.crb?.reportDate) throw badRequest('Enter the credit bureau report date before approving.', { crb: ['Enter the credit bureau report date before approving.'] }, 'CRB_REQUIRED');
    // D-105: approving needs at least one bureau report file; returning or rejecting does not.
    if (action === 'approve' && !crbFileIds(app).length) throw badRequest('Attach at least one credit bureau report before approving.', { crb: ['Attach at least one credit bureau report before approving.'] }, 'CRB_FILE_REQUIRED');
    // The outcome and date only: the files are kept as attached (D-105).
    if (body.crb?.outcome) Object.assign(set, { 'crb.outcome': body.crb.outcome, 'crb.reportDate': body.crb.reportDate ? localMidnight(body.crb.reportDate) : null });
    // D-86: the Credit Analyst records the bureau check only; terms are not recommended any more.
    if (body.recommended) throw badRequest('The Credit Analyst records the credit bureau check only and cannot recommend terms.', undefined, 'RECOMMENDATION_NOT_ALLOWED');
  } else if (body.recommended || body.crb) {
    throw badRequest('Only the Credit Analyst records the bureau result and recommends terms.', undefined, 'NOT_ALLOWED_AT_STAGE');
  }
  if (PC_STAGES.includes(stage) && action === 'approve') {
    // salary: Basic Pay confirmed from the attached payslip (D-100), not a salary record.
    const c = body.hrChecks || {};
    if (!(c.employment && c.category && c.salary)) throw badRequest('Confirm all three staff record checks before approving.', { hrChecks: ['Confirm all three staff record checks before approving.'] }, 'HR_CHECKS_REQUIRED');
    if (app.probation?.onProbation && !c.probationReasonVerified) throw badRequest('Verify the probation reason before approving.', { hrChecks: ['Verify the probation reason before approving.'] }, 'PROBATION_CHECK_REQUIRED');
    set.hrChecks = { employment: true, category: true, salary: true, probationReasonVerified: !!c.probationReasonVerified };
    if (app.probation?.onProbation) Object.assign(set, { 'probation.verifiedBy': req.auth.user._id, 'probation.verifiedAt': new Date() });
  }
  // BR-10: only applications whose arrears note was recorded before D-99 (no longer entered).
  if (action === 'approve' && stage !== 'credit' && app.arrearsNote && !comment) {
    throw badRequest('Add a comment: the Credit Analyst recorded arrears.', { comment: ['Add a comment about the arrears.'] }, 'COMMENT_REQUIRED');
  }

  const now = new Date();
  const staff = await Staff.findById(app.applicantStaffId).lean();
  const applicantName = fullName(staff);
  const limited = stage === 'credit'; // the Credit Analyst sees identity only, on every route (D-86)
  const suggestion = action === 'return' && body.suggested?.amount ? ` Suggested terms: ${tzs(body.suggested.amount)} over ${body.suggested.tenor} months.` : '';
  const recNote = recommended ? ` Recommended terms: ${tzs(recommended.amount)} over ${recommended.tenor} months.` : '';
  const storedComment = `${comment}${suggestion}${recNote}`.trim() || null;

  // Final approval at different terms needs nothing extra here; at the same terms the
  // in-force PDF lists the approvers, built before the transaction.
  const recommendedNow = recommended || (app.recommended?.amount ? app.recommended : null);
  const agreement = await Agreement.findById(app.currentAgreementId);
  const termsChanged = !!(recommendedNow && (recommendedNow.amount !== agreement.terms.amount || recommendedNow.tenor !== agreement.terms.tenor));

  // D-82: every approval re-checks the cutoff with the latest verified date of birth.
  if (action === 'approve') {
    const terms = recommendedNow || agreement.terms;
    await recheckCutoff(app, terms, now, { limited: limited && stage === 'credit' });
    // D-87: the combined cap again; another loan may have been approved in between.
    const cap = await capCheck(app, terms, now);
    if (!cap.ok) {
      const generic = "This application cannot be approved now: the applicant's combined loan limit no longer allows it. Return or reject it.";
      throw conflict(limited && stage === 'credit' ? generic : `This application cannot be approved now. ${cap.message} Return or reject it.`, cap.code);
    }
  }

  let outcome;
  await withTransaction(async (session) => {
    const fresh = await Application.findOneAndUpdate({ _id: app._id, status: app.status, currentStage: stage }, { $set: { ...set, ...(recommended ? { recommended } : {}) } }, { new: true, session });
    if (!fresh) throw conflict('Someone else has just decided on this application. Reload it.', 'STATE_CHANGED');

    await Decision.create(
      [{ applicationId: app._id, cycle: app.cycle, stage, action, actorId: req.auth.user._id, onBehalfOfId: actor.onBehalfOf || undefined, comment: storedComment, details: { permission: actor.permission, returnTo: action === 'return' ? returnTo : undefined, crb: set['crb.outcome'] ? { outcome: set['crb.outcome'] } : undefined, hrChecks: set.hrChecks, recommended: recommended ? { amount: recommended.amount, tenor: recommended.tenor } : undefined }, at: now, ip: req.ip }],
      { session }
    );

    if (action === 'return' && returnTo !== 'applicant') {
      // D-106: back to an earlier stage. Approvals from that stage on, in this cycle, no longer
      // count (approvals.js); the stage decides again, with a new due date.
      const cal = await calendar.load(session);
      const dueAt = workingTime.addWorkingHours(cal, now, STAGES[returnTo].target === 'ceo' ? cal.ceoTargetHours : cal.stageTargetHours);
      const moved = await Application.findByIdAndUpdate(app._id, { $set: { status: STAGES[returnTo].status, currentStage: returnTo, stageEnteredAt: now, stageDueAt: dueAt } }, { new: true, session });
      const actors = await workflow.stageActors(moved, { session });
      await notify.notifyUsers(
        actors.map((a) => a.userId),
        { type: 'application.stage_returned', text: `${app.ref} from ${applicantName} was returned to your ${stageName(returnTo)} review by ${stageName(stage)}: ${storedComment}`, href: `/review/${app._id}`, entity: 'Application', entityId: String(app._id) },
        { session }
      );
      await notify.notifyUsers([app.applicantUserId], { type: 'application.moved', text: `${app.ref} went back to ${stageName(returnTo)} review.`, href: `/applications/${app._id}`, entity: 'Application', entityId: String(app._id) }, { session });
      outcome = 'returned_to_stage';
    } else if (action === 'return') {
      await Application.updateOne({ _id: app._id }, { $set: { status: 'returned', currentStage: null, stageEnteredAt: now, stageDueAt: null } }, { session });
      await notify.notifyUsers([app.applicantUserId], { type: 'application.returned', text: `${app.ref} was returned for correction: ${storedComment}`, href: `/applications/${app._id}`, entity: 'Application', entityId: String(app._id) }, { session });
      outcome = 'returned';
    } else if (action === 'reject') {
      await Application.updateOne({ _id: app._id }, { $set: { status: 'rejected', currentStage: null, closedAtStage: stage, closedReason: storedComment, closedAt: now, stageDueAt: null } }, { session });
      await Agreement.updateOne({ _id: app.currentAgreementId, status: 'signed' }, { $set: { status: 'void', voidAt: now, voidReason: 'Application rejected' } }, { session });
      await notify.notifyUsers([app.applicantUserId], { type: 'application.rejected', text: `${app.ref} was rejected: ${storedComment}`, href: `/applications/${app._id}`, entity: 'Application', entityId: String(app._id) }, { session });
      outcome = 'rejected';
    } else if (!isFinal) {
      const next = app.stages[app.stages.indexOf(stage) + 1];
      const cal = await calendar.load(session);
      const dueAt = workingTime.addWorkingHours(cal, now, STAGES[next].target === 'ceo' ? cal.ceoTargetHours : cal.stageTargetHours);
      const moved = await Application.findByIdAndUpdate(app._id, { $set: { status: STAGES[next].status, currentStage: next, stageEnteredAt: now, stageDueAt: dueAt } }, { new: true, session });
      const actors = await workflow.stageActors(moved, { session });
      const lim = limited && next === 'credit';
      await notify.notifyUsers(
        actors.map((a) => a.userId),
        { type: 'application.stage', text: `${app.ref} from ${applicantName} is waiting for your ${stageName(next)} review${lim ? ' (limited details)' : ''}${isFinalStage(app, next) && app.route === 'ceo' ? '. You give final approval on this route.' : ''}`, href: `/review/${app._id}`, entity: 'Application', entityId: String(app._id) },
        { session }
      );
      await notify.notifyUsers([app.applicantUserId], { type: 'application.moved', text: `${app.ref} moved to ${stageName(next)} review.`, href: `/applications/${app._id}`, entity: 'Application', entityId: String(app._id) }, { session });
      outcome = 'moved';
    } else if (termsChanged) {
      // FR-54: approved at different terms; the applicant accepts a revised agreement first.
      const settings = await Settings.get(session);
      const sched = await scheduleFrom(app, recommendedNow, localDay(now));
      await Application.updateOne(
        { _id: app._id },
        { $set: { status: 'pending_reaccept', currentStage: null, stageEnteredAt: now, stageDueAt: null, finalApprovedAt: now, approved: { amount: recommendedNow.amount, tenor: recommendedNow.tenor, instalment: sched.instalment }, revisedExpiresAt: new Date(now.getTime() + settings.revisedTermsExpiryDays * DAY) } },
        { session }
      );
      await notify.notifyUsers(
        [app.applicantUserId],
        { type: 'application.revised_terms', text: `${app.ref} is approved at revised terms: ${tzs(recommendedNow.amount)} over ${recommendedNow.tenor} months. Read and accept the revised agreement so OPS can disburse.`, href: `/accept/${app._id}`, entity: 'Application', entityId: String(app._id) },
        { session }
      );
      outcome = 'revised';
    } else {
      // This decision is already written in the transaction, so it is in the list.
      const approvals = await approvalsFor(fresh, null, session);
      await Application.updateOne({ _id: app._id }, { $set: { finalApprovedAt: now } }, { session });
      await putInForce(req, fresh, agreement, { amount: agreement.terms.amount, tenor: agreement.terms.tenor }, now, session, approvals);
      await notify.notifyUsers([app.applicantUserId], { type: 'application.approved', text: `${app.ref} is approved. Your signed agreement ${agreement.number} is now in force. People and Culture will book the loan and OPS will disburse it.`, href: `/applications/${app._id}`, entity: 'Application', entityId: String(app._id) }, { session });
      await notifyBookers(`${app.ref} has final approval. Ready to book in core banking.`, '/disburse', String(app._id), session);
      outcome = 'approved';
    }

    await audit.record(
      {
        req,
        action: `review.${action}`,
        description: `${app.ref} ${action === 'approve' ? `approved by ${stageName(stage)}${outcome === 'approved' ? ' (final; agreement in force)' : outcome === 'revised' ? ' (final; revised terms to accept)' : ''}` : action === 'return' ? `returned by ${stageName(stage)} to ${returnTo === 'applicant' ? 'the applicant' : stageName(returnTo)}: ${storedComment}` : `rejected by ${stageName(stage)}`}${actor.onBehalfOf ? ' on behalf of the stage holder' : ''}`,
        entity: 'Application',
        entityId: String(app._id),
        appRef: app.ref,
        limited,
        onBehalfOfId: actor.onBehalfOf || undefined,
        before: { status: app.status, stage },
        after: { outcome, returnTo, crb: set['crb.outcome'], recommended: limited ? undefined : recommended && { amount: recommended.amount, tenor: recommended.tenor } },
      },
      { session }
    );
  });
  return { outcome, application: await Application.findById(app._id) };
}

const isFinalStage = (app, stage) => app.stages.at(-1) === stage;

// ---------- credit bureau report (FR-42) ----------

/** The bureau report files attached to an application: fileIds, or the single fileId kept before D-105. */
function crbFileIds(app) {
  if (app.crb?.fileIds?.length) return app.crb.fileIds.map(String);
  return app.crb?.fileId ? [String(app.crb.fileId)] : [];
}

const CRB_MAX_FILES = 10;

/** Adds a bureau report file (D-105): files are added, never replaced; at most ten. */
async function uploadCrbReport(req, app, file) {
  const actor = await workflow.canAct(req.auth.user._id, app);
  if (!actor || app.currentStage !== 'credit') throw forbidden('Only the Credit Analyst at this stage can attach the bureau report.', 'NOT_YOUR_STAGE');
  const existing = crbFileIds(app);
  if (existing.length >= CRB_MAX_FILES) throw badRequest('You can attach up to 10 credit bureau files. Remove one to add another.', { file: ['You can attach up to 10 credit bureau files. Remove one to add another.'] }, 'CRB_FILE_LIMIT');
  const stored = await fileStore.store(file.buffer, { kind: 'crb_report', originalName: file.originalname, applicationId: app._id, ownerUserId: req.auth.user._id, uploadedBy: req.auth.user._id });
  // A single file kept before D-105 becomes the first of the list.
  const moved = await Application.updateOne(
    { _id: app._id, currentStage: 'credit', [`crb.fileIds.${CRB_MAX_FILES - 1}`]: { $exists: false } },
    existing.length && !app.crb?.fileIds?.length ? { $set: { 'crb.fileIds': [...existing, String(stored._id)] } } : { $push: { 'crb.fileIds': stored._id } }
  );
  if (!moved.modifiedCount) throw conflict('The application changed while the file was uploading. Reload it and try again.', 'STATE_CHANGED');
  await audit.record({ req, action: 'review.crb_report_add', description: `${app.ref}: credit bureau report ${stored.originalName} attached`, entity: 'Application', entityId: String(app._id), appRef: app.ref, limited: true, after: { fileId: String(stored._id), originalName: stored.originalName, sha256: stored.sha256 } });
  return stored;
}

/** Removes a bureau report file the current user attached, before the credit decision (D-105). */
async function removeCrbReport(req, app, fileId) {
  const actor = await workflow.canAct(req.auth.user._id, app);
  if (!actor || app.currentStage !== 'credit') throw forbidden('Only the Credit Analyst at this stage can remove a bureau report.', 'NOT_YOUR_STAGE');
  if (!crbFileIds(app).includes(String(fileId))) throw notFound('That file is not attached to this application.');
  const file = await StoredFile.findOne({ _id: fileId, kind: 'crb_report', removedAt: null });
  if (!file) throw notFound('That file is not attached to this application.');
  if (String(file.uploadedBy) !== String(req.auth.user._id)) throw forbidden('You can remove only the files you attached.', 'NOT_YOUR_FILE');
  const ids = crbFileIds(app).filter((id) => id !== String(fileId));
  await Application.updateOne({ _id: app._id }, { $set: { 'crb.fileIds': ids }, $unset: { 'crb.fileId': '' } });
  await StoredFile.updateOne({ _id: file._id }, { $set: { removedAt: new Date(), removedBy: req.auth.user._id } });
  await audit.record({ req, action: 'review.crb_report_remove', description: `${app.ref}: credit bureau report ${file.originalName} removed`, entity: 'Application', entityId: String(app._id), appRef: app.ref, limited: true, before: { fileId: String(file._id), originalName: file.originalName, sha256: file.sha256 } });
}

// ---------- revised terms (FR-38, FR-39, FR-54) ----------

async function revisedAgreement(req, app, session) {
  const [version, pricing, staff, signed] = await Promise.all([
    ProductVersion.findById(app.productVersionId).session(session || null),
    PricingVersion.findById(app.pricingVersionId).session(session || null),
    Staff.findById(app.applicantStaffId).session(session || null),
    Agreement.findById(app.currentAgreementId).session(session || null),
  ]);
  const ctx = await appSvc.context(req, app.productId, { app, versions: { product: { _id: app.productId }, version, pricing } });
  const result = rules.evaluate(ctx, { ...appSvc.inputOf(app), amount: app.approved.amount, tenor: app.approved.tenor });
  const doc = await agreementService.build({ ref: app.ref, kind: 'revised', staff, product: version, fields: app.productFields, quote: result.quote, amount: app.approved.amount, tenor: app.approved.tenor, repayment: app.repayment, topUp: app.topUp }, { session, template: await require('../agreement/productTemplate').resolve(version, { session, historicalTemplateId: signed?.templateId }) });
  return { doc, quote: result.quote, signed, staff };
}

async function revisedTerms(req, app) {
  if (app.status !== 'pending_reaccept') throw conflict('There are no revised terms to accept.', 'NOT_PENDING_REACCEPT');
  const { doc, quote, signed } = await revisedAgreement(req, app);
  const reasonRow = await Decision.findOne({ applicationId: app._id, cycle: app.cycle, stage: 'credit', action: 'approve' }).sort({ at: -1 }).lean();
  return {
    signed: { number: signed.number, amount: signed.terms.amount, tenor: signed.terms.tenor, instalment: signed.terms.instalment },
    approved: { amount: app.approved.amount, tenor: app.approved.tenor, instalment: quote.instalment, fees: quote.fees, totalRepayable: quote.totalRepayable },
    reason: app.recommended?.reason || reasonRow?.comment || 'Recommended at review.',
    expiresAt: app.revisedExpiresAt,
    blocks: doc.blocks,
    textSha256: doc.textSha256,
    template: doc.template,
  };
}

async function acceptRevised(req, app, body) {
  if (app.status !== 'pending_reaccept') throw conflict('There are no revised terms to accept.', 'NOT_PENDING_REACCEPT');
  if (app.revisedExpiresAt && app.revisedExpiresAt < new Date()) throw conflict('The time to accept the revised terms has passed.', 'REVISED_EXPIRED');
  if (body.accepted !== true || body.scrolledToEnd !== true) throw badRequest('Read the revised agreement to the end and tick the acceptance.', undefined, 'CONSENTS_REQUIRED');
  const { doc, quote, staff } = await revisedAgreement(req, app);
  if (doc.textSha256 !== body.textSha256) throw conflict('The revised agreement changed since you opened it. Read it again before you sign.', 'AGREEMENT_CHANGED', { textSha256: doc.textSha256 });
  if (declarationsOf(doc.blocks).length && !allDeclared(doc.blocks, body.declarations)) throw badRequest('Tick every statement in the revised agreement before you accept it.', undefined, 'CONSENTS_REQUIRED');
  const AuthController = require('../../controllers/authController');
  const check = await AuthController.verifyPassword(req.auth.user, body.password, req);
  if (!check.ok) {
    if (check.remainingAttempts === 0) throw new AppError(423, 'ACCOUNT_LOCKED', 'Your account is locked after too many failed attempts. Contact the IT Service Desk to unlock it.');
    throw new AppError(401, 'PASSWORD_WRONG', 'Your password is not right.', { password: ['Your password is not right.'], remainingAttempts: check.remainingAttempts });
  }

  const now = new Date();
  await recheckCutoff(app, app.approved, now, { audience: 'applicant' }); // D-82
  const cap = await capCheck(app, app.approved, now); // D-87
  if (!cap.ok) throw conflict(`You cannot accept these terms now. ${cap.message} Decline them, and apply again for a smaller amount.`, cap.code);
  const number = await appSvc.nextRef('MKT');
  const name = agreementService.staffName(staff);
  const approvals = await approvalsFor(app);
  // D-108: the data protection notice accepted at signing stays with the loan.
  const dp = (await Agreement.findById(app.currentAgreementId).select('dataProtection').lean())?.dataProtection;
  const draft = { number, text: doc.text, blocks: doc.blocks, textSha256: doc.textSha256, templateVersion: doc.template.version, language: doc.template.language, format: doc.format, acceptance: { fullName: name, staffNo: staff.staffNo, at: now, ip: req.ip }, dataProtection: dp };
  const pdf = await inForcePdf(draft, app, approvals, now);

  await withTransaction(async (session) => {
    const fresh = await Application.findOneAndUpdate({ _id: app._id, status: 'pending_reaccept' }, { $set: { status: 'pending_booking' } }, { new: true, session });
    if (!fresh) throw conflict('There are no revised terms to accept.', 'NOT_PENDING_REACCEPT');
    const file = await fileStore.store(pdf, { kind: 'agreement_pdf', originalName: `${number}.pdf`, applicationId: app._id, ownerUserId: app.applicantUserId, uploadedBy: req.auth.user._id }, { session });
    const [revised] = await Agreement.create(
      [
        {
          number,
          applicationId: app._id,
          kind: 'revised',
          templateId: doc.template.id,
          templateVersion: doc.template.version,
          language: doc.template.language,
          format: doc.format,
          terms: { amount: app.approved.amount, tenor: app.approved.tenor, instalment: quote.instalment, interestBps: quote.rates.interestBps, processingFee: quote.processingFee, insuranceFee: quote.insuranceFee, totalInterest: quote.totalInterest, totalRepayable: quote.totalRepayable, firstDueDate: quote.firstDueDate, repaymentMethod: app.repayment.method },
          schedule: quote.schedule,
          text: doc.text,
          blocks: doc.blocks,
          textSha256: doc.textSha256,
          pdfFileId: file._id,
          pdfSha256: file.sha256,
          inForcePdfFileId: file._id,
          approvals,
          acceptance: { userId: req.auth.user._id, staffNo: staff.staffNo, fullName: name, at: now, ip: req.ip, userAgent: req.get('User-Agent') },
          dataProtection: dp?.accepted ? dp : undefined,
          status: 'in_force',
          effectiveAt: now,
        },
      ],
      { session }
    );
    await Agreement.updateOne({ _id: app.currentAgreementId }, { $set: { status: 'void', voidAt: now, voidReason: 'Replaced by the revised agreement accepted after approval', replacedById: revised._id } }, { session });
    const sched = await scheduleFrom(app, app.approved, localDay(now));
    await Application.updateOne({ _id: app._id }, { $set: { currentAgreementId: revised._id, stageEnteredAt: now, approved: { amount: app.approved.amount, tenor: app.approved.tenor, instalment: sched.instalment }, schedule: sched.rows, scheduleBasis: 'final_approval', revisedExpiresAt: null } }, { session });
    await recordSuccess(app, now, session);
    await Decision.create([{ applicationId: app._id, cycle: app.cycle, action: 'accept_revised', actorId: req.auth.user._id, comment: `${tzs(app.approved.amount)} over ${app.approved.tenor} months, agreement ${number}`, details: { agreementNumber: number, textSha256: doc.textSha256 }, at: now, ip: req.ip }], { session });
    await audit.record({ req, action: 'agreement.accept_revised', description: `${app.ref}: revised agreement ${number} accepted (fingerprint ${doc.textSha256.slice(0, 16)}…)`, entity: 'Application', entityId: String(app._id), appRef: app.ref, after: { agreement: number, textSha256: doc.textSha256 } }, { session });
    await notifyBookers(`${app.ref}: revised terms accepted. Ready to book in core banking.`, '/disburse', String(app._id), session);
  });
  return Application.findById(app._id);
}

async function closeRevised(req, app, { reason, expired }) {
  const now = new Date();
  await withTransaction(async (session) => {
    const fresh = await Application.findOneAndUpdate({ _id: app._id, status: 'pending_reaccept' }, { $set: { status: 'declined', closedReason: reason, closedAt: now, revisedExpiresAt: null } }, { new: true, session });
    if (!fresh) throw conflict('There are no revised terms to decline.', 'NOT_PENDING_REACCEPT');
    await Agreement.updateOne({ _id: app.currentAgreementId }, { $set: { status: 'void', voidAt: now, voidReason: expired ? 'Revised terms not accepted in time' : 'Revised terms declined by the staff member' } }, { session });
    await Decision.create([{ applicationId: app._id, cycle: app.cycle, action: expired ? 'expire' : 'decline_revised', actorId: expired ? undefined : req.auth.user._id, comment: reason, at: now, ip: req?.ip }], { session });
    await audit.record({ req, action: expired ? 'application.revised_expired' : 'application.decline_revised', description: `${app.ref}: revised terms ${expired ? 'expired' : `declined: ${reason}`}`, entity: 'Application', entityId: String(app._id), appRef: app.ref }, { session });
    if (expired) {
      // FR-39: notify the applicant and OPS.
      await notify.notifyUsers([app.applicantUserId], { type: 'application.revised_expired', text: `${app.ref}: the revised terms were not accepted in time, so the approval lapsed.`, href: `/applications/${app._id}`, entity: 'Application', entityId: String(app._id) }, { session });
      await notifyOps(`${app.ref}: revised terms expired. Nothing to disburse.`, '/disburse', String(app._id), session, 'application.revised_expired');
    }
  });
  return Application.findById(app._id);
}

const declineRevised = (req, app, reason) => closeRevised(req, app, { reason, expired: false });

/** Scheduler job: lapse revised terms not accepted in time (FR-39). */
async function expireRevisedTerms(now = new Date()) {
  const due = await Application.find({ status: 'pending_reaccept', revisedExpiresAt: { $lte: now } });
  for (const app of due) {
    // eslint-disable-next-line no-await-in-loop
    await closeRevised(null, app, { reason: 'Revised terms not accepted in time', expired: true }).catch(() => {});
  }
  return due.length;
}

module.exports = { decide, uploadCrbReport, removeCrbReport, crbFileIds, CRB_MAX_FILES, revisedTerms, acceptRevised, declineRevised, expireRevisedTerms };

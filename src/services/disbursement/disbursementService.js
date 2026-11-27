'use strict';

// Disbursement (BRD 11; FR-20 to FR-22, FR-24, FR-26; Q3; D-112). After final approval a
// loan waits in one queue, Disbursement, open to OPS and People and Culture (disb.confirm).
// People and Culture book the loan in the loan management system outside SLAS; the
// money goes out in core banking. Here they download the Agreement and the Loan Summary
// and mark the loan as disbursed with the date, a unique transaction reference, a comment
// and the product's checklist. That ends the journey in SLAS and regenerates the schedule
// from that date. Nobody marks their own loan, or one they approved, as disbursed.
//
// The booking step of D-107 is gone; a booking recorded before D-112 stays on the loan,
// read-only.

const Application = require('../../models/Application');
const Agreement = require('../../models/Agreement');
const Decision = require('../../models/Decision');
const Staff = require('../../models/Staff');
const Settings = require('../../models/Settings');
const ProductVersion = require('../../models/ProductVersion');
const PricingVersion = require('../../models/PricingVersion');
const audit = require('../audit/auditService');
const notify = require('../notify/notificationService');
const calc = require('../calc/loanCalculator');
const rules = require('../applications/rules');
const { capCheck } = require('../applications/capCheck');
const { fullName, namesOf } = require('../review/reviewView');
const { withTransaction } = require('../../config/db');
const { localDay, localMidnight } = require('../../utils/dates');
const { STATUS, APPROVED_LOAN } = require('../../constants/statuses');
const { badRequest, conflict, forbidden, notFound } = require('../../utils/errors');

const DAY = 24 * 3600 * 1000;
const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;

const WAITING = ['pending_disbursement'];

/**
 * Q3: a loan waiting after final approval to be disbursed is Outside SLA
 * after approvalSlaDays from final approval; it never expires.
 */
function slaInfo(app, settings, now = new Date()) {
  if (!WAITING.includes(app.status) || !app.stageEnteredAt) return { outsideSla: false, daysWaiting: null };
  const daysWaiting = Math.floor((now - app.stageEnteredAt) / DAY);
  return { outsideSla: daysWaiting >= settings.approvalSlaDays, daysWaiting, slaDays: settings.approvalSlaDays };
}

/**
 * SoD (FR-48, D-112), for everyone who marks loans as disbursed: not your own loan; not a
 * loan you approved, yourself or as a delegate; not one approved on your behalf. Returns
 * the reason, or null.
 */
async function blockedReason(userId, app) {
  if (String(app.applicantUserId) === String(userId)) return 'This is your own loan. Another People and Culture or OPS officer marks it as disbursed.';
  const approvals = await Decision.find({ applicationId: app._id, action: 'approve', $or: [{ actorId: userId }, { onBehalfOfId: userId }] }).select('actorId onBehalfOfId').lean();
  const mine = approvals.filter((d) => String(d.actorId) === String(userId));
  if (mine.some((d) => !d.onBehalfOfId)) return 'You approved this loan. Another People and Culture or OPS officer marks it as disbursed.';
  if (mine.length) return 'You approved this loan as a delegate. Another People and Culture or OPS officer marks it as disbursed.';
  if (approvals.length) return 'This loan was approved on your behalf. Another People and Culture or OPS officer marks it as disbursed.';
  return null;
}

/** What this person may do on a loan in the queue (D-112). */
async function actionsFor(req, app) {
  const perms = req.auth.permissions;
  // The applicant never downloads the papers of their own loan here.
  const ownLoan = String(app.applicantUserId) === String(req.auth.user._id);
  const out = { canConfirm: false, blockedReason: null, ownLoan, canDownload: !ownLoan };
  if (app.status === 'pending_disbursement' && perms.has('disb.confirm')) {
    out.blockedReason = await blockedReason(req.auth.user._id, app);
    out.canConfirm = !out.blockedReason;
  }
  return out;
}

async function loadAll(apps) {
  const [staff, versions, agreements] = await Promise.all([
    Staff.find({ _id: { $in: apps.map((a) => a.applicantStaffId) } }).lean(),
    ProductVersion.find({ _id: { $in: apps.map((a) => a.productVersionId) } }).select('name requiredDocuments').lean(),
    Agreement.find({ _id: { $in: apps.map((a) => a.currentAgreementId) } }).select('-text -schedule').lean(),
  ]);
  const by = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  return { staff: by(staff), versions: by(versions), agreements: by(agreements) };
}

function row(app, maps, settings, names) {
  const s = maps.staff.get(String(app.applicantStaffId));
  const ag = maps.agreements.get(String(app.currentAgreementId));
  const fees = (ag?.terms?.processingFee || 0) + (ag?.terms?.insuranceFee || 0);
  return {
    id: String(app._id),
    ref: app.ref,
    status: app.status,
    statusLabel: STATUS[app.status],
    staff: { name: fullName(s), staffNo: s.staffNo, station: s.station, department: s.department, category: s.category },
    product: maps.versions.get(String(app.productVersionId))?.name,
    amount: app.approved?.amount,
    tenor: app.approved?.tenor,
    instalment: app.approved?.instalment,
    processingFee: ag?.terms?.processingFee || 0,
    insuranceFee: ag?.terms?.insuranceFee || 0,
    fees,
    repayment: app.repayment,
    agreementNumber: ag?.number,
    agreementId: ag ? String(ag._id) : null,
    approvedAt: app.stageEnteredAt,
    firstDueDate: app.schedule?.[0]?.due || ag?.terms?.firstDueDate || null,
    booking: app.booking?.loanAccountNumber
      ? { loanAccountNumber: app.booking.loanAccountNumber, date: localDay(app.booking.date), note: app.booking.note || null, by: names?.get(String(app.booking.bookedBy))?.name || null, at: app.booking.bookedAt }
      : null,
    disbursement: app.disbursement?.date
      ? { date: localDay(app.disbursement.date), transactionRef: app.disbursement.transactionRef || null, comment: app.disbursement.comment, by: names?.get(String(app.disbursement.confirmedBy))?.name || null, at: app.disbursement.confirmedAt }
      : null,
    ...slaInfo(app, settings),
  };
}

/**
 * The Disbursement queue (FR-20, D-112): ready to disburse, or disbursed. Each item says
 * what this person may do.
 */
async function list(req, { tab, q } = {}) {
  const settings = await Settings.get();
  const chosen = tab || 'ready';
  const [ready, done] = await Promise.all([
    Application.find({ status: 'pending_disbursement' }).sort({ stageEnteredAt: 1 }).lean(),
    Application.find({ status: 'disbursed', purgedAt: null }).sort({ 'disbursement.date': -1, 'disbursement.confirmedAt': -1 }).limit(500).lean(),
  ]);
  const apps = { ready, done }[chosen];
  const maps = await loadAll(apps);
  const names = await namesOf(apps.flatMap((a) => [a.disbursement?.confirmedBy, a.booking?.bookedBy]).filter(Boolean));
  let items = apps.map((a) => row(a, maps, settings, names));
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((r) => `${r.ref} ${r.staff.name} ${r.staff.staffNo} ${r.product} ${r.booking?.loanAccountNumber || ''}`.toLowerCase().includes(needle));
  }
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    Object.assign(item, await actionsFor(req, apps.find((a) => String(a._id) === item.id)));
  }
  return {
    tab: chosen,
    counts: { ready: ready.length, done: done.length, outsideSla: ready.filter((a) => slaInfo(a, settings).outsideSla).length },
    slaDays: settings.approvalSlaDays,
    can: { confirm: req.auth.permissions.has('disb.confirm') },
    items,
  };
}

/** When the loan got final approval (or the revised terms were accepted). */
const finalApprovalOf = (app) => app.finalApprovedAt || app.stageEnteredAt;

async function load(id) {
  const app = await Application.findById(id);
  if (!app || app.purgedAt || !APPROVED_LOAN.includes(app.status)) throw notFound('This loan is not in Disbursement.');
  return app;
}

/** What OPS needs to disburse and set up recovery (prototype disbSummary). */
async function detail(req, id) {
  const app = await load(id);
  const settings = await Settings.get();
  const maps = await loadAll([app]);
  const StoredFile = require('../../models/StoredFile');
  const appSvc = require('../applications/applicationService');
  const docs = await StoredFile.find({ _id: { $in: app.documentIds }, applicationId: app._id, kind: 'document', removedAt: null }).lean();
  const version = maps.versions.get(String(app.productVersionId));
  const names = await namesOf([app.disbursement?.confirmedBy, app.booking?.bookedBy, ...docs.map((d) => d.uploadedBy)].filter(Boolean));
  const staff = maps.staff.get(String(app.applicantStaffId));
  const ag = maps.agreements.get(String(app.currentAgreementId));
  await audit.record({ req, action: 'disbursement.view', description: `${app.ref} opened in Disbursement`, entity: 'Application', entityId: String(app._id), appRef: app.ref });
  return {
    ...row(app.toObject(), maps, settings, names),
    agreement: ag && { id: String(ag._id), number: ag.number, kind: ag.kind, signedAt: ag.acceptance?.at, effectiveAt: ag.effectiveAt, terms: ag.terms },
    documents: docs.map((d) => ({ ...appSvc.DOC_VIEW(d), uploadedBy: names.get(String(d.uploadedBy))?.name || null })),
    documentChecklist: (version?.requiredDocuments || []).filter((d) => d.active !== false).map((d) => ({ code: d.code, name: d.name, mandatory: d.mandatory, minFiles: d.minFiles, uploaded: docs.filter((f) => f.documentCode === d.code && f.scan?.status === 'clean').length })),
    creditTo: staff.bank || null,
    staff: { ...row(app.toObject(), maps, settings).staff, mobile: staff.personal?.mobile },
    // D-101: the payslip deduction topped up, and the SLAS loan it settles when there is one.
    topUp: app.topUp?.on ? { loanRef: app.topUp.loanRef || null, payslipLine: app.topUp.payslipLine?.label ? app.topUp.payslipLine : null, outstanding: app.topUp.outstanding ?? null } : null,
    // D-112: disbursed on or after the date of final approval.
    earliestDate: localDay(finalApprovalOf(app)),
    today: localDay(),
    schedule: app.schedule || [],
    scheduleBasis: app.scheduleBasis,
    ...(await actionsFor(req, app)),
  };
}

/**
 * Confirms a disbursement (FR-20 to FR-22).
 * body: { date: 'YYYY-MM-DD', transactionRef, comment, topUpSettled? }
 */
async function confirm(req, id, body) {
  const app = await load(id);
  if (app.status !== 'pending_disbursement') throw conflict('This loan has already been disbursed.', 'ALREADY_DISBURSED');
  const blocked = await blockedReason(req.auth.user._id, app);
  if (blocked) throw forbidden(blocked, 'SOD_DISBURSE');

  // D-87: the combined cap just before the money goes out.
  const cap = await capCheck(app, app.approved);
  if (!cap.ok) throw conflict(`This loan cannot be disbursed now. ${cap.message} Refer it back to Credit.`, cap.code);

  if (app.topUp?.on && body.topUpSettled !== true) throw badRequest('Confirm the old loan balance has been settled.', { topUpSettled: ['Confirm the old loan balance has been settled.'] }, 'TOPUP_NOT_SETTLED');
  // D-112: a comment of 5 to 1000 characters for the disbursement record.
  const comment = (body.comment || '').trim();
  if (comment.length < 5) throw badRequest('Add a comment for the disbursement record.', { comment: ['Add a comment for the disbursement record.'] }, 'COMMENT_REQUIRED');
  const today = localDay();
  if (body.date > today) throw badRequest('The disbursement date cannot be in the future.', { date: ['The disbursement date cannot be in the future.'] }, 'DATE_INVALID');
  if (body.date < localDay(finalApprovalOf(app))) throw badRequest('The disbursement date cannot be before the final approval.', { date: ['The disbursement date cannot be before the final approval.'] }, 'DATE_INVALID');

  // FR-21, FR-24: the schedule restarts from the disbursement date.
  const [pricing, settings] = await Promise.all([PricingVersion.findById(app.pricingVersionId).lean(), Settings.get()]);
  const { amount, tenor } = app.approved;
  const instalment = calc.instalment(amount, tenor, pricing.interestBps, pricing.instalmentRounding);
  const schedule = calc.schedule(amount, tenor, pricing.interestBps, pricing.instalmentRounding, calc.firstDueDate(body.date, settings.firstDueDay || 25));

  // D-82: the retirement cutoff on the schedule that starts from the disbursement date.
  const staff = await Staff.findById(app.applicantStaffId).lean();
  const cut = rules.cutoffCheck({ staff, settings, version: { maxTenor: tenor, minTenor: 1 }, tenor, lastDue: schedule.at(-1)?.due, startDay: body.date });
  if (!cut.ok) throw conflict(`This loan cannot be disbursed: ${cut.message} Refer it back to Credit.`, cut.code);

  const now = new Date();
  const transactionRef = (body.transactionRef || '').trim();
  if (!transactionRef) throw badRequest('Enter the core banking transaction reference.', { transactionRef: ['Enter the core banking transaction reference.'] }, 'TRANSACTION_REF_REQUIRED');
  // D-112: one transaction reference, one disbursed loan.
  const sameRef = await Application.findOne({ _id: { $ne: app._id }, 'disbursement.transactionRef': { $regex: `^${transactionRef.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}$`, $options: 'i' } }).select('ref').lean();
  if (sameRef) throw conflict(`This reference is already recorded on ${sameRef.ref}.`, 'DUPLICATE_TRANSACTION_REF', { transactionRef: [`This reference is already recorded on ${sameRef.ref}.`] });
  const disbursement = { date: localMidnight(body.date), transactionRef, comment, topUpSettled: app.topUp?.on ? true : undefined, confirmedBy: req.auth.user._id, confirmedAt: now };

  await withTransaction(async (session) => {
    const fresh = await Application.findOneAndUpdate(
      { _id: app._id, status: 'pending_disbursement' },
      { $set: { status: 'disbursed', disbursement, schedule, scheduleBasis: 'disbursement', 'approved.instalment': instalment, outsideSla: false, closedAt: now } },
      { new: true, session }
    );
    if (!fresh) throw conflict('Someone else has just confirmed this disbursement. Reload the list.', 'STATE_CHANGED');
    // D-87: a disbursed top-up settles the loan it replaces; that deduction stops.
    if (app.topUp?.on && app.topUp.applicationId) {
      await Application.updateOne({ _id: app.topUp.applicationId, 'settledByTopUp.applicationId': null }, { $set: { settledByTopUp: { applicationId: app._id, ref: app.ref, at: now } } }, { session });
    }
    await Decision.create(
      [{ applicationId: app._id, cycle: app.cycle, action: 'disburse', actorId: req.auth.user._id, comment: `${comment}${transactionRef ? ` Ref ${transactionRef}.` : ''}`, details: { date: body.date, transactionRef }, at: now, ip: req.ip }],
      { session }
    );
    await audit.record(
      {
        req,
        action: 'loan.disbursed', // D-112
        description: `${app.ref} disbursed: ${tzs(amount)} on ${body.date}, ref ${transactionRef}: ${comment}`,
        entity: 'Application',
        entityId: String(app._id),
        appRef: app.ref,
        before: { status: 'pending_disbursement', scheduleBasis: app.scheduleBasis, firstDue: app.schedule?.[0]?.due },
        after: { status: 'disbursed', date: body.date, transactionRef, comment, firstDue: schedule[0]?.due },
      },
      { session }
    );
    await notify.notifyUsers([app.applicantUserId], { type: 'application.disbursed', text: `${app.ref}: your loan of ${tzs(amount)} has been disbursed. Your first instalment of ${tzs(instalment)} is due on ${schedule[0]?.due}.`, href: `/applications/${app._id}`, entity: 'Application', entityId: String(app._id) }, { session });
  });
  return detail(req, app._id);
}

// ---------- Outside SLA flag (Q3, BR-13) ----------

/** Scheduler job: keeps the stored Outside SLA flag current for reports. */
async function flagOutsideSla(now = new Date()) {
  const settings = await Settings.get();
  const cutoff = new Date(now.getTime() - settings.approvalSlaDays * DAY);
  const set = await Application.updateMany({ status: { $in: WAITING }, stageEnteredAt: { $lte: cutoff }, outsideSla: { $ne: true } }, { $set: { outsideSla: true } });
  const unset = await Application.updateMany({ status: { $in: WAITING }, stageEnteredAt: { $gt: cutoff }, outsideSla: true }, { $set: { outsideSla: false } });
  return set.modifiedCount + unset.modifiedCount;
}

/**
 * D-112: the Loan Summary PDF for Disbursement, in the agreement's language. disb.confirm
 * (OPS and People and Culture), approved loans only, never the applicant. Audited (summary.download).
 */
async function summary(req, id) {
  const app = await Application.findById(id);
  if (!app || app.purgedAt) throw notFound('Application not found.');
  if (!APPROVED_LOAN.includes(app.status)) throw forbidden('A loan summary is available once the loan has final approval.', 'NOT_APPROVED');
  if (String(app.applicantUserId) === String(req.auth.user._id)) throw forbidden('You cannot download the papers of your own loan here.', 'OWN_LOAN');
  const AgreementTemplate = require('../../models/AgreementTemplate');
  const { stageName, decisionStage } = require('../review/reviewView');
  const { summaryPdf } = require('../agreement/pdfService');
  const { translate } = require('../../i18n');
  const [staff, ag, version, decisions] = await Promise.all([
    Staff.findById(app.applicantStaffId).lean(),
    Agreement.findById(app.currentAgreementId).lean(),
    ProductVersion.findById(app.productVersionId).select('name payslipLabel').lean(),
    Decision.find({ applicationId: app._id, cycle: app.cycle, action: { $in: ['approve', 'return', 'reject', 'recommend_approval', 'recommend_rejection'] }, stage: { $ne: null } }).sort({ at: 1 }).lean(),
  ]);
  const language = ag?.language || (ag?.templateId ? (await AgreementTemplate.findById(ag.templateId).select('language').lean())?.language : null) || 'sw';
  const tr = (x) => (language === 'sw' ? translate(x, 'sw') : x);
  const names = await namesOf([...decisions.flatMap((d) => [d.actorId, d.onBehalfOfId]), app.booking?.bookedBy, app.disbursement?.confirmedBy, req.auth.user._id].filter(Boolean));
  const nameOf = (uid) => names.get(String(uid))?.name || null;
  const finalApproval = [...decisions].reverse().find((d) => d.action === 'approve');
  const terms = ag?.terms || {};
  const fees = (terms.processingFee || 0) + (terms.insuranceFee || 0);
  const amount = app.approved?.amount;
  const settlement = app.topUp?.outstanding ?? app.topUp?.payslipLine?.amount ?? null;
  const at = new Date();
  const pdf = await summaryPdf({
    language,
    ref: app.ref,
    agreementNumber: ag?.number,
    product: version?.name,
    statusLabel: tr(STATUS[app.status]),
    finalApproval: { at: app.finalApprovedAt || finalApproval?.at, by: finalApproval ? nameOf(finalApproval.actorId) : null },
    staff: {
      name: fullName(staff),
      staffNo: staff.staffNo,
      title: staff.title,
      station: staff.station,
      mobile: staff.personal?.mobile,
      account: staff.bank?.accountNo ? [staff.bank.accountName || fullName(staff), staff.bank.accountNo, staff.bank.bank].filter(Boolean).join(', ') : null,
    },
    terms: {
      amount,
      tenor: app.approved?.tenor,
      rate: `${Number.parseFloat(((terms.interestBps ?? 0) / 100).toFixed(2))}%`,
      instalment: app.approved?.instalment,
      totalRepayable: (app.schedule || []).reduce((t, r) => t + (r.payment || 0), 0) || terms.totalRepayable,
      totalInterest: (app.schedule || []).reduce((t, r) => t + (r.interest || 0), 0) || terms.totalInterest,
      firstDue: app.schedule?.[0]?.due,
      lastDue: app.schedule?.at(-1)?.due,
      payslipLabel: version?.payslipLabel || null,
    },
    topUp: app.topUp?.on ? { clears: [app.topUp.loanRef, app.topUp.payslipLine?.label].filter(Boolean).join(', ') || null, settlement, fees, net: amount != null ? amount - fees - (settlement || 0) : null } : null,
    approvals: decisions.map((d) => ({ stage: tr(decisionStage(d) || stageName(d.stage)), name: nameOf(d.actorId), action: d.action, against: !!d.details?.againstRecommendation, at: d.at })),
    booking: app.booking?.loanAccountNumber ? { loanAccountNumber: app.booking.loanAccountNumber, date: app.booking.date, by: nameOf(app.booking.bookedBy), note: app.booking.note } : null,
    disbursement: app.disbursement?.date ? { date: app.disbursement.date, transactionRef: app.disbursement.transactionRef, comment: app.disbursement.comment, by: nameOf(app.disbursement.confirmedBy) } : null,
    generatedBy: nameOf(req.auth.user._id) || req.auth.user.staffNo,
    at,
  });
  await audit.record({ req, action: 'summary.download', description: `${app.ref}: loan summary downloaded (${language})`, entity: 'Application', entityId: String(app._id), appRef: app.ref, after: { language } });
  return { pdf, ref: app.ref };
}

module.exports = { list, detail, confirm, summary, flagOutsideSla, slaInfo, blockedReason };

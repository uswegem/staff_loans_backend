'use strict';

// OPS disbursement (BRD 11; FR-20 to FR-22, FR-24, FR-26; Q3). Disbursement happens in
// core banking; OPS confirms it here with the date, an optional transaction
// reference, a mandatory comment and the product's checklist. Confirming ends the
// application's journey in SLAS and regenerates the schedule from that date.

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
const { STATUS } = require('../../constants/statuses');
const { badRequest, conflict, forbidden, notFound } = require('../../utils/errors');

const DAY = 24 * 3600 * 1000;
const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;

/** Q3: a Pending Disbursement loan is Outside SLA after approvalSlaDays; it never expires. */
function slaInfo(app, settings, now = new Date()) {
  if (app.status !== 'pending_disbursement' || !app.stageEnteredAt) return { outsideSla: false, daysWaiting: null };
  const daysWaiting = Math.floor((now - app.stageEnteredAt) / DAY);
  return { outsideSla: daysWaiting >= settings.approvalSlaDays, daysWaiting, slaDays: settings.approvalSlaDays };
}

/**
 * SoD (FR-48): OPS cannot confirm their own loan or one they approved, themselves or
 * as a delegate, or one approved on their behalf. Returns the reason, or null.
 */
async function blockedReason(userId, app) {
  if (String(app.applicantUserId) === String(userId)) return 'This is your own loan. Another OPS officer confirms it.';
  const approved = await Decision.exists({ applicationId: app._id, action: 'approve', $or: [{ actorId: userId }, { onBehalfOfId: userId }] });
  return approved ? 'You approved this loan, so another OPS officer confirms it.' : null;
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
    approvedAt: app.stageEnteredAt,
    firstDueDate: app.schedule?.[0]?.due || ag?.terms?.firstDueDate || null,
    disbursement: app.disbursement?.date
      ? { date: localDay(app.disbursement.date), transactionRef: app.disbursement.transactionRef || null, comment: app.disbursement.comment, by: names?.get(String(app.disbursement.confirmedBy))?.name || null, at: app.disbursement.confirmedAt }
      : null,
    ...slaInfo(app, settings),
  };
}

/** The OPS queue (FR-20): ready to disburse, or disbursed. */
async function list(req, { tab = 'ready', q } = {}) {
  const settings = await Settings.get();
  const [ready, done] = await Promise.all([
    Application.find({ status: 'pending_disbursement' }).sort({ stageEnteredAt: 1 }).lean(),
    Application.find({ status: 'disbursed' }).sort({ 'disbursement.date': -1, 'disbursement.confirmedAt': -1 }).limit(500).lean(),
  ]);
  const apps = tab === 'ready' ? ready : done;
  const maps = await loadAll(apps);
  const names = await namesOf(apps.map((a) => a.disbursement?.confirmedBy).filter(Boolean));
  let items = apps.map((a) => row(a, maps, settings, names));
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((r) => `${r.ref} ${r.staff.name} ${r.staff.staffNo} ${r.product}`.toLowerCase().includes(needle));
  }
  if (tab === 'ready') {
    for (const item of items) {
      // eslint-disable-next-line no-await-in-loop
      item.blockedReason = await blockedReason(req.auth.user._id, ready.find((a) => String(a._id) === item.id));
    }
  }
  return { tab, counts: { ready: ready.length, done: done.length, outsideSla: ready.filter((a) => slaInfo(a, settings).outsideSla).length }, slaDays: settings.approvalSlaDays, items };
}

async function load(id) {
  const app = await Application.findById(id);
  if (!app || !['pending_disbursement', 'disbursed'].includes(app.status)) throw notFound('This loan is not with OPS.');
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
  const names = await namesOf([app.disbursement?.confirmedBy, ...docs.map((d) => d.uploadedBy)].filter(Boolean));
  const staff = maps.staff.get(String(app.applicantStaffId));
  const ag = maps.agreements.get(String(app.currentAgreementId));
  await audit.record({ req, action: 'disbursement.view', description: `${app.ref} opened by OPS`, entity: 'Application', entityId: String(app._id), appRef: app.ref });
  return {
    ...row(app.toObject(), maps, settings, names),
    agreement: ag && { id: String(ag._id), number: ag.number, kind: ag.kind, signedAt: ag.acceptance?.at, effectiveAt: ag.effectiveAt, terms: ag.terms },
    documents: docs.map((d) => ({ ...appSvc.DOC_VIEW(d), uploadedBy: names.get(String(d.uploadedBy))?.name || null })),
    documentChecklist: (version?.requiredDocuments || []).filter((d) => d.active !== false).map((d) => ({ code: d.code, name: d.name, mandatory: d.mandatory, minFiles: d.minFiles, uploaded: docs.filter((f) => f.documentCode === d.code && f.scan?.status === 'clean').length })),
    creditTo: staff.bank || null,
    staff: { ...row(app.toObject(), maps, settings).staff, mobile: staff.personal?.mobile },
    // D-101: the payslip deduction topped up, and the SLAS loan it settles when there is one.
    topUp: app.topUp?.on ? { loanRef: app.topUp.loanRef || null, payslipLine: app.topUp.payslipLine?.label ? app.topUp.payslipLine : null, outstanding: app.topUp.outstanding ?? null } : null,
    earliestDate: localDay(app.stageEnteredAt),
    today: localDay(),
    schedule: app.schedule || [],
    scheduleBasis: app.scheduleBasis,
    blockedReason: app.status === 'pending_disbursement' ? await blockedReason(req.auth.user._id, app) : null,
  };
}

/**
 * Confirms a disbursement (FR-20 to FR-22).
 * body: { date: 'YYYY-MM-DD', transactionRef?, comment, topUpSettled? }
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
  const comment = (body.comment || '').trim();
  if (!comment) throw badRequest('Add a comment confirming the disbursement.', { comment: ['Add a comment confirming the disbursement.'] }, 'COMMENT_REQUIRED');
  const today = localDay();
  if (body.date > today) throw badRequest('The disbursement date cannot be in the future.', { date: ['The disbursement date cannot be in the future.'] }, 'DATE_INVALID');
  if (body.date < localDay(app.stageEnteredAt)) throw badRequest('The disbursement date cannot be before the final approval.', { date: ['The disbursement date cannot be before the final approval.'] }, 'DATE_INVALID');

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
  const transactionRef = (body.transactionRef || '').trim() || null;
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
        action: 'disbursement.confirm',
        description: `${app.ref} disbursed: ${tzs(amount)} on ${body.date}${transactionRef ? `, ref ${transactionRef}` : ''}`,
        entity: 'Application',
        entityId: String(app._id),
        appRef: app.ref,
        before: { status: 'pending_disbursement', scheduleBasis: app.scheduleBasis, firstDue: app.schedule?.[0]?.due },
        after: { status: 'disbursed', date: body.date, transactionRef, firstDue: schedule[0]?.due },
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
  const set = await Application.updateMany({ status: 'pending_disbursement', stageEnteredAt: { $lte: cutoff }, outsideSla: { $ne: true } }, { $set: { outsideSla: true } });
  const unset = await Application.updateMany({ status: 'pending_disbursement', stageEnteredAt: { $gt: cutoff }, outsideSla: true }, { $set: { outsideSla: false } });
  return set.modifiedCount + unset.modifiedCount;
}

module.exports = { list, detail, confirm, flagOutsideSla, slaInfo, blockedReason };

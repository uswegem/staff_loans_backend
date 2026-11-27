'use strict';

// Data retention (D-115): every loan application and what belongs to it is kept for ten
// years after the loan ends, then its files are deleted and its records anonymised.
//
// When the loan ends:
//   - rejected, withdrawn or declined: the day it was closed;
//   - disbursed: the last repayment due date in the schedule, or the day a top-up settled it;
//   - anything still open (draft, under review, returned, waiting for disbursement): never.
// A legal hold (audit, dispute, investigation) stops the purge until it is released.
//
// The purge of one application:
//   - deletes its uploaded files (payslips, documents, bureau reports, agreement PDFs) from
//     UPLOAD_DIR; their records stay, marked purged, without the original name;
//   - removes from the application the personal and free-text fields (purpose, product
//     answers, bank details, payslip figures, snapshots, probation reason, comments) and the
//     link to the staff member; it keeps the reference, product, amounts, tenor, status,
//     dates and the department, branch and category for statistics;
//   - removes the agreements' text and the applicant's signing evidence (number and terms stay);
//   - removes the decision comments (the decisions themselves stay) and the notifications;
//   - writes an audit entry (retention.purge). Audit log entries are not changed.
// Staff uploads (their checked rows) older than ten years are deleted too.
//
// Decisions and the audit log are append-only through the models; the purge is the one
// exception, made directly on the collections, and only for the fields listed above.

const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const Application = require('../../models/Application');
const Staff = require('../../models/Staff');
const StoredFile = require('../../models/StoredFile');
const audit = require('../audit/auditService');
const { config } = require('../../config/env');
const { localMidnight } = require('../../utils/dates');

const ENDED = ['rejected', 'withdrawn', 'declined'];
const PURGED_NAME = '[deleted after the retention period]';

const years = () => Math.max(10, config.retentionYears || 10);

/** The day the loan ended, or null while it is still open. */
function endOf(app) {
  if (ENDED.includes(app.status)) return app.closedAt || app.updatedAt || null;
  if (app.status === 'disbursed') {
    if (app.settledByTopUp?.at) return new Date(app.settledByTopUp.at);
    const last = app.schedule?.length ? app.schedule[app.schedule.length - 1].due : null;
    if (last) return localMidnight(last);
    return app.disbursement?.date || null;
  }
  return null;
}

/** The day the application may be purged: the end plus the retention period, or null. */
function purgeAfter(app) {
  const end = endOf(app);
  if (!end) return null;
  const d = new Date(end);
  d.setFullYear(d.getFullYear() + years());
  return d;
}

/** Applications whose retention period has passed, not on hold and not yet purged. */
async function due(now = new Date()) {
  const apps = await Application.find({ status: { $in: [...ENDED, 'disbursed'] }, purgedAt: null, 'legalHold.on': { $ne: true } })
    .select('ref status closedAt updatedAt schedule settledByTopUp disbursement')
    .lean();
  return apps.map((a) => ({ app: a, after: purgeAfter(a) })).filter((x) => x.after && x.after <= now);
}

async function removeFile(file) {
  if (!file.storageKey) return null;
  try {
    await fs.unlink(path.join(config.uploadDir, file.storageKey));
    return null;
  } catch (err) {
    return err.code === 'ENOENT' ? null : `${file.storageKey}: ${err.message}`;
  }
}

/** Purges one application (see the header). by: the user who ran it, or null for the job. */
async function purgeOne(appId, { by = null, now = new Date() } = {}) {
  const { db } = mongoose.connection;
  const app = await Application.findById(appId).lean();
  if (!app || app.purgedAt) return null;
  const staff = app.applicantStaffId ? await Staff.findById(app.applicantStaffId).select('department station category').lean() : null;
  const files = await StoredFile.find({ applicationId: app._id }).lean();

  // Records first: once anonymised, nothing shows the files any more.
  await db.collection('applications').updateOne(
    { _id: app._id, purgedAt: null },
    {
      $set: {
        purgedAt: now,
        productFields: {},
        retention: { department: staff?.department || null, station: staff?.station || null, category: staff?.category || null, endedAt: endOf(app), purgedBy: by ? by._id : null },
      },
      $unset: {
        applicantUserId: 1,
        applicantStaffId: 1,
        purpose: 1,
        'repayment.bank': 1,
        'repayment.branch': 1,
        'repayment.accountName': 1,
        'repayment.accountNo': 1,
        'topUp.payslipLine': 1,
        'probation.reason': 1,
        payslip: 1,
        applicantSnapshot: 1,
        calcSnapshot: 1,
        closedReason: 1,
        'recommended.reason': 1,
        'creditRecommendation.reason': 1,
        'booking.note': 1,
        'disbursement.comment': 1,
      },
    }
  );
  await db.collection('agreements').updateMany(
    { applicationId: app._id },
    { $set: { text: PURGED_NAME, purgedAt: now }, $unset: { blocks: 1, 'acceptance.fullName': 1, 'acceptance.staffNo': 1, 'acceptance.ip': 1, 'acceptance.userAgent': 1, 'acceptance.userId': 1 } }
  );
  await db.collection('decisions').updateMany({ applicationId: app._id }, { $set: { comment: null }, $unset: { ip: 1 } });
  await db.collection('notifications').deleteMany({ entity: 'Application', entityId: String(app._id) });
  await db.collection('storedfiles').updateMany({ applicationId: app._id }, { $set: { originalName: PURGED_NAME, purgedAt: now } });

  const errors = (await Promise.all(files.map(removeFile))).filter(Boolean);
  await audit.record({
    actor: by,
    action: 'retention.purge',
    description: `${app.ref}: files deleted and personal data removed ${years()} years after the loan ended (${files.length} file(s)${errors.length ? `; ${errors.length} could not be deleted` : ''})${by ? '' : ', by the retention job'}`,
    entity: 'Application',
    entityId: String(app._id),
    appRef: app.ref,
    status: errors.length ? 'failed' : undefined,
    after: { endedAt: endOf(app), files: files.length, fileErrors: errors },
  });
  return { ref: app.ref, files: files.length, errors };
}

/** Lists, or with apply purges, everything past its retention period. */
async function run({ apply = false, by = null, now = new Date() } = {}) {
  const list = await due(now);
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - years());
  const oldUploads = await mongoose.connection.db.collection('staffimports').countDocuments({ createdAt: { $lt: cutoff } });
  const out = { years: years(), apply, due: list.map((x) => ({ ref: x.app.ref, status: x.app.status, endedAt: endOf(x.app), purgeAfter: x.after })), purged: [], staffUploadsDeleted: 0 };
  if (!apply) return { ...out, staffUploadsDue: oldUploads };
  for (const x of list) {
    // eslint-disable-next-line no-await-in-loop
    const r = await purgeOne(x.app._id, { by, now });
    if (r) out.purged.push(r);
  }
  if (oldUploads) {
    out.staffUploadsDeleted = (await mongoose.connection.db.collection('staffimports').deleteMany({ createdAt: { $lt: cutoff } })).deletedCount;
    await audit.record({ actor: by, action: 'retention.purge', description: `${out.staffUploadsDeleted} staff upload(s) older than ${years()} years deleted${by ? '' : ', by the retention job'}`, entity: 'StaffImport' });
  }
  return out;
}

/** Puts an application on legal hold, or releases it. Audited. */
async function hold(ref, { on, reason, by }) {
  const app = await Application.findOne({ ref: String(ref).toUpperCase() });
  if (!app) throw new Error(`No application "${ref}".`);
  if (app.purgedAt) throw new Error(`${app.ref} was already purged on ${app.purgedAt.toISOString().slice(0, 10)}.`);
  if (on && !String(reason || '').trim()) throw new Error('Give the reason for the legal hold: --reason "<text>".');
  await Application.updateOne({ _id: app._id }, { $set: { legalHold: on ? { on: true, reason: reason.trim(), by: by._id, at: new Date() } : { on: false, releasedBy: by._id, releasedAt: new Date() } } });
  await audit.record({ actor: by, action: on ? 'retention.hold' : 'retention.release', description: `${app.ref}: legal hold ${on ? `placed (${reason.trim()})` : 'released'}`, entity: 'Application', entityId: String(app._id), appRef: app.ref });
  return { ref: app.ref, on };
}

module.exports = { run, due, purgeOne, hold, endOf, purgeAfter, years, PURGED_NAME };

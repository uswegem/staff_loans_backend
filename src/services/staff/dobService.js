'use strict';

// Date of birth with People and Culture verification (D-82). Anyone who may edit the
// record (the staff member, or People and Culture) proposes a value; it stays pending
// and the verified value stays in force until a verifier who did not submit it, and is
// not the staff member concerned, approves it. Same rules as the product maker-checker
// (D-05): one open change per staff member, checker ≠ maker, reasoned rejections,
// everything audited with old and new values.

const DobChange = require('../../models/DobChange');
const Staff = require('../../models/Staff');
const User = require('../../models/User');
const Settings = require('../../models/Settings');
const audit = require('../audit/auditService');
const notify = require('../notify/notificationService');
const calc = require('../calc/loanCalculator');
const { namesOf, fullName } = require('../review/reviewView');
const { withTransaction } = require('../../config/db');
const { localDay, localMidnight } = require('../../utils/dates');
const { badRequest, conflict, forbidden, notFound } = require('../../utils/errors');

/** Whole years from a calendar day to another. */
function ageOn(dob, today) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Checks a proposed date of birth; returns the message for the field, or null. */
function problemWith(dob, settings, today = localDay()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '') || calc.addDaysToDay(dob, 0) !== dob) return 'Enter a real date of birth.';
  if (dob > today) return 'The date of birth cannot be in the future.';
  const age = ageOn(dob, today);
  if (age < settings.dobMinAge || age > settings.dobMaxAge) return `This date of birth gives an age of ${age}. It must be between ${settings.dobMinAge} and ${settings.dobMaxAge}.`;
  return null;
}

/** What the profile, the staff record and the application screens show. */
async function statusOf(staff) {
  const d = staff.dateOfBirth || {};
  const lastRejected = await DobChange.findOne({ staffId: staff._id, status: 'rejected', ...(d.verifiedAt ? { decidedAt: { $gt: d.verifiedAt } } : {}) }).sort({ decidedAt: -1 }).lean();
  const names = await namesOf([d.verifiedBy, d.pending?.submittedBy, lastRejected?.decidedBy].filter(Boolean));
  return {
    verified: d.value || null,
    verifiedAt: d.verifiedAt || null,
    verifiedBy: d.verifiedBy ? names.get(String(d.verifiedBy))?.name || null : null,
    pending: d.pending?.changeId
      ? { id: String(d.pending.changeId), proposed: d.pending.proposed, submittedAt: d.pending.submittedAt, submittedBy: d.pending.submittedBy ? names.get(String(d.pending.submittedBy))?.name || null : 'Earlier profile entry', submittedById: d.pending.submittedBy ? String(d.pending.submittedBy) : null }
      : null,
    lastRejection: lastRejected && !d.pending?.changeId ? { proposed: lastRejected.proposed, reason: lastRejected.reason, at: lastRejected.decidedAt, by: names.get(String(lastRejected.decidedBy))?.name || null } : null,
  };
}

/**
 * Proposes a date of birth. source: 'profile' (the staff member) or 'staff_record'
 * (People and Culture). Returns the pending change.
 */
async function submit(req, staffId, dob, source) {
  const settings = await Settings.get();
  const problem = problemWith(dob, settings);
  if (problem) throw badRequest(problem, { dob: [problem] }, 'DOB_INVALID');
  const staff = await Staff.findById(staffId);
  if (!staff) throw notFound('Staff record not found.');
  if (staff.dateOfBirth?.pending?.changeId) throw conflict(`A date of birth (${staff.dateOfBirth.pending.proposed}) is already waiting for People and Culture. Withdraw it, or wait for the decision, before proposing another.`, 'DOB_CHANGE_PENDING');
  if (staff.dateOfBirth?.value === dob) throw badRequest('This is already the verified date of birth.', { dob: ['This is already the verified date of birth.'] }, 'DOB_UNCHANGED');

  const now = new Date();
  let change;
  try {
    await withTransaction(async (session) => {
      [change] = await DobChange.create([{ staffId: staff._id, proposed: dob, previous: staff.dateOfBirth?.value || null, source, submittedBy: req.auth.user._id, submittedAt: now }], { session });
      const set = await Staff.updateOne(
        { _id: staff._id, 'dateOfBirth.pending.changeId': null },
        { $set: { 'dateOfBirth.pending': { changeId: change._id, proposed: dob, submittedAt: now, submittedBy: req.auth.user._id } } },
        { session }
      );
      if (!set.modifiedCount) throw conflict('Another date of birth was just proposed for this staff member. Reload and try again.', 'DOB_CHANGE_PENDING');
      await audit.record(
        { req, action: 'dob.submit', description: `${staff.staffNo}: date of birth ${dob} proposed${source === 'staff_record' ? ' by People and Culture' : ''}; waiting for verification`, entity: 'Staff', entityId: String(staff._id), before: { dateOfBirth: staff.dateOfBirth?.value || null }, after: { proposed: dob, changeId: String(change._id), status: 'pending' } },
        { session }
      );
    });
  } catch (err) {
    if (err.code === 11000) throw conflict('Another date of birth is already waiting for this staff member.', 'DOB_CHANGE_PENDING');
    throw err;
  }
  await notify.notifyPermission('staff.verifyDob', { type: 'dob.pending', text: `${fullName(staff)} (${staff.staffNo}): a date of birth is waiting for verification.`, href: '/staff/dob-verifications', entity: 'Staff', entityId: String(staff._id) }, { exclude: [req.auth.user._id] });
  return change;
}

/** People and Culture's queue: pending by default, oldest first. */
async function list({ status = 'pending' } = {}) {
  const rows = await DobChange.find({ status }).sort(status === 'pending' ? { submittedAt: 1 } : { decidedAt: -1 }).limit(500).lean();
  const staff = new Map((await Staff.find({ _id: { $in: rows.map((r) => r.staffId) } }).select('staffNo firstName lastName title department dateOfBirth').lean()).map((s) => [String(s._id), s]));
  const names = await namesOf(rows.flatMap((r) => [r.submittedBy, r.decidedBy]));
  return rows.map((r) => {
    const s = staff.get(String(r.staffId)) || {};
    return {
      id: String(r._id),
      staff: { id: String(r.staffId), staffNo: s.staffNo, name: fullName(s), title: s.title, department: s.department },
      current: s.dateOfBirth?.value || null,
      previous: r.previous,
      proposed: r.proposed,
      source: r.source,
      submittedBy: r.submittedBy ? names.get(String(r.submittedBy))?.name || null : 'Earlier profile entry',
      submittedById: r.submittedBy ? String(r.submittedBy) : null,
      submittedAt: r.submittedAt,
      status: r.status,
      decidedBy: r.decidedBy ? names.get(String(r.decidedBy))?.name || null : null,
      decidedAt: r.decidedAt || null,
      reason: r.reason || null,
    };
  });
}

/** Loads a pending change the user may decide: not their own submission, not their own record. */
async function decidable(req, id) {
  const change = await DobChange.findById(id);
  if (!change) throw notFound('Date of birth change not found.');
  if (change.status !== 'pending') throw conflict('This change has already been decided.', 'NOT_PENDING');
  if (change.submittedBy && String(change.submittedBy) === String(req.auth.user._id)) throw forbidden('You submitted this change, so another verifier must decide it.', 'SOD_SELF_VERIFY');
  if (req.auth.user.staffId && String(req.auth.user.staffId) === String(change.staffId)) throw forbidden('This is your own date of birth, so another verifier must decide it.', 'SELF_RECORD');
  return change;
}

async function close(req, change, { status, reason, session }) {
  const now = new Date();
  const done = await DobChange.findOneAndUpdate({ _id: change._id, status: 'pending' }, { $set: { status, decidedBy: req.auth.user._id, decidedAt: now, ...(reason ? { reason } : {}) } }, { new: true, session });
  if (!done) throw conflict('Someone else has just decided this change. Reload the list.', 'STATE_CHANGED');
  return { done, now };
}

async function approve(req, id) {
  const change = await decidable(req, id);
  const staff = await Staff.findById(change.staffId);
  await withTransaction(async (session) => {
    const { now } = await close(req, change, { status: 'approved', session });
    await Staff.updateOne(
      { _id: staff._id },
      { $set: { dateOfBirth: { value: change.proposed, verifiedAt: now, verifiedBy: req.auth.user._id, changeId: change._id }, 'personal.dob': localMidnight(change.proposed) } },
      { session }
    );
    await audit.record(
      { req, action: 'dob.approve', description: `${staff.staffNo}: date of birth ${change.proposed} verified${change.previous ? ` (was ${change.previous})` : ''}`, entity: 'Staff', entityId: String(staff._id), before: { dateOfBirth: staff.dateOfBirth?.value || null }, after: { dateOfBirth: change.proposed, changeId: String(change._id) } },
      { session }
    );
  });
  await notifyStaff(staff, `Your date of birth (${change.proposed}) is verified.`);
  return DobChange.findById(id).lean();
}

async function reject(req, id, reason) {
  const why = (reason || '').trim();
  if (!why) throw badRequest('Give a reason for the rejection.', { reason: ['Give a reason for the rejection.'] }, 'REASON_REQUIRED');
  const change = await decidable(req, id);
  const staff = await Staff.findById(change.staffId);
  await withTransaction(async (session) => {
    await close(req, change, { status: 'rejected', reason: why, session });
    await Staff.updateOne({ _id: staff._id, 'dateOfBirth.pending.changeId': change._id }, { $unset: { 'dateOfBirth.pending': '' } }, { session });
    await audit.record(
      { req, action: 'dob.reject', description: `${staff.staffNo}: proposed date of birth ${change.proposed} rejected: ${why}`, entity: 'Staff', entityId: String(staff._id), before: { dateOfBirth: staff.dateOfBirth?.value || null, proposed: change.proposed }, after: { dateOfBirth: staff.dateOfBirth?.value || null, status: 'rejected', reason: why } },
      { session }
    );
  });
  await notifyStaff(staff, `The date of birth you proposed (${change.proposed}) was not verified: ${why}`);
  return DobChange.findById(id).lean();
}

/** The submitter takes back a pending change (to correct a mistake). */
async function withdraw(req, id) {
  const change = await DobChange.findById(id);
  if (!change || !change.submittedBy || String(change.submittedBy) !== String(req.auth.user._id)) throw notFound('Date of birth change not found.');
  if (change.status !== 'pending') throw conflict('This change has already been decided.', 'NOT_PENDING');
  const staff = await Staff.findById(change.staffId);
  await withTransaction(async (session) => {
    await close(req, change, { status: 'withdrawn', session });
    await Staff.updateOne({ _id: staff._id, 'dateOfBirth.pending.changeId': change._id }, { $unset: { 'dateOfBirth.pending': '' } }, { session });
    await audit.record({ req, action: 'dob.withdraw', description: `${staff.staffNo}: proposed date of birth ${change.proposed} withdrawn by the submitter`, entity: 'Staff', entityId: String(staff._id), before: { proposed: change.proposed, status: 'pending' }, after: { status: 'withdrawn' } }, { session });
  });
  return DobChange.findById(id).lean();
}

async function notifyStaff(staff, text) {
  const user = await User.findOne({ staffId: staff._id }).select('_id').lean();
  if (user) await notify.notifyUsers([user._id], { type: 'dob.decided', text, href: '/profile', entity: 'Staff', entityId: String(staff._id) });
}

module.exports = { submit, list, approve, reject, withdraw, statusOf, problemWith, ageOn };

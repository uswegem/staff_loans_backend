'use strict';

// Maker-checker engine for versioned, effective-dated configuration (BRD 5.1,
// FR-58 to FR-63, decision 32). Used for product versions and for pricing.
//
// A chain is the series of versions of one thing:
//   { Model, filter, fields, validate, entity, describe(doc), defaults (for a first version) }
// Rules enforced here:
//   - one open change (draft, rejected or pending approval) per chain (DECISIONS D-35)
//   - saving validates every value and returns the comparison with the live version (FR-58)
//   - the checker must not be anyone who edited the draft (FR-60, DECISIONS D-36)
//   - rejection needs a reason and returns the draft to the maker (FR-59)
//   - an approved version goes live at liveFrom; the old one stays live until then (FR-61)
//   - every action is audited with before and after values (FR-63)

const audit = require('../audit/auditService');
const { OPEN_STATES, EDITABLE_STATES } = require('../../models/plugins/makerChecker');
const { diff, pick } = require('./productRules');
const { localMidnight, localDay } = require('../../utils/dates');
const { badRequest, conflict, forbidden } = require('../../utils/errors');

const APPROVED = { approvedAt: { $ne: null } };

/** The version in force at `at` (FR-61). */
function liveAt(chain, at = new Date(), session) {
  return chain.Model.findOne({ ...chain.filter, ...APPROVED, liveFrom: { $lte: at } })
    .sort({ liveFrom: -1, version: -1 })
    .session(session || null);
}

/** The most recent approved version, live or scheduled: the base for a new draft. */
function latestApproved(chain, session) {
  return chain.Model.findOne({ ...chain.filter, ...APPROVED }).sort({ liveFrom: -1, version: -1 }).session(session || null);
}

function openChange(chain, session) {
  return chain.Model.findOne({ ...chain.filter, state: { $in: OPEN_STATES } }).session(session || null);
}

function refuseIfInvalid(chain, values) {
  const errors = chain.validate(values);
  if (Object.keys(errors).length) throw badRequest('Check the highlighted values.', errors, 'INVALID_VALUES');
}

async function checkEffectiveDate(chain, doc, session) {
  const today = localDay();
  const day = localDay(doc.effectiveFrom);
  if (day < today) throw badRequest('The effective date has passed. Choose today or a later date.', { effectiveFrom: ['Choose today or a later date.'] }, 'EFFECTIVE_DATE_PASSED');
  const latest = await latestApproved(chain, session);
  if (latest && String(latest._id) !== String(doc._id) && doc.effectiveFrom < latest.effectiveFrom) {
    throw badRequest(
      `Version ${latest.version} takes effect on ${localDay(latest.effectiveFrom)}. This change must take effect on or after that date.`,
      { effectiveFrom: [`On or after ${localDay(latest.effectiveFrom)}.`] },
      'EFFECTIVE_DATE_BEFORE_SCHEDULED'
    );
  }
}

/** Comparison with the live version, plus the scheduled one if it differs. */
async function comparison(chain, doc, session) {
  const live = await liveAt(chain, new Date(), session);
  const latest = await latestApproved(chain, session);
  return {
    liveVersion: live ? { id: String(live._id), version: live.version, liveFrom: live.liveFrom } : null,
    scheduledVersion: latest && (!live || String(latest._id) !== String(live._id)) ? { id: String(latest._id), version: latest.version, liveFrom: latest.liveFrom } : null,
    changes: diff(chain.fields, live, doc),
  };
}

/** Moves a version between states only if it is still in an expected state. */
async function transition(chain, doc, from, set, session) {
  const updated = await chain.Model.findOneAndUpdate({ _id: doc._id, state: { $in: from } }, { $set: set }, { new: true, session });
  if (!updated) throw conflict('Someone else changed this version. Reload and try again.', 'STATE_CHANGED');
  return updated;
}

function snapshot(chain, doc) {
  return { state: doc.state, version: doc.version, effectiveFrom: doc.effectiveFrom, ...pick(chain.fields, doc) };
}

async function createDraft(chain, { req, values, changeType = 'change', effectiveFrom, note, session }) {
  const open = await openChange(chain, session);
  if (open) throw conflict(`${chain.describe(open)} is still open (${open.state.replace('_', ' ')}). Finish or discard it first.`, 'OPEN_CHANGE_EXISTS', { versionId: String(open._id) });
  const base = await latestApproved(chain, session);
  const merged = { ...(base ? pick(chain.fields, base) : chain.defaults || {}), ...values };
  refuseIfInvalid(chain, merged);
  const last = await chain.Model.findOne(chain.filter).sort({ version: -1 }).select('version').session(session || null);
  const actor = req.auth.user._id;
  const [doc] = await chain.Model.create(
    [
      {
        ...chain.filter,
        ...merged,
        version: (last?.version || 0) + 1,
        state: 'draft',
        changeType,
        basedOnVersionId: base?._id || null,
        effectiveFrom: localMidnight(effectiveFrom),
        note,
        editors: [actor],
        makerId: actor,
      },
    ],
    { session }
  );
  await checkEffectiveDate(chain, doc, session);
  await audit.record({ req, action: `${chain.audit}.draft_create`, description: `${chain.describe(doc)} drafted (${changeType})`, entity: chain.entity, entityId: String(doc._id), before: base ? snapshot(chain, base) : null, after: snapshot(chain, doc) }, { session });
  return doc;
}

async function updateDraft(chain, doc, { req, values, effectiveFrom, note, session }) {
  if (!EDITABLE_STATES.includes(doc.state)) throw conflict('Only drafts and rejected versions can be edited.', 'NOT_EDITABLE');
  const before = snapshot(chain, doc);
  const next = doc.changeType === 'deactivate' ? {} : values; // a deactivation carries the live values unchanged
  const merged = { ...pick(chain.fields, doc), ...next };
  refuseIfInvalid(chain, merged);
  const set = { ...next, state: 'draft', makerId: req.auth.user._id };
  if (effectiveFrom) set.effectiveFrom = localMidnight(effectiveFrom);
  if (note !== undefined) set.note = note;
  let updated = await transition(chain, doc, EDITABLE_STATES, set, session);
  updated = await chain.Model.findByIdAndUpdate(updated._id, { $addToSet: { editors: req.auth.user._id } }, { new: true, session });
  await checkEffectiveDate(chain, updated, session);
  await audit.record({ req, action: `${chain.audit}.draft_update`, description: `${chain.describe(updated)} edited`, entity: chain.entity, entityId: String(doc._id), before, after: snapshot(chain, updated) }, { session });
  return updated;
}

async function submit(chain, doc, { req, session }) {
  if (!EDITABLE_STATES.includes(doc.state)) throw conflict('Only drafts can be submitted.', 'NOT_EDITABLE');
  refuseIfInvalid(chain, pick(chain.fields, doc));
  await checkEffectiveDate(chain, doc, session);
  const { changes } = await comparison(chain, doc, session);
  if (!changes.length && doc.changeType === 'change') throw badRequest('Nothing has changed from the live version.', undefined, 'NO_CHANGES');
  const updated = await transition(chain, doc, EDITABLE_STATES, { state: 'pending_approval', stage: 'credit', approvals: [], submittedAt: new Date(), submittedBy: req.auth.user._id, rejectionReason: null }, session);
  await audit.record({ req, action: `${chain.audit}.submit`, description: `${chain.describe(updated)} submitted for the Head of Credit's approval`, entity: chain.entity, entityId: String(doc._id), before: { state: doc.state }, after: { state: 'pending_approval', changes } }, { session });
  return updated;
}

async function recall(chain, doc, { req, session }) {
  const updated = await transition(chain, doc, ['pending_approval'], { state: 'draft', stage: null, approvals: [] }, session);
  await audit.record({ req, action: `${chain.audit}.recall`, description: `${chain.describe(updated)} recalled to draft`, entity: chain.entity, entityId: String(doc._id), before: { state: 'pending_approval' }, after: { state: 'draft' } }, { session });
  return updated;
}

/** The permission each approval stage needs (D-89). */
const STAGE_PERMISSION = { credit: 'products.approveCredit', risk: 'products.approveRisk' };
const STAGE_NAME = { credit: 'Head of Credit', risk: 'Head of Risk and Compliance' };

function refuseSelfCheck(doc, req, verb) {
  const me = String(req.auth.user._id);
  if (doc.editors.map(String).includes(me)) {
    throw forbidden(`You prepared or edited this version, so another approver must ${verb} it.`, 'SELF_APPROVAL');
  }
  if (!req.auth.permissions.has(STAGE_PERMISSION[doc.stage])) {
    throw forbidden(`This version is waiting for the ${STAGE_NAME[doc.stage]}.`, 'WRONG_STAGE');
  }
  if ((doc.approvals || []).some((a) => String(a.by) === me)) {
    throw forbidden('You approved the first stage, so someone else must decide the second.', 'SELF_APPROVAL');
  }
}

async function approve(chain, doc, { req, session }) {
  if (doc.state !== 'pending_approval') throw conflict('Only versions waiting for approval can be approved.', 'NOT_PENDING');
  refuseSelfCheck(doc, req, 'approve');
  await checkEffectiveDate(chain, doc, session);
  const now = new Date();
  const approvals = [...(doc.approvals || []), { stage: doc.stage, by: req.auth.user._id, at: now }];
  if (doc.stage === 'credit') {
    // First approval: on to the Head of Risk and Compliance; nothing goes live yet.
    const moved = await chain.Model.findOneAndUpdate({ _id: doc._id, state: 'pending_approval', stage: 'credit' }, { $set: { stage: 'risk', approvals } }, { new: true, session });
    if (!moved) throw conflict('Someone else changed this version. Reload and try again.', 'STATE_CHANGED');
    await audit.record({ req, action: `${chain.audit}.approve_credit`, description: `${chain.describe(moved)} approved by the Head of Credit; waiting for the Head of Risk and Compliance`, entity: chain.entity, entityId: String(doc._id), before: { state: 'pending_approval', stage: 'credit' }, after: { state: 'pending_approval', stage: 'risk' } }, { session });
    return moved;
  }
  const liveFrom = doc.effectiveFrom > now ? doc.effectiveFrom : now;
  const done = await chain.Model.findOneAndUpdate({ _id: doc._id, state: 'pending_approval', stage: 'risk' }, { $set: { state: 'approved_scheduled', stage: null, approvals, approvedAt: now, liveFrom, checkerId: req.auth.user._id, decidedAt: now } }, { new: true, session });
  if (!done) throw conflict('Someone else changed this version. Reload and try again.', 'STATE_CHANGED');
  await promote(chain, { session });
  const fresh = await chain.Model.findById(doc._id).session(session || null);
  await audit.record({ req, action: `${chain.audit}.publish`, description: `${chain.describe(fresh)} approved by the Head of Risk and Compliance and published; ${fresh.state === 'approved_scheduled' ? `goes live ${localDay(liveFrom)}` : 'live now'}`, entity: chain.entity, entityId: String(doc._id), before: { state: 'pending_approval' }, after: { state: fresh.state, liveFrom } }, { session });
  return fresh;
}

async function reject(chain, doc, { req, reason, session }) {
  if (doc.state !== 'pending_approval') throw conflict('Only versions waiting for approval can be rejected.', 'NOT_PENDING');
  refuseSelfCheck(doc, req, 'reject');
  const why = (reason || '').trim();
  if (!why) throw badRequest('Give a reason for the rejection.', { reason: ['Give a reason for the rejection.'] }, 'REASON_REQUIRED');
  // A rejection at either stage returns the version to Draft with the reason (D-89).
  const stage = doc.stage;
  const updated = await transition(chain, doc, ['pending_approval'], { state: 'draft', stage: null, approvals: [], rejectionReason: why, checkerId: req.auth.user._id, decidedAt: new Date() }, session);
  await audit.record({ req, action: `${chain.audit}.reject`, description: `${chain.describe(updated)} rejected by the ${STAGE_NAME[stage]}: ${why}; returned to draft`, entity: chain.entity, entityId: String(doc._id), before: { state: 'pending_approval', stage }, after: { state: 'draft', reason: why } }, { session });
  return updated;
}

async function discard(chain, doc, { req, session }) {
  const updated = await transition(chain, doc, EDITABLE_STATES, { state: 'discarded' }, session);
  await audit.record({ req, action: `${chain.audit}.discard`, description: `${chain.describe(updated)} discarded`, entity: chain.entity, entityId: String(doc._id), before: { state: doc.state }, after: { state: 'discarded' } }, { session });
  return updated;
}

/**
 * Brings display states in line with time: the live version becomes active (or
 * inactive for a live deactivation), older approved ones superseded, future ones
 * stay scheduled. Idempotent; safe to run from any instance at any time.
 */
async function promote(chain, { now = new Date(), session } = {}) {
  const live = await liveAt(chain, now, session);
  const approved = await chain.Model.find({ ...chain.filter, ...APPROVED }).select('_id state liveFrom changeType').session(session || null);
  const ops = [];
  for (const v of approved) {
    let state;
    if (live && String(v._id) === String(live._id)) state = v.changeType === 'deactivate' ? 'inactive' : 'active';
    else state = v.liveFrom > now ? 'approved_scheduled' : 'superseded';
    if (v.state !== state) ops.push({ updateOne: { filter: { _id: v._id }, update: { $set: { state } } } });
  }
  if (ops.length) await chain.Model.bulkWrite(ops, { session });
  return live;
}

module.exports = { liveAt, latestApproved, openChange, comparison, createDraft, updateDraft, submit, recall, approve, reject, discard, promote, STAGE_PERMISSION, STAGE_NAME };

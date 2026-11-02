'use strict';

// Who may act on an application, and who may see it (BRD 7, FR-13, FR-19, FR-47,
// FR-55). Every stage routes to every active holder of its review permission; the
// applicant never acts on their own application; an active delegate acts in the
// holder's place, on their behalf.

const Application = require('../../models/Application');
const Delegation = require('../../models/Delegation');
const Decision = require('../../models/Decision');
const User = require('../../models/User');
const Staff = require('../../models/Staff');
const rbac = require('../rbac/rbacService');
const { STAGES } = require('./routes');
const { PENDING_STAGE } = require('../../constants/statuses');

const LIMITED_ROUTES = ['mgmt', 'ceo', 'hrhead'];
const FULL_REVIEW = ['review.hr', 'review.pcm', 'review.ceo'];

/** Active users (with active staff records) among ids. */
async function activeUsers(ids, session) {
  const users = await User.find({ _id: { $in: ids }, status: 'active' }).select('staffId').session(session || null).lean();
  const staff = await Staff.find({ _id: { $in: users.map((u) => u.staffId) }, status: 'active' }).select('_id').session(session || null).lean();
  const ok = new Set(staff.map((s) => String(s._id)));
  return new Set(users.filter((u) => ok.has(String(u.staffId))).map((u) => String(u._id)));
}

/**
 * Actors for the application's current stage: [{ userId, onBehalfOf }].
 * onBehalfOf is the holder a delegate covers, or null.
 */
async function stageActors(app, { now = new Date(), session } = {}) {
  const stage = STAGES[app.currentStage];
  if (!stage || !PENDING_STAGE.includes(app.status)) return [];
  const applicant = String(app.applicantUserId);
  const holders = (await rbac.holdersOf(stage.permission, { now, session })).filter((id) => id !== applicant);
  const activeHolders = await activeUsers(holders, session);
  const delegations = await Delegation.find({ delegatorId: { $in: [...activeHolders] }, permissions: stage.permission, ...Delegation.activeFilter(now) })
    .session(session || null)
    .lean();
  const delegates = await activeUsers(delegations.map((d) => d.delegateId), session);
  const out = [];
  for (const h of activeHolders) {
    const d = delegations.find((x) => String(x.delegatorId) === h);
    if (d) {
      const to = String(d.delegateId);
      if (to !== applicant && delegates.has(to)) out.push({ userId: to, onBehalfOf: h });
    } else out.push({ userId: h, onBehalfOf: null });
  }
  return out;
}

async function canAct(userId, app, opts) {
  return (await stageActors(app, opts)).find((a) => a.userId === String(userId)) || null;
}

/** Permissions delegated to a user right now. */
async function delegatedTo(userId, now = new Date()) {
  const rows = await Delegation.find({ delegateId: userId, ...Delegation.activeFilter(now) }).lean();
  return rows;
}

/** Own permissions plus review permissions held through an active delegation. */
async function reviewPermissions(auth, now) {
  const perms = new Set(auth.permissions);
  (await delegatedTo(auth.user._id, now)).forEach((d) => d.permissions.forEach((p) => perms.add(p)));
  return perms;
}

/**
 * FR-55, D-86: a user whose review access is Credit Analyst only sees the applicant's
 * first name, surname, NIDA number and mobile, on every route: no loan details at all.
 * Read-only viewers (loan.viewAll) and the other stages see the full application.
 */
// eslint-disable-next-line no-unused-vars
function isLimited(app, perms) {
  return perms.has('review.credit') && !FULL_REVIEW.some((p) => perms.has(p)) && !perms.has('loan.viewAll');
}

/**
 * Can this user open the application in the review screen, and with which view?
 * Returns { limited, actor } or null. HR and CEO see every submitted application
 * (BRD 4 access table); others see what they can act on or acted on before.
 */
async function reviewAccess(auth, app, { perms } = {}) {
  if (String(app.applicantUserId) === String(auth.user._id)) return null;
  if (!app.cycle) return null; // never submitted
  const p = perms || (await reviewPermissions(auth));
  const actor = await canAct(auth.user._id, app);
  const actedBefore = actor ? true : !!(await Decision.exists({ applicationId: app._id, actorId: auth.user._id }));
  const seesAll = p.has('review.hr') || p.has('review.ceo') || p.has('loan.viewAll'); // loan.viewAll: read-only (D-90)
  if (!actor && !actedBefore && !seesAll) return null;
  return { limited: isLimited(app, p), actor };
}

/** Applications waiting for this user now (FR-13), with who they act for. */
async function queueFor(auth, now = new Date()) {
  const perms = await reviewPermissions(auth, now);
  const stages = Object.values(STAGES).filter((s) => perms.has(s.permission)).map((s) => s.key);
  if (!stages.length) return { items: [], perms };
  const candidates = await Application.find({ status: { $in: PENDING_STAGE }, currentStage: { $in: stages }, applicantUserId: { $ne: auth.user._id } }).sort({ stageDueAt: 1 });
  const items = [];
  for (const app of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const actor = await canAct(auth.user._id, app, { now });
    if (actor) items.push({ app, actor });
  }
  return { items, perms };
}

module.exports = { stageActors, canAct, reviewAccess, reviewPermissions, isLimited, queueFor, delegatedTo, LIMITED_ROUTES, activeUsers };

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
const { STAGES, stageAccepts } = require('./routes');
const { validApprovals, STAGE_ACTIONS } = require('../review/approvals');
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
 * Actors for the application's current stage: [{ userId, onBehalfOf, permission }].
 * onBehalfOf is the holder a delegate covers, or null; permission is the review
 * permission they act with (a stage may accept several, D-103). Someone who could act
 * both in their own right and for another holder acts in their own right.
 */
/** Users with a valid approval of another stage of this application, in any cycle (D-106). */
async function otherStageApprovers(app, session) {
  const rows = await Decision.find({ applicationId: app._id, action: { $in: STAGE_ACTIONS } }).select('actorId action stage cycle details at').session(session || null).lean();
  return validApprovals(rows, app.stages || []).filter((d) => d.stage !== app.currentStage).map((d) => String(d.actorId));
}

async function stageActors(app, { now = new Date(), session } = {}) {
  const stage = STAGES[app.currentStage];
  if (!stage || !PENDING_STAGE.includes(app.status)) return [];
  const applicant = String(app.applicantUserId);
  // Segregation of duties: someone holding several review roles approves one stage of an
  // application only. Whoever approved another stage of it, in any cycle, cannot act here;
  // an approval cancelled by a return to an earlier stage no longer counts (D-106).
  const earlier = await otherStageApprovers(app, session);
  const excluded = new Set([applicant, ...earlier]);
  // The permission each holder acts with: the first of the stage's permissions they hold.
  const permissionOf = new Map();
  for (const permission of stage.permissions) {
    // eslint-disable-next-line no-await-in-loop
    for (const id of await rbac.holdersOf(permission, { now, session })) if (!excluded.has(id) && !permissionOf.has(id)) permissionOf.set(id, permission);
  }
  const activeHolders = await activeUsers([...permissionOf.keys()], session);
  const delegations = await Delegation.find({ delegatorId: { $in: [...activeHolders] }, permissions: { $in: stage.permissions }, ...Delegation.activeFilter(now) })
    .session(session || null)
    .lean();
  const delegates = await activeUsers(delegations.map((d) => d.delegateId), session);
  const out = new Map();
  for (const h of activeHolders) {
    const permission = permissionOf.get(h);
    const d = delegations.find((x) => String(x.delegatorId) === h && x.permissions.includes(permission));
    if (d) {
      const to = String(d.delegateId);
      if (!excluded.has(to) && delegates.has(to) && !out.has(to)) out.set(to, { userId: to, onBehalfOf: h, permission });
    } else out.set(h, { userId: h, onBehalfOf: null, permission });
  }
  return [...out.values()];
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
  if (app.purgedAt) return null; // D-115: anonymised after the retention period
  if (String(app.applicantUserId) === String(auth.user._id)) return null;
  if (!app.cycle) return null; // never submitted
  const p = perms || (await reviewPermissions(auth));
  const actor = await canAct(auth.user._id, app);
  const actedBefore = actor ? true : !!(await Decision.exists({ applicationId: app._id, actorId: auth.user._id }));
  const seesAll = p.has('review.hr') || p.has('review.ceo') || p.has('loan.viewAll'); // loan.viewAll: read-only (D-90)
  if (!actor && !actedBefore && !seesAll) return null;
  // D-102: payslip and salary details are for the People and Culture and CEO stages only;
  // an Auditor (loan.viewAll) sees the application without them.
  return { limited: isLimited(app, p), actor, payHidden: !FULL_REVIEW.some((x) => p.has(x)) };
}

/** Applications waiting for this user now (FR-13), with who they act for. */
async function queueFor(auth, now = new Date()) {
  const perms = await reviewPermissions(auth, now);
  const stages = Object.keys(STAGES).filter((k) => stageAccepts(k, perms));
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

module.exports = { otherStageApprovers, stageActors, canAct, reviewAccess, reviewPermissions, isLimited, queueFor, delegatedTo, LIMITED_ROUTES, FULL_REVIEW, activeUsers };

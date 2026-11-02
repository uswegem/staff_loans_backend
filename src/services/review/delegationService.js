'use strict';

// Time-bound delegates for planned absence (FR-19, BRD 7.3). The delegate acts on the
// delegator's review stages, on their behalf, between the two dates. Delegating must
// not give anyone a combination segregation of duties forbids (FR-48, DECISIONS D-04).

const Delegation = require('../../models/Delegation');
const User = require('../../models/User');
const Staff = require('../../models/Staff');
const rbac = require('../rbac/rbacService');
const audit = require('../audit/auditService');
const notify = require('../notify/notificationService');
const { sodConflicts, REVIEW_PERMISSIONS } = require('../../constants/permissions');
const { localDay, localMidnight } = require('../../utils/dates');
const { badRequest, conflict, forbidden, notFound } = require('../../utils/errors');

const MAX_DAYS = 90;
const fullName = (s) => (s ? [s.firstName, s.lastName].filter(Boolean).join(' ') : '');

async function people(ids) {
  const users = await User.find({ _id: { $in: ids } }).select('staffId staffNo').lean();
  const staff = await Staff.find({ _id: { $in: users.map((u) => u.staffId) } }).select('firstName lastName title').lean();
  const s = new Map(staff.map((x) => [String(x._id), x]));
  return new Map(users.map((u) => [String(u._id), { id: String(u._id), staffNo: u.staffNo, name: fullName(s.get(String(u.staffId))), title: s.get(String(u.staffId))?.title }]));
}

function view(d, names, now = new Date()) {
  const active = !d.revokedAt && d.from <= now && now < new Date(d.until.getTime() + 24 * 3600 * 1000);
  return {
    id: String(d._id),
    delegator: names.get(String(d.delegatorId)),
    delegate: names.get(String(d.delegateId)),
    permissions: d.permissions,
    from: localDay(d.from),
    until: localDay(d.until),
    reason: d.reason,
    status: d.revokedAt ? 'ended' : active ? 'active' : d.from > now ? 'scheduled' : 'ended',
  };
}

async function list(req) {
  const rows = await Delegation.find({ $or: [{ delegatorId: req.auth.user._id }, { delegateId: req.auth.user._id }] }).sort({ from: -1 }).limit(50).lean();
  const names = await people(rows.flatMap((d) => [d.delegatorId, d.delegateId]));
  return {
    given: rows.filter((d) => String(d.delegatorId) === String(req.auth.user._id)).map((d) => view(d, names)),
    received: rows.filter((d) => String(d.delegateId) === String(req.auth.user._id)).map((d) => view(d, names)),
  };
}

/** Colleagues who can be chosen as a delegate (name, staff number and title only). */
async function candidates(req, q) {
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const staff = await Staff.find({ status: 'active', ...(re ? { $or: [{ firstName: re }, { lastName: re }, { staffNo: re }, { title: re }] } : {}) })
    .select('_id staffNo firstName lastName title')
    .limit(20)
    .lean();
  const users = await User.find({ staffId: { $in: staff.map((s) => s._id) }, status: 'active', _id: { $ne: req.auth.user._id } }).select('staffId').lean();
  const byStaff = new Map(users.map((u) => [String(u.staffId), String(u._id)]));
  return staff.filter((s) => byStaff.has(String(s._id))).map((s) => ({ id: byStaff.get(String(s._id)), staffNo: s.staffNo, name: fullName(s), title: s.title }));
}

async function create(req, { delegateUserId, from, until, reason }) {
  const me = req.auth.user;
  if (String(delegateUserId) === String(me._id)) throw badRequest('Choose someone other than yourself.', { delegateUserId: ['Choose someone other than yourself.'] });
  const permissions = REVIEW_PERMISSIONS.filter((p) => req.auth.permissions.has(p));
  if (!permissions.length) throw forbidden('You have no reviews to delegate.', 'NOTHING_TO_DELEGATE');
  if (until < from) throw badRequest('The end date must be after the start date.', { until: ['The end date must be after the start date.'] });
  if (from < localDay()) throw badRequest('The start date cannot be in the past.', { from: ['The start date cannot be in the past.'] });
  if ((localMidnight(until) - localMidnight(from)) / (24 * 3600 * 1000) > MAX_DAYS) throw badRequest(`A delegation can last up to ${MAX_DAYS} days.`, { until: [`Up to ${MAX_DAYS} days.`] });

  const delegate = await User.findById(delegateUserId);
  const staff = delegate && (await Staff.findById(delegate.staffId).select('status').lean());
  if (!delegate || delegate.status !== 'active' || staff?.status !== 'active') throw notFound('That colleague cannot act as a delegate.');

  // SoD (FR-48): the delegate's own permissions plus the delegated ones must not conflict.
  const theirs = (await rbac.effectiveFor(delegate._id)).permissions;
  const conflicts = sodConflicts(new Set([...theirs, ...permissions]));
  if (conflicts.length) throw conflict(`They cannot cover your reviews: ${conflicts[0].name.toLowerCase()}.`, 'SOD_CONFLICT', { conflicts: conflicts.map((c) => c.name) });

  const overlap = await Delegation.exists({ delegatorId: me._id, revokedAt: null, from: { $lte: localMidnight(until) }, until: { $gte: localMidnight(from) } });
  if (overlap) throw conflict('You already have a delegation for those dates. End it first.', 'OVERLAP');

  const d = await Delegation.create({ delegatorId: me._id, delegateId: delegate._id, permissions, from: localMidnight(from), until: localMidnight(until), reason, createdBy: me._id });
  const names = await people([me._id, delegate._id]);
  await audit.record({ req, action: 'delegation.create', description: `${names.get(String(me._id)).name} delegated reviews to ${names.get(String(delegate._id)).name}, ${from} to ${until}`, entity: 'Delegation', entityId: String(d._id), after: { delegate: delegate.staffNo, permissions, from, until } });
  await notify.notifyUsers([delegate._id], { type: 'delegation.set', text: `${names.get(String(me._id)).name} has delegated their reviews to you from ${from} to ${until}. They appear in your review queue.`, href: '/queue', entity: 'Delegation', entityId: String(d._id) });
  return view(d, names);
}

async function end(req, id) {
  const d = await Delegation.findOne({ _id: id, delegatorId: req.auth.user._id, revokedAt: null });
  if (!d) throw notFound('Delegation not found.');
  d.revokedAt = new Date();
  d.revokedBy = req.auth.user._id;
  await d.save();
  await audit.record({ req, action: 'delegation.end', description: 'Delegation ended', entity: 'Delegation', entityId: String(d._id), before: { revokedAt: null }, after: { revokedAt: d.revokedAt } });
  return view(d, await people([d.delegatorId, d.delegateId]));
}

module.exports = { list, candidates, create, end };

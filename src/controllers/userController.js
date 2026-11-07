'use strict';

// Ported from Ess-Backend/src/controllers/userController.js (commit 522bdbd), adapted for SLAS:
// - a user is created from an existing staff record, with a temporary password (DECISIONS Q2)
// - no hard delete: activate/deactivate only (BRD NFR-12)
// - unlock, MFA reset and password reset by an administrator, each audited (prompt 3a.2, 3a.3)
// - multiple roles per user with optional end dates; Staff role always kept (FR-46)
// - segregation-of-duties check on every assignment save (FR-48); administrators
//   cannot change their own roles (DECISIONS D-28)
// - tenant user creation removed

const User = require('../models/User');
const Staff = require('../models/Staff');
const Role = require('../models/Role');
const RoleAssignment = require('../models/RoleAssignment');
const Session = require('../models/Session');
const RefreshToken = require('../models/RefreshToken');
const credentials = require('../services/auth/credentialProvider');
const rbac = require('../services/rbac/rbacService');
const audit = require('../services/audit/auditService');
const { withTransaction } = require('../config/db');
const { badRequest, notFound, conflict, forbidden } = require('../utils/errors');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fullName = (s) => (s ? [s.firstName, s.lastName].filter(Boolean).join(' ') : '');

async function assignmentsOf(userId) {
  const rows = await RoleAssignment.find({ userId, revokedAt: null }).populate('roleId').lean();
  return rows
    .filter((r) => r.roleId)
    .map((r) => ({ assignmentId: String(r._id), roleId: String(r.roleId._id), code: r.roleId.code, name: r.roleId.name, system: r.roleId.system, active: r.roleId.active, endsOn: r.endsOn, assignedAt: r.assignedAt }));
}

async function present(user) {
  const staff = await Staff.findById(user.staffId).lean();
  const eff = await rbac.effectiveFor(user._id);
  return {
    id: String(user._id),
    staffNo: user.staffNo,
    userName: user.userName,
    fullName: fullName(staff),
    title: staff?.title,
    department: staff?.department,
    staffStatus: staff?.status,
    status: user.status,
    failedAttempts: user.failedAttempts,
    lockedAt: user.lockedAt,
    mustChangePassword: user.mustChangePassword,
    mfa: { enabled: !!user.mfa?.enabled, enrolledAt: user.mfa?.enrolledAt, required: eff.mfaRequired },
    lastLoginAt: user.lastLoginAt,
    assignments: await assignmentsOf(user._id),
    permissions: [...eff.permissions].sort(),
  };
}

async function endAccess(userId, reason) {
  await Session.revokeAllForUser(userId, reason);
  await RefreshToken.revokeAllForUser(userId);
}

async function load(id) {
  const user = await User.findById(id);
  if (!user) throw notFound('User not found.');
  return user;
}

const UserController = {
  async list(req, res) {
    const { q, status, roleId, page, limit } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (q) {
      const re = new RegExp(escapeRe(q), 'i');
      const staff = await Staff.find({ $or: [{ firstName: re }, { lastName: re }, { staffNo: re }, { department: re }] }).select('_id').lean();
      filter.staffId = { $in: staff.map((s) => s._id) };
    }
    if (roleId) {
      const ids = await RoleAssignment.find({ roleId, ...rbac.activeFilter() }).distinct('userId');
      filter._id = { $in: ids };
    }
    const [total, users] = await Promise.all([User.countDocuments(filter), User.find(filter).sort({ staffNo: 1 }).skip((page - 1) * limit).limit(limit)]);
    res.json({ success: true, data: { items: await Promise.all(users.map(present)), total, page, limit } });
  },

  async get(req, res) {
    res.json({ success: true, data: await present(await load(req.params.id)) });
  },

  async create(req, res) {
    const staff = await Staff.findOne({ staffNo: req.body.staffNo.toUpperCase() });
    if (!staff) throw badRequest('No staff record has that staff number. People and Culture must add it first.', { staffNo: ['Unknown staff number.'] });
    if (staff.status !== 'active') throw badRequest('That staff record is not active.', { staffNo: ['Staff record is not active.'] });
    if (await User.exists({ staffId: staff._id })) throw conflict('That staff member already has a user account.', 'USER_EXISTS');
    const staffRole = await Role.findOne({ code: 'staff' });

    const user = await withTransaction(async (session) => {
      if (!staff.userName) throw badRequest('Staff username is missing. People and Culture must complete it before account creation.', { userName: ['Username required.'] });
      const u = new User({ staffNo: staff.staffNo, staffId: staff._id, userName: staff.userName, mustChangePassword: true, createdBy: req.auth.user._id });
      await credentials.forUser(u).setPassword(u, req.body.temporaryPassword, { skipHistory: true });
      await u.save({ session });
      await RoleAssignment.create([{ userId: u._id, roleId: staffRole._id, assignedBy: req.auth.user._id }], { session });
      await audit.record({ req, action: 'user.create', description: `User created for ${staff.staffNo} (${fullName(staff)})`, entity: 'User', entityId: String(u._id), after: { staffNo: u.staffNo, roles: ['staff'] } }, { session });
      return u;
    });
    res.status(201).json({ success: true, data: await present(user) });
  },

  async setStatus(req, res) {
    const user = await load(req.params.id);
    const target = req.path.endsWith('/activate') ? 'active' : 'deactivated';
    if (String(user._id) === String(req.auth.user._id)) throw forbidden('You cannot change the status of your own account.', 'SELF_CHANGE');
    const before = { status: user.status };
    user.status = target;
    if (target === 'active') {
      user.failedAttempts = 0;
      user.lockedAt = undefined;
    }
    await user.save();
    if (target === 'deactivated') await endAccess(user._id, 'deactivated');
    await audit.record({ req, action: `user.${target === 'active' ? 'activate' : 'deactivate'}`, description: `${user.staffNo} ${target === 'active' ? 'activated' : 'deactivated'}`, entity: 'User', entityId: String(user._id), before, after: { status: target } });
    res.json({ success: true, data: await present(user) });
  },

  async unlock(req, res) {
    const user = await load(req.params.id);
    if (user.status !== 'locked') throw conflict('This account is not locked.', 'NOT_LOCKED');
    const before = { status: user.status, failedAttempts: user.failedAttempts, lockedAt: user.lockedAt };
    user.status = 'active';
    user.failedAttempts = 0;
    user.lockedAt = undefined;
    await user.save();
    await audit.record({ req, action: 'user.unlock', description: `${user.staffNo} unlocked`, entity: 'User', entityId: String(user._id), before, after: { status: 'active', failedAttempts: 0 } });
    res.json({ success: true, data: await present(user) });
  },

  async resetMfa(req, res) {
    const user = await load(req.params.id);
    if (String(user._id) === String(req.auth.user._id)) throw forbidden('Ask another administrator to reset your MFA.', 'SELF_CHANGE');
    const before = { mfaEnabled: !!user.mfa?.enabled, enrolledAt: user.mfa?.enrolledAt };
    user.mfa = { enabled: false, resetAt: new Date() };
    await user.save();
    await endAccess(user._id, 'mfa_reset');
    await audit.record({ req, action: 'user.mfa_reset', description: `MFA reset for ${user.staffNo}; they enrol again at next sign-in`, entity: 'User', entityId: String(user._id), before, after: { mfaEnabled: false } });
    res.json({ success: true, data: await present(user) });
  },

  async resetPassword(req, res) {
    const user = await load(req.params.id);
    if (String(user._id) === String(req.auth.user._id)) throw forbidden('Use Change password for your own account.', 'SELF_CHANGE');
    await credentials.forUser(user).setPassword(user, req.body.temporaryPassword, { skipHistory: true });
    user.mustChangePassword = true;
    await user.save();
    await endAccess(user._id, 'password_reset');
    await audit.record({ req, action: 'user.password_reset', description: `Temporary password issued for ${user.staffNo}`, entity: 'User', entityId: String(user._id) });
    res.json({ success: true, data: await present(user) });
  },

  async getRoles(req, res) {
    await load(req.params.id);
    res.json({ success: true, data: await assignmentsOf(req.params.id) });
  },

  /** Replaces the user's role set. Body: { assignments: [{ roleId, endsOn? }] } */
  async setRoles(req, res) {
    const user = await load(req.params.id);
    if (String(user._id) === String(req.auth.user._id)) throw forbidden('You cannot change your own roles. Ask another administrator.', 'SELF_CHANGE');

    const wanted = req.body.assignments;
    const ids = [...new Set(wanted.map((a) => a.roleId))];
    if (ids.length !== wanted.length) throw badRequest('Each role can be assigned once.', { assignments: ['Duplicate role.'] });
    const roles = await Role.find({ _id: { $in: ids } }).lean();
    if (roles.length !== ids.length) throw badRequest('One of the roles does not exist.', { assignments: ['Unknown role.'] });
    const staffRole = roles.find((r) => r.code === 'staff');
    if (!staffRole) throw badRequest('Every active staff member keeps the Staff role.', { assignments: ['The Staff role is required.'] }, 'STAFF_ROLE_REQUIRED');
    if (wanted.find((a) => a.roleId === String(staffRole._id)).endsOn) throw badRequest('The Staff role cannot have an end date.', { assignments: ['Remove the end date from Staff.'] }, 'STAFF_ROLE_REQUIRED');
    const inactive = roles.filter((r) => !r.active);
    if (inactive.length) throw badRequest(`${inactive.map((r) => r.name).join(', ')} is deactivated and cannot be assigned.`);

    const conflicts = rbac.checkUserRoles(roles, 'This combination of roles');
    if (conflicts.length) {
      await audit.record({ req, action: 'user.roles_refused', description: `Role change for ${user.staffNo} refused: ${conflicts.map((c) => c.name).join('; ')}`, entity: 'User', entityId: String(user._id), status: 'failed', after: { roles: roles.map((r) => r.code) } });
      throw conflict(conflicts[0].message, 'SOD_CONFLICT', { conflicts });
    }

    const before = await assignmentsOf(user._id);
    await withTransaction(async (session) => {
      const now = new Date();
      const current = await RoleAssignment.find({ userId: user._id, revokedAt: null }).session(session);
      for (const a of current) {
        const keep = wanted.find((w) => w.roleId === String(a.roleId));
        if (!keep) {
          a.revokedAt = now;
          a.revokedBy = req.auth.user._id;
        } else {
          a.endsOn = keep.endsOn || null;
        }
        // eslint-disable-next-line no-await-in-loop
        await a.save({ session });
      }
      const existing = new Set(current.map((a) => String(a.roleId)));
      const added = wanted.filter((w) => !existing.has(w.roleId)).map((w) => ({ userId: user._id, roleId: w.roleId, endsOn: w.endsOn || null, assignedBy: req.auth.user._id, assignedAt: now }));
      if (added.length) await RoleAssignment.create(added, { session, ordered: true });
      const after = wanted.map((w) => ({ code: roles.find((r) => String(r._id) === w.roleId).code, endsOn: w.endsOn || null }));
      await audit.record({ req, action: 'user.roles_change', description: `Roles changed for ${user.staffNo}`, entity: 'User', entityId: String(user._id), before: before.map((b) => ({ code: b.code, endsOn: b.endsOn })), after }, { session });
    });
    res.json({ success: true, data: await present(user) });
  },
};

module.exports = UserController;

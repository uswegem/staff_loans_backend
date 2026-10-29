'use strict';

// Roles and the role-by-permission matrix (FR-43 to FR-48, FR-50).

const Role = require('../models/Role');
const RoleAssignment = require('../models/RoleAssignment');
const rbac = require('../services/rbac/rbacService');
const audit = require('../services/audit/auditService');
const { PERMISSIONS, SOD_RULES, LOCKED_PERMISSIONS, sodConflicts } = require('../constants/permissions');
const { badRequest, notFound, conflict } = require('../utils/errors');

async function withHolders(role) {
  const holders = await RoleAssignment.countDocuments({ roleId: role._id, ...rbac.activeFilter() });
  return { id: String(role._id), code: role.code, name: role.name, description: role.description, system: role.system, active: role.active, permissions: role.permissions, holders };
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'role';
}

async function refuseIfConflicts(req, role, permissions, active) {
  const conflicts = await rbac.checkRoleChange(role?._id, permissions, { active });
  if (conflicts.length) {
    await audit.record({ req, action: 'role.change_refused', description: `Change to role ${role?.name || 'new role'} refused: ${conflicts[0].name}`, entity: 'Role', entityId: role ? String(role._id) : undefined, status: 'failed', after: { permissions } });
    throw conflict(conflicts[0].message, 'SOD_CONFLICT', { conflicts });
  }
}

const RoleController = {
  async catalogue(req, res) {
    res.json({ success: true, data: { permissions: PERMISSIONS, sodRules: SOD_RULES } });
  },

  async list(req, res) {
    const roles = await Role.find().sort({ system: -1, name: 1 });
    res.json({ success: true, data: await Promise.all(roles.map(withHolders)) });
  },

  async create(req, res) {
    const { name, description, permissions } = req.body;
    await refuseIfConflicts(req, null, permissions, true);
    let code = slug(name);
    if (!/^[a-z]/.test(code)) code = `r_${code}`;
    // eslint-disable-next-line no-await-in-loop
    while (await Role.exists({ code })) code = `${code.slice(0, 34)}_${Math.random().toString(36).slice(2, 6)}`;
    const role = await Role.create({ code, name, description, permissions, system: false, active: true });
    await audit.record({ req, action: 'role.create', description: `Role ${name} created`, entity: 'Role', entityId: String(role._id), after: { name, description, permissions } });
    res.status(201).json({ success: true, data: await withHolders(role) });
  },

  async update(req, res) {
    const role = await Role.findById(req.params.id);
    if (!role) throw notFound('Role not found.');
    const next = {
      name: req.body.name ?? role.name,
      description: req.body.description ?? role.description,
      active: req.body.active ?? role.active,
      permissions: req.body.permissions ?? role.permissions,
    };
    if (role.code === 'staff') {
      const missing = LOCKED_PERMISSIONS.filter((p) => !next.permissions.includes(p));
      if (missing.length) throw badRequest('The Staff role always keeps applying for and viewing own loans.', { permissions: missing.map((p) => `${p} is locked on Staff.`) }, 'LOCKED_PERMISSION');
      if (!next.active) throw badRequest('The Staff role cannot be deactivated.', undefined, 'LOCKED_PERMISSION');
    }
    await refuseIfConflicts(req, role, next.permissions, next.active);
    const before = { name: role.name, description: role.description, active: role.active, permissions: [...role.permissions] };
    Object.assign(role, next);
    await role.save();
    await audit.record({ req, action: 'role.update', description: `Role ${role.name} changed`, entity: 'Role', entityId: String(role._id), before, after: next });
    res.json({ success: true, data: await withHolders(role) });
  },

  async remove(req, res) {
    const role = await Role.findById(req.params.id);
    if (!role) throw notFound('Role not found.');
    if (role.system) throw badRequest('System roles can be edited or deactivated but not deleted.', undefined, 'SYSTEM_ROLE');
    if (await RoleAssignment.exists({ roleId: role._id, revokedAt: null })) throw conflict('Remove this role from every user before deleting it.', 'ROLE_IN_USE');
    await Role.deleteOne({ _id: role._id });
    await audit.record({ req, action: 'role.delete', description: `Role ${role.name} deleted`, entity: 'Role', entityId: String(role._id), before: { name: role.name, permissions: role.permissions } });
    res.json({ success: true, message: 'Role deleted.' });
  },

  /** Live check for the matrix screen: a single permission set, or a role change. */
  async sodCheck(req, res) {
    const { roleId, permissions } = req.body;
    const conflicts = roleId
      ? await rbac.checkRoleChange(roleId, permissions, { active: true })
      : sodConflicts(new Set(permissions)).map((c) => ({ rule: c.id, name: c.name, why: c.why, message: `This role: ${c.name.toLowerCase()}.` }));
    res.json({ success: true, data: { ok: conflicts.length === 0, conflicts } });
  },
};

module.exports = RoleController;

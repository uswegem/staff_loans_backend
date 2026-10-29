'use strict';

// Effective permissions and segregation-of-duties checks (BRD 9.5).
// Permissions are resolved from the database on each call, never cached in a
// token, so a change applies on the user's next request (FR-51).

const Role = require('../../models/Role');
const RoleAssignment = require('../../models/RoleAssignment');
const { sodConflicts, requiresMfa } = require('../../constants/permissions');
const { localDateUtc } = require('../calendar/workingTime');

/** Assignment filter for "held today": not revoked, and endsOn absent or today or later. */
function activeFilter(now = new Date(), utcOffsetMinutes = 180) {
  const today = localDateUtc(now, utcOffsetMinutes);
  return { revokedAt: null, $or: [{ endsOn: null }, { endsOn: { $gte: today } }] };
}

async function activeRolesFor(userId, { now, session } = {}) {
  const rows = await RoleAssignment.find({ userId, ...activeFilter(now) })
    .populate({ path: 'roleId', match: { active: true } })
    .session(session || null)
    .lean();
  return rows.filter((r) => r.roleId).map((r) => ({ ...r.roleId, endsOn: r.endsOn, assignmentId: r._id }));
}

async function effectiveFor(userId, opts) {
  const roles = await activeRolesFor(userId, opts);
  const permissions = new Set();
  roles.forEach((r) => r.permissions.forEach((p) => permissions.add(p)));
  return {
    roles: roles.map((r) => ({ id: String(r._id), code: r.code, name: r.name, endsOn: r.endsOn })),
    permissions,
    mfaRequired: requiresMfa(permissions),
  };
}

/** Active users who hold a permission right now (used for routing, FR-47). */
async function holdersOf(permission, { now, session } = {}) {
  const roles = await Role.find({ active: true, permissions: permission }).select('_id').session(session || null).lean();
  if (!roles.length) return [];
  const rows = await RoleAssignment.find({ roleId: { $in: roles.map((r) => r._id) }, ...activeFilter(now) })
    .select('userId')
    .session(session || null)
    .lean();
  return [...new Set(rows.map((r) => String(r.userId)))];
}

function describe(conflicts, subject) {
  return conflicts.map((c) => ({ rule: c.id, name: c.name, why: c.why, message: `${subject}: ${c.name.toLowerCase()}.` }));
}

/**
 * Checks a proposed set of roles for one user. `roles` are role docs (with permissions).
 * Returns [] when the combination is allowed.
 */
function checkUserRoles(roles, subject = 'This assignment') {
  const perms = new Set();
  roles.filter((r) => r.active !== false).forEach((r) => r.permissions.forEach((p) => perms.add(p)));
  return describe(sodConflicts(perms), subject);
}

/**
 * Checks a proposed change to one role: the role on its own, and every user who
 * holds it combined with their other active roles.
 */
async function checkRoleChange(roleId, proposedPermissions, { active = true, session } = {}) {
  const out = describe(sodConflicts(new Set(proposedPermissions)), 'This role');
  if (!active || out.length) return out;
  const holders = await RoleAssignment.find({ roleId, ...activeFilter() }).select('userId').session(session || null).lean();
  for (const { userId } of holders) {
    // eslint-disable-next-line no-await-in-loop
    const others = (await activeRolesFor(userId, { session })).filter((r) => String(r._id) !== String(roleId));
    const combined = [...others, { permissions: proposedPermissions, active: true }];
    const c = checkUserRoles(combined, `A holder of this role (user ${userId})`);
    if (c.length) out.push(...c.map((x) => ({ ...x, userId: String(userId) })));
  }
  return out;
}

module.exports = { effectiveFor, activeRolesFor, holdersOf, checkUserRoles, checkRoleChange, activeFilter };

'use strict';

// Ported from permissionMiddleware in Ess-Backend/src/middleware/authMiddleware.js
// (commit 522bdbd), adapted for SLAS: no super_admin/admin role bypass; permissions
// come from req.auth (resolved per request); privileged permissions need an
// MFA-verified session; denials are audited as permission_denied.

const { permById, MFA_KINDS } = require('../constants/permissions');
const audit = require('../services/audit/auditService');
const { unauthorized, forbidden } = require('../utils/errors');

const privileged = (p) => MFA_KINDS.includes(permById(p)?.kind);

function check(mode, perms) {
  const mw = async (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    const granted = req.auth.permissions;
    const held = perms.filter((p) => granted.has(p));
    const ok = mode === 'all' ? held.length === perms.length : held.length > 0;
    if (!ok) {
      await audit.security('permission_denied', {
        req,
        description: `Permission denied. Required ${mode === 'all' ? 'all' : 'one'} of: ${perms.join(', ')}`,
        metadata: { required: perms },
      });
      return next(forbidden());
    }
    // A privileged permission granted after sign-in still needs a session opened with MFA.
    const needsMfa = mode === 'all' ? held.some(privileged) : held.every(privileged);
    if (needsMfa && !req.auth.session.mfaVerified) {
      return next(forbidden('Sign in again with your one-time code to use this.', 'MFA_STEP_UP'));
    }
    return next();
  };
  mw.slasPermissions = perms; // lets the route guard test see the check
  return mw;
}

const requireAll = (...perms) => check('all', perms);
const requireAny = (...perms) => check('any', perms);

module.exports = { requireAll, requireAny };

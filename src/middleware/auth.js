'use strict';

// Ported from Ess-Backend/src/middleware/authMiddleware.js (commit 522bdbd), adapted for SLAS:
// - tenant, membership, API-key and super_admin branches removed
// - the token identifies a user and a session; the session must be live and not idle (NFR-04)
// - user status and the linked staff record are re-checked on every request (FR-04)
// - effective permissions come from the user's active SLAS roles, loaded per request (FR-51)
// - users with a temporary password can only change it, read /auth/me or sign out

const User = require('../models/User');
const Staff = require('../models/Staff');
const Session = require('../models/Session');
const Settings = require('../models/Settings');
const tokenService = require('../services/auth/tokenService');
const rbac = require('../services/rbac/rbacService');
const audit = require('../services/audit/auditService');
const { unauthorized, forbidden } = require('../utils/errors');

const ACTIVITY_WRITE_EVERY_MS = 30 * 1000;
const PASSWORD_CHANGE_ALLOWED = ['/api/v1/auth/me', '/api/v1/auth/change-password', '/api/v1/auth/logout'];

async function authenticate(req, res, next) {
  try {
    const header = req.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized('Sign in to continue.', 'NO_TOKEN');

    let payload;
    try {
      payload = tokenService.verifyAccess(token);
    } catch (err) {
      await audit.security('invalid_jwt', { req, description: 'Invalid or expired access token', metadata: { reason: err.message } });
      throw unauthorized('Your session has expired. Sign in again.', 'TOKEN_INVALID');
    }

    const [user, session, settings] = await Promise.all([
      User.findById(payload.sub),
      Session.findById(payload.sid),
      Settings.get(),
    ]);
    if (!user || !session || String(session.userId) !== String(user._id)) {
      await audit.security('invalid_jwt', { req, description: 'Token references an unknown user or session' });
      throw unauthorized('Your session has expired. Sign in again.', 'TOKEN_INVALID');
    }
    if (session.revokedAt) {
      await audit.security('session_revoked', { req, actor: user, description: `Request on a closed session (${session.revokedReason || 'revoked'})` });
      throw unauthorized('Your session has ended. Sign in again.', 'SESSION_ENDED');
    }
    const idleMs = settings.inactivityTimeoutMin * 60 * 1000;
    if (Date.now() - session.lastActivityAt.getTime() > idleMs) {
      session.revokedAt = new Date();
      session.revokedReason = 'idle';
      await session.save();
      await audit.security('session_idle', { req, actor: user, description: 'Session closed after inactivity', status: 'success' });
      throw unauthorized('You were signed out after a period of inactivity.', 'SESSION_IDLE');
    }

    const staff = await Staff.findById(user.staffId);
    if (user.status !== 'active' || !staff || staff.status !== 'active') {
      await audit.security(user.status === 'locked' ? 'locked_account_attempt' : 'deactivated_account', {
        req,
        actor: user,
        description: `Request by ${user.staffNo} while account is ${user.status}${staff && staff.status !== 'active' ? ` and staff record is ${staff.status}` : ''}`,
      });
      throw unauthorized('Your account is not active. Contact the IT Service Desk.', 'ACCOUNT_INACTIVE');
    }

    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.includes(req.originalUrl.split('?')[0])) {
      throw forbidden('Change your temporary password to continue.', 'PASSWORD_CHANGE_REQUIRED');
    }

    if (Date.now() - session.lastActivityAt.getTime() > ACTIVITY_WRITE_EVERY_MS) {
      await Session.updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date() } });
    }

    const eff = await rbac.effectiveFor(user._id);
    req.auth = { user, staff, session, sessionId: session._id, ...eff };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticate };

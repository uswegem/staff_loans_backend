'use strict';

// Ported from Ess-Backend/src/controllers/authController.js (commit 522bdbd), adapted for SLAS:
// - login by staff number (LFB + 4 digits) and password through the credential provider (FR-53)
// - lockout after N failures with remaining attempts shown; admin unlock only (prompt 3a.2)
// - TOTP MFA step and first-time enrolment for privileged users (FR-49)
// - refresh token in an httpOnly, Secure, SameSite=Strict cookie, never in the body (prompt 3a.5)
// - CSRF double-submit on refresh and logout; reuse of a rotated refresh token ends the session
// - loginWithApiKey and selectTenant removed; profile returns roles and permissions (FR-52)
// - logout ends the current session only (ESS revoked every token of the user)

const User = require('../models/User');
const Staff = require('../models/Staff');
const Session = require('../models/Session');
const RefreshToken = require('../models/RefreshToken');
const Settings = require('../models/Settings');
const Delegation = require('../models/Delegation');
const credentials = require('../services/auth/credentialProvider');
const tokenService = require('../services/auth/tokenService');
const mfa = require('../services/auth/mfaService');
const rbac = require('../services/rbac/rbacService');
const audit = require('../services/audit/auditService');
const { config } = require('../config/env');
const { withTransaction } = require('../config/db');
const { AppError, unauthorized, badRequest, forbidden } = require('../utils/errors');

const RT_COOKIE = 'slas_rt';
const CSRF_COOKIE = 'XSRF-TOKEN';
const RT_PATH = '/api/v1/auth';

const INVALID = 'The staff number or password is not right.';
const LOCKED = 'Your account is locked after too many failed attempts. Contact the IT Service Desk to unlock it.';
const INACTIVE = 'Your account is not active. Contact the IT Service Desk.';

function cookieBase() {
  return { secure: config.cookieSecure, sameSite: 'strict' };
}

function setSessionCookies(res, rawRefresh, csrf) {
  res.cookie(RT_COOKIE, rawRefresh, { ...cookieBase(), httpOnly: true, path: RT_PATH, maxAge: config.refreshTokenTtlSec * 1000 });
  res.cookie(CSRF_COOKIE, csrf, { ...cookieBase(), httpOnly: false, path: '/', maxAge: config.refreshTokenTtlSec * 1000 });
}

function clearSessionCookies(res) {
  res.clearCookie(RT_COOKIE, { ...cookieBase(), httpOnly: true, path: RT_PATH });
  res.clearCookie(CSRF_COOKIE, { ...cookieBase(), path: '/' });
}

async function profileFor(user) {
  const [staff, eff, settings] = await Promise.all([Staff.findById(user.staffId).lean(), rbac.effectiveFor(user._id), Settings.get()]);
  return {
    session: { inactivityTimeoutMin: settings.inactivityTimeoutMin },
    user: {
      id: String(user._id),
      staffNo: user.staffNo,
      fullName: staff ? [staff.firstName, staff.lastName].filter(Boolean).join(' ') : user.staffNo,
      title: staff?.title,
      department: staff?.department,
      mustChangePassword: user.mustChangePassword,
      mfaEnabled: !!user.mfa?.enabled,
      lastLoginAt: user.lastLoginAt,
    },
    roles: eff.roles,
    permissions: [...eff.permissions].sort(),
    mfaRequired: eff.mfaRequired,
  };
}

/** Opens a session, issues tokens and cookies, and returns the response body. */
async function openSession(req, res, user, { mfaVerified }) {
  const csrf = tokenService.randomToken(24);
  const now = new Date();
  const { rawToken, session } = await withTransaction(async (txn) => {
    const [s] = await Session.create(
      [{ userId: user._id, mfaVerified, csrfHash: tokenService.sha256(csrf), ip: req.ip, userAgent: req.get('User-Agent'), lastActivityAt: now, expiresAt: new Date(now.getTime() + config.refreshTokenTtlSec * 1000) }],
      { session: txn }
    );
    const issued = await RefreshToken.issue({ userId: user._id, sessionId: s._id, ttlSec: config.refreshTokenTtlSec, ip: req.ip, userAgent: req.get('User-Agent') }, txn);
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, failedAttempts: 0 } }, { session: txn });
    await audit.record({ req, actor: user, action: 'auth.login', description: `${user.staffNo} signed in${mfaVerified ? ' with MFA' : ''}`, entity: 'User', entityId: String(user._id) }, { session: txn });
    return { rawToken: issued.rawToken, session: s };
  });
  setSessionCookies(res, rawToken, csrf);
  user.lastLoginAt = now;
  return { accessToken: tokenService.signAccess(user, session._id), expiresIn: config.accessTokenTtlSec, ...(await profileFor(user)) };
}

/** Counts a failed password or code; locks at the threshold. Returns remaining attempts. */
async function registerFailure(req, user, eventType) {
  const settings = await Settings.get();
  const updated = await User.findOneAndUpdate({ _id: user._id, status: 'active' }, { $inc: { failedAttempts: 1 } }, { new: true });
  if (!updated) return 0;
  const remaining = Math.max(0, settings.lockoutThreshold - updated.failedAttempts);
  await audit.security(eventType, { req, actor: user, description: `${eventType === 'mfa_failed' ? 'Wrong one-time code' : 'Wrong password'} for ${user.staffNo} (${remaining} attempts left)`, metadata: { failedAttempts: updated.failedAttempts } });
  if (remaining === 0) {
    await User.updateOne({ _id: user._id }, { $set: { status: 'locked', lockedAt: new Date() } });
    await Session.revokeAllForUser(user._id, 'locked');
    await RefreshToken.revokeAllForUser(user._id);
    await audit.record({ req, actor: user, action: 'auth.locked', description: `${user.staffNo} locked after ${settings.lockoutThreshold} failed attempts`, entity: 'User', entityId: String(user._id), status: 'failed', before: { status: 'active' }, after: { status: 'locked' } });
  }
  return remaining;
}

async function assertCanSignIn(req, user) {
  if (user.status === 'locked') {
    await audit.security('locked_account_attempt', { req, actor: user, description: `Sign-in attempt on locked account ${user.staffNo}` });
    throw new AppError(423, 'ACCOUNT_LOCKED', LOCKED, { remainingAttempts: 0 });
  }
  const staff = await Staff.findById(user.staffId).select('status').lean();
  if (user.status !== 'active' || !staff || staff.status !== 'active') {
    await audit.security('deactivated_account', { req, actor: user, description: `Sign-in attempt on inactive account ${user.staffNo}` });
    throw forbidden(INACTIVE, 'ACCOUNT_INACTIVE');
  }
}

async function userFromMfaToken(req, token, purpose) {
  let p;
  try {
    p = tokenService.verifyMfa(token);
  } catch {
    throw unauthorized('Your sign-in step has expired. Start again.', 'MFA_TOKEN_INVALID');
  }
  if (p.purpose !== purpose) throw unauthorized('Your sign-in step has expired. Start again.', 'MFA_TOKEN_INVALID');
  const user = await User.findById(p.sub);
  if (!user || user.mfa?.pendingJti !== p.jti) throw unauthorized('Your sign-in step has expired. Start again.', 'MFA_TOKEN_INVALID');
  await assertCanSignIn(req, user);
  return user;
}

const AuthController = {
  async login(req, res) {
    const staffNo = req.body.staffNo.toUpperCase();
    const user = await User.findOne({ staffNo });
    if (!user) {
      // Staff numbers are printed on payslips and are not secret; the reply still matches a wrong password.
      await audit.security('unknown_staff_no', { req, description: `Sign-in attempt for unknown staff number ${staffNo}` });
      throw unauthorized(INVALID, 'INVALID_CREDENTIALS');
    }
    await assertCanSignIn(req, user);

    const ok = await credentials.forUser(user).verify(user, req.body.password);
    if (!ok) {
      const remainingAttempts = await registerFailure(req, user, 'invalid_credentials');
      if (remainingAttempts === 0) throw new AppError(423, 'ACCOUNT_LOCKED', LOCKED, { remainingAttempts: 0 });
      throw unauthorized(INVALID, 'INVALID_CREDENTIALS', { remainingAttempts });
    }

    const eff = await rbac.effectiveFor(user._id);
    // A delegate covering someone's reviews holds review permissions too (FR-19, FR-49).
    const delegate = await Delegation.exists({ delegateId: user._id, ...Delegation.activeFilter() });
    if (eff.mfaRequired || delegate) {
      const purpose = user.mfa?.enabled ? 'verify' : 'enrol';
      const { token, jti } = tokenService.signMfa(user, purpose);
      await User.updateOne({ _id: user._id }, { $set: { 'mfa.pendingJti': jti } });
      return res.json({ success: true, data: purpose === 'verify' ? { mfaRequired: true, mfaToken: token } : { enrolRequired: true, mfaToken: token } });
    }
    return res.json({ success: true, data: await openSession(req, res, user, { mfaVerified: false }) });
  },

  async mfaEnrolStart(req, res) {
    const user = await userFromMfaToken(req, req.body.mfaToken, 'enrol');
    const secret = mfa.generateSecret();
    await User.updateOne({ _id: user._id }, { $set: { 'mfa.pendingSecretEnc': mfa.encrypt(secret) } });
    const otpauthUri = mfa.otpauthUri(user.staffNo, secret);
    res.json({ success: true, data: { otpauthUri, qrDataUrl: await mfa.qrDataUrl(otpauthUri), secret } });
  },

  async mfaEnrolConfirm(req, res) {
    const user = await userFromMfaToken(req, req.body.mfaToken, 'enrol');
    if (!user.mfa?.pendingSecretEnc) throw badRequest('Start enrolment first.', undefined, 'MFA_NOT_STARTED');
    const secret = mfa.decrypt(user.mfa.pendingSecretEnc);
    const step = mfa.verifyCode(secret, req.body.code);
    if (step === null) {
      const remainingAttempts = await registerFailure(req, user, 'mfa_failed');
      if (remainingAttempts === 0) throw new AppError(423, 'ACCOUNT_LOCKED', LOCKED, { remainingAttempts: 0 });
      throw unauthorized('That code is not right. Check the time on your phone and try again.', 'MFA_INVALID', { remainingAttempts });
    }
    user.mfa.enabled = true;
    user.mfa.secretEnc = user.mfa.pendingSecretEnc;
    user.mfa.pendingSecretEnc = undefined;
    user.mfa.pendingJti = undefined;
    user.mfa.enrolledAt = new Date();
    user.mfa.lastUsedStep = step;
    await user.save();
    await audit.record({ req, actor: user, action: 'auth.mfa_enrolled', description: `${user.staffNo} enrolled an authenticator app`, entity: 'User', entityId: String(user._id) });
    res.json({ success: true, data: await openSession(req, res, user, { mfaVerified: true }) });
  },

  async mfaVerify(req, res) {
    const user = await userFromMfaToken(req, req.body.mfaToken, 'verify');
    const secret = mfa.decrypt(user.mfa.secretEnc);
    const step = mfa.verifyCode(secret, req.body.code, { lastUsedStep: user.mfa.lastUsedStep ?? -1 });
    if (step === null) {
      const remainingAttempts = await registerFailure(req, user, 'mfa_failed');
      if (remainingAttempts === 0) throw new AppError(423, 'ACCOUNT_LOCKED', LOCKED, { remainingAttempts: 0 });
      throw unauthorized('That code is not right. Check the time on your phone and try again.', 'MFA_INVALID', { remainingAttempts });
    }
    await User.updateOne({ _id: user._id }, { $set: { 'mfa.lastUsedStep': step }, $unset: { 'mfa.pendingJti': 1 } });
    res.json({ success: true, data: await openSession(req, res, user, { mfaVerified: true }) });
  },

  async refresh(req, res) {
    const raw = req.cookies?.[RT_COOKIE];
    if (!raw) throw unauthorized('Sign in to continue.', 'NO_REFRESH');
    const stored = await RefreshToken.findByRawToken(raw);
    if (!stored) {
      await audit.security('refresh_token_invalid', { req, description: 'Unknown refresh token' });
      clearSessionCookies(res);
      throw unauthorized('Your session has expired. Sign in again.', 'REFRESH_INVALID');
    }
    const [user, session, settings] = await Promise.all([User.findById(stored.userId), Session.findById(stored.sessionId), Settings.get()]);

    if (stored.revokedAt && stored.replacedByHash) {
      // A rotated token came back: treat as stolen and end the session (reuse detection).
      await Promise.all([RefreshToken.revokeSession(stored.sessionId), Session.updateOne({ _id: stored.sessionId }, { $set: { revokedAt: new Date(), revokedReason: 'refresh_reuse' } })]);
      await audit.security('refresh_token_reuse', { req, actor: user, description: 'A rotated refresh token was presented; session ended' });
      clearSessionCookies(res);
      throw unauthorized('Your session has ended. Sign in again.', 'REFRESH_REUSED');
    }
    if (!stored.isUsable() || !user || !session || session.revokedAt) {
      await audit.security('refresh_token_invalid', { req, actor: user, description: 'Expired or revoked refresh token' });
      clearSessionCookies(res);
      throw unauthorized('Your session has expired. Sign in again.', 'REFRESH_INVALID');
    }
    if (tokenService.sha256(req.get('X-XSRF-TOKEN') || '') !== session.csrfHash) {
      await audit.security('csrf_rejected', { req, actor: user, description: 'CSRF token does not match the session' });
      throw forbidden('Your request could not be verified. Reload the page and try again.', 'CSRF_REJECTED');
    }
    if (Date.now() - session.lastActivityAt.getTime() > settings.inactivityTimeoutMin * 60 * 1000) {
      await Promise.all([RefreshToken.revokeSession(session._id), Session.updateOne({ _id: session._id }, { $set: { revokedAt: new Date(), revokedReason: 'idle' } })]);
      await audit.security('session_idle', { req, actor: user, description: 'Session closed after inactivity', status: 'success' });
      clearSessionCookies(res);
      throw unauthorized('You were signed out after a period of inactivity.', 'SESSION_IDLE');
    }
    try {
      await assertCanSignIn(req, user);
    } catch (err) {
      await RefreshToken.revokeSession(session._id);
      clearSessionCookies(res);
      throw err;
    }

    const csrf = tokenService.randomToken(24);
    const rawToken = await withTransaction(async (txn) => {
      const issued = await RefreshToken.issue({ userId: user._id, sessionId: session._id, ttlSec: config.refreshTokenTtlSec, ip: req.ip, userAgent: req.get('User-Agent') }, txn);
      const rotated = await RefreshToken.updateOne({ _id: stored._id, revokedAt: null }, { $set: { revokedAt: new Date(), replacedByHash: issued.record.tokenHash } }, { session: txn });
      if (rotated.modifiedCount !== 1) throw unauthorized('Your session has expired. Sign in again.', 'REFRESH_INVALID');
      await Session.updateOne({ _id: session._id }, { $set: { csrfHash: tokenService.sha256(csrf), lastActivityAt: new Date() } }, { session: txn });
      await audit.record({ req, actor: user, action: 'auth.token_refresh', description: `Session refreshed for ${user.staffNo}`, entity: 'Session', entityId: String(session._id) }, { session: txn });
      return issued.rawToken;
    });
    setSessionCookies(res, rawToken, csrf);
    res.json({ success: true, data: { accessToken: tokenService.signAccess(user, session._id), expiresIn: config.accessTokenTtlSec, ...(await profileFor(user)) } });
  },

  async me(req, res) {
    res.json({ success: true, data: await profileFor(req.auth.user) });
  },

  async changePassword(req, res) {
    const user = await User.findById(req.auth.user._id);
    const provider = credentials.forUser(user);
    if (!provider.supportsPasswordChange) throw badRequest('Change your password in the network directory.', undefined, 'NOT_SUPPORTED');
    if (!(await provider.verify(user, req.body.currentPassword))) {
      throw badRequest('Your current password is not right.', { currentPassword: ['Your current password is not right.'] }, 'CURRENT_PASSWORD_WRONG');
    }
    await provider.setPassword(user, req.body.newPassword);
    user.mustChangePassword = false;
    await user.save();
    // Other sessions end; this one continues.
    await Session.updateMany({ userId: user._id, _id: { $ne: req.auth.sessionId }, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } });
    await audit.record({ req, action: 'auth.password_changed', description: `${user.staffNo} changed their password`, entity: 'User', entityId: String(user._id) });
    res.json({ success: true, message: 'Password changed.', data: await profileFor(user) });
  },

  /** Re-checks the password for signing the agreement (FR-34); counts toward lockout. */
  async verifyPassword(user, password, req) {
    const ok = await credentials.forUser(user).verify(user, password);
    if (!ok) {
      const remainingAttempts = await registerFailure(req, user, 'invalid_credentials');
      return { ok: false, remainingAttempts };
    }
    await User.updateOne({ _id: user._id }, { $set: { failedAttempts: 0 } });
    return { ok: true };
  },

  async logout(req, res) {
    const raw = req.cookies?.[RT_COOKIE];
    const stored = raw ? await RefreshToken.findByRawToken(raw) : null;
    if (stored) {
      const session = await Session.findById(stored.sessionId);
      if (session && tokenService.sha256(req.get('X-XSRF-TOKEN') || '') !== session.csrfHash) {
        throw forbidden('Your request could not be verified. Reload the page and try again.', 'CSRF_REJECTED');
      }
      await RefreshToken.revokeSession(stored.sessionId);
      await Session.updateOne({ _id: stored.sessionId }, { $set: { revokedAt: new Date(), revokedReason: 'logout' } });
      const user = await User.findById(stored.userId);
      await audit.record({ req, actor: user, action: 'auth.logout', description: `${user?.staffNo} signed out`, entity: 'Session', entityId: String(stored.sessionId) });
    }
    clearSessionCookies(res);
    res.json({ success: true, message: 'Signed out.' });
  },
};

module.exports = AuthController;
module.exports.RT_COOKIE = RT_COOKIE;
module.exports.CSRF_COOKIE = CSRF_COOKIE;

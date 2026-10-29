'use strict';

// Ported from Ess-Backend/src/utils/securityEventLogger.js (commit 522bdbd), adapted for SLAS:
// security events (failed logins, deactivated-account attempts, permission_denied,
// token refresh, refresh-token reuse) are written to the same append-only audit log
// as business actions, with before/after values (BRD NFR-05, FR-50).

const AuditLog = require('../../models/AuditLog');
const logger = require('../../utils/logger');

function requestMeta(req) {
  if (!req) return {};
  return {
    ip: req.ip,
    userAgent: req.get ? req.get('User-Agent') : undefined,
    correlationId: req.correlationId,
    method: req.method,
    path: req.originalUrl ? req.originalUrl.split('?')[0] : req.path,
  };
}

/** Strips secrets before a value is stored as before/after. */
function scrub(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(scrub);
  const src = typeof value.toObject === 'function' ? value.toObject() : value;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (['passwordHash', 'passwordHistory', 'secretEnc', 'pendingSecretEnc', 'pendingJti', 'tokenHash', 'csrfHash', '__v'].includes(k)) continue;
    out[k] = scrub(v);
  }
  return out;
}

/**
 * Writes one audit entry. Never throws to the caller for failed-path logging;
 * when a session is given the write joins the caller's transaction and errors propagate.
 */
async function record(entry, { session } = {}) {
  const { req, actor, ...rest } = entry;
  const actorUser = actor || req?.auth?.user;
  const doc = {
    at: new Date(),
    actorId: actorUser?._id,
    actorStaffNo: actorUser?.staffNo,
    ...requestMeta(req),
    ...rest,
    before: scrub(rest.before),
    after: scrub(rest.after),
  };
  if (session) {
    await AuditLog.create([doc], { session });
    return;
  }
  try {
    await AuditLog.create(doc);
  } catch (err) {
    logger.error('Audit write failed', { error: err.message, action: doc.action });
    throw err;
  }
}

const SECURITY_EVENTS = new Set([
  'invalid_credentials',
  'unknown_staff_no',
  'account_locked',
  'locked_account_attempt',
  'deactivated_account',
  'invalid_jwt',
  'session_revoked',
  'session_idle',
  'permission_denied',
  'refresh_token_invalid',
  'refresh_token_reuse',
  'csrf_rejected',
  'mfa_failed',
  'rate_limit_exceeded',
]);

function security(eventType, { req, actor, description, metadata, status = 'failed' } = {}) {
  if (!SECURITY_EVENTS.has(eventType)) logger.warn('Unknown security event type', { eventType });
  return record({
    req,
    actor,
    action: `security.${eventType}`,
    description: description || `Security event: ${eventType}`,
    status,
    after: metadata,
  }).catch((err) => logger.error('Security event write failed', { error: err.message, eventType }));
}

module.exports = { record, security, scrub };

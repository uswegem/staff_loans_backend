'use strict';

// CSRF protection for the cookie-authenticated endpoints (refresh, logout):
// double-submit token. The server sets a readable XSRF-TOKEN cookie and stores its
// hash on the session; the client echoes it in X-XSRF-TOKEN (prompt §5, D-15).

const crypto = require('crypto');
const audit = require('../services/audit/auditService');
const { forbidden } = require('../utils/errors');

function requireCsrf(req, res, next) {
  // No refresh cookie means there is no session to act on: refresh answers 401 NO_REFRESH and
  // logout only clears cookies, so a signed-out page load is not logged as a CSRF attack.
  if (!req.cookies?.slas_rt) return next();
  const cookie = req.cookies && req.cookies['XSRF-TOKEN'];
  const header = req.get('X-XSRF-TOKEN');
  const ok = cookie && header && cookie.length === header.length && crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
  if (!ok) {
    audit.security('csrf_rejected', { req, description: 'Missing or mismatched CSRF token' });
    return next(forbidden('Your request could not be verified. Reload the page and try again.', 'CSRF_REJECTED'));
  }
  return next();
}

module.exports = { requireCsrf };

'use strict';

// Ported from Ess-Backend/src/utils/jwtUtils.js (commit 522bdbd), adapted for SLAS:
// - no default secret; config fails fast without JWT_SECRET
// - access tokens carry only sub (user) and sid (session); permissions are loaded
//   from the database on every request so changes apply at once (FR-51)
// - a separate short-lived, single-purpose token bridges password and MFA steps

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { config } = require('../../config/env');

const ALG = 'HS256';

function signAccess(user, sessionId) {
  return jwt.sign({ typ: 'access', sid: String(sessionId) }, config.jwtSecret, {
    algorithm: ALG,
    expiresIn: config.accessTokenTtlSec,
    issuer: config.issuer,
    audience: 'slas',
    subject: String(user._id),
  });
}

function verifyAccess(token) {
  const p = jwt.verify(token, config.jwtSecret, { algorithms: [ALG], issuer: config.issuer, audience: 'slas' });
  if (p.typ !== 'access') throw new Error('Wrong token type');
  return p;
}

/** Issued after a correct password when MFA is still needed. Single use via jti. */
function signMfa(user, purpose) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign({ typ: 'mfa', purpose, jti }, config.jwtSecret, {
    algorithm: ALG,
    expiresIn: config.mfaTokenTtlSec,
    issuer: config.issuer,
    audience: 'slas-mfa',
    subject: String(user._id),
  });
  return { token, jti };
}

function verifyMfa(token) {
  const p = jwt.verify(token, config.jwtSecret, { algorithms: [ALG], issuer: config.issuer, audience: 'slas-mfa' });
  if (p.typ !== 'mfa') throw new Error('Wrong token type');
  return p;
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

module.exports = { signAccess, verifyAccess, signMfa, verifyMfa, randomToken, sha256 };

'use strict';

require('dotenv').config({ quiet: true });

/**
 * Validated configuration. The process refuses to start without secrets:
 * no default JWT secret (ESS had a hard-coded fallback).
 */
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

function load() {
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const mfaKey = required('MFA_ENC_KEY');
  if (!/^[0-9a-f]{64}$/i.test(mfaKey)) throw new Error('MFA_ENC_KEY must be 64 hex characters (32 bytes)');

  return Object.freeze({
    nodeEnv: process.env.NODE_ENV || 'development',
    port: int('PORT', 4000),
    mongoUri: required('MONGODB_URI'),
    jwtSecret,
    mfaEncKey: Buffer.from(mfaKey, 'hex'),
    accessTokenTtlSec: int('ACCESS_TOKEN_TTL_SEC', 15 * 60),
    refreshTokenTtlSec: int('REFRESH_TOKEN_TTL_SEC', 8 * 60 * 60),
    mfaTokenTtlSec: int('MFA_TOKEN_TTL_SEC', 5 * 60),
    cookieSecure: bool('COOKIE_SECURE', true),
    corsOrigin: process.env.CORS_ORIGIN || '',
    trustProxy: process.env.TRUST_PROXY || 'loopback',
    // Outside any web root (NFR-07). The API serves no static files; storage/ is gitignored.
    uploadDir: process.env.UPLOAD_DIR || require('path').resolve(__dirname, '../../storage/uploads'),
    logLevel: process.env.LOG_LEVEL || 'info',
    loginRateLimitPerMin: int('LOGIN_RATE_LIMIT_PER_MIN', 20),
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    issuer: 'slas-api',
    mfaIssuer: process.env.MFA_ISSUER || 'LFB Staff Loans',
  });
}

let cached;
module.exports = {
  get config() {
    if (!cached) cached = load();
    return cached;
  },
  /** Tests change env between files. */
  reset() {
    cached = undefined;
  },
};

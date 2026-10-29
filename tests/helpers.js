'use strict';

const request = require('supertest');
const { buildApp } = require('../src/app');
const User = require('../src/models/User');
const mfa = require('../src/services/auth/mfaService');
const { seedFoundation } = require('../seed/foundation');

const PASSWORD = 'Sample#2026';

let appInstance;
const app = () => {
  if (!appInstance) appInstance = buildApp();
  return appInstance;
};

const seed = (opts = {}) => seedFoundation({ password: PASSWORD, ...opts });

/** Parses Set-Cookie headers into { name: { value, attrs } }. */
function parseCookies(res) {
  const out = {};
  for (const line of res.headers['set-cookie'] || []) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = { value: decodeURIComponent(pair.slice(i + 1)), attrs: attrs.map((a) => a.toLowerCase()) };
  }
  return out;
}

const cookieHeader = (cookies) =>
  Object.entries(cookies)
    .filter(([, c]) => c.value)
    .map(([k, c]) => `${k}=${encodeURIComponent(c.value)}`)
    .join('; ');

/** A valid TOTP code for the user's enrolled secret (test-only: clears the replay guard). */
async function currentCode(staffNo, secret) {
  if (secret) return mfa.hotp(secret, mfa.currentStep());
  const user = await User.findOne({ staffNo });
  await User.updateOne({ _id: user._id }, { $set: { 'mfa.lastUsedStep': -1 } });
  return mfa.hotp(mfa.decrypt(user.mfa.secretEnc), mfa.currentStep());
}

/**
 * Signs in through every step (password, enrolment or code).
 * Returns { token, cookies, body, res }.
 */
async function signIn(staffNo, password = PASSWORD) {
  let res = await request(app()).post('/api/v1/auth/login').send({ staffNo, password });
  if (res.status !== 200) throw new Error(`login ${staffNo} failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.data.enrolRequired) {
    const start = await request(app()).post('/api/v1/auth/mfa/enrol/start').send({ mfaToken: res.body.data.mfaToken });
    const code = await currentCode(staffNo, start.body.data.secret);
    res = await request(app()).post('/api/v1/auth/mfa/enrol/confirm').send({ mfaToken: res.body.data.mfaToken, code });
  } else if (res.body.data.mfaRequired) {
    const code = await currentCode(staffNo);
    res = await request(app()).post('/api/v1/auth/mfa/verify').send({ mfaToken: res.body.data.mfaToken, code });
  }
  if (res.status !== 200) throw new Error(`MFA ${staffNo} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken, cookies: parseCookies(res), body: res.body, res };
}

const authed = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { app, seed, signIn, parseCookies, cookieHeader, currentCode, authed, PASSWORD, request };

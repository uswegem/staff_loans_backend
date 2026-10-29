'use strict';

// Sign-in, lockout, MFA, sessions and tokens (FR-49, FR-53, NFR-02, NFR-04, prompt 3a).
// Cases marked [ESS] are ported from Ess-Backend/tests/integration/auth.test.js
// and src/middleware/__tests__/authMiddleware.test.js (commit 522bdbd).

const jwt = require('jsonwebtoken');
const { app, seed, signIn, parseCookies, cookieHeader, authed, PASSWORD, request } = require('../helpers');
const User = require('../../src/models/User');
const Staff = require('../../src/models/Staff');
const Session = require('../../src/models/Session');
const AuditLog = require('../../src/models/AuditLog');
const Settings = require('../../src/models/Settings');
const mfa = require('../../src/services/auth/mfaService');

const login = (body) => request(app()).post('/api/v1/auth/login').send(body);

beforeEach(async () => {
  await seed();
});

describe('sign-in with staff number and password', () => {
  it('[ESS] signs in a staff member and returns an access token, never a refresh token in the body', async () => {
    const res = await login({ staffNo: 'LFB0412', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/slas_rt/);
    expect(res.body.data.user.fullName).toBe('Neema Mushi');
    expect(res.body.data.permissions).toEqual(['loan.apply', 'loan.viewOwn']);
  });

  it('sets the refresh token as an httpOnly, Secure, SameSite=Strict cookie on the auth path', async () => {
    const res = await login({ staffNo: 'LFB0412', password: PASSWORD });
    const c = parseCookies(res);
    expect(c.slas_rt.attrs).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=strict', 'path=/api/v1/auth']));
    expect(c['XSRF-TOKEN'].attrs).not.toContain('httponly');
    expect(c['XSRF-TOKEN'].attrs).toEqual(expect.arrayContaining(['secure', 'samesite=strict']));
  });

  it('accepts the staff number in lower case', async () => {
    const res = await login({ staffNo: 'lfb0412', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('validates the LFB0000 format', async () => {
    const res = await login({ staffNo: 'LFB412', password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.details.staffNo[0]).toBe('Staff numbers look like LFB0412.');
  });

  it('[ESS] rejects invalid credentials and shows remaining attempts', async () => {
    const res = await login({ staffNo: 'LFB0412', password: 'wrong-pass' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.details.remainingAttempts).toBe(4);
  });

  it('refuses an unknown staff number with the same message', async () => {
    const res = await login({ staffNo: 'LFB9999', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('The staff number or password is not right.');
  });

  it('counts down and locks the account at the 5th failure', async () => {
    const remaining = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await login({ staffNo: 'LFB0412', password: 'wrong-pass' });
      remaining.push(r.body.details.remainingAttempts);
    }
    expect(remaining).toEqual([4, 3, 2, 1]);
    const fifth = await login({ staffNo: 'LFB0412', password: 'wrong-pass' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.code).toBe('ACCOUNT_LOCKED');
    // Even the right password is refused once locked.
    const right = await login({ staffNo: 'LFB0412', password: PASSWORD });
    expect(right.status).toBe(423);
    expect((await User.findOne({ staffNo: 'LFB0412' })).status).toBe('locked');
    expect(await AuditLog.countDocuments({ action: 'auth.locked' })).toBe(1);
  });

  it('resets the failure count after a successful sign-in', async () => {
    await login({ staffNo: 'LFB0412', password: 'wrong-pass' });
    await login({ staffNo: 'LFB0412', password: PASSWORD });
    const r = await login({ staffNo: 'LFB0412', password: 'wrong-pass' });
    expect(r.body.details.remainingAttempts).toBe(4);
  });

  it('[ESS] refuses a deactivated account', async () => {
    await User.updateOne({ staffNo: 'LFB0412' }, { $set: { status: 'deactivated' } });
    const res = await login({ staffNo: 'LFB0412', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
    expect(await AuditLog.countDocuments({ action: 'security.deactivated_account' })).toBe(1);
  });

  it('refuses staff whose record has exited (FR-04)', async () => {
    await Staff.updateOne({ staffNo: 'LFB0412' }, { $set: { status: 'exited' } });
    const res = await login({ staffNo: 'LFB0412', password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('audits failed and successful sign-ins', async () => {
    await login({ staffNo: 'LFB0412', password: 'wrong-pass' });
    await login({ staffNo: 'LFB0412', password: PASSWORD });
    expect(await AuditLog.countDocuments({ action: 'security.invalid_credentials' })).toBe(1);
    const ok = await AuditLog.findOne({ action: 'auth.login' });
    expect(ok.actorStaffNo).toBe('LFB0412');
    expect(ok.ip).toBeTruthy();
  });
});

describe('MFA for privileged users (FR-49)', () => {
  it('asks a reviewer to enrol at first sign-in, then for a code', async () => {
    const first = await login({ staffNo: 'LFB0233', password: PASSWORD });
    expect(first.body.data.enrolRequired).toBe(true);
    expect(first.body.data.accessToken).toBeUndefined();

    const start = await request(app()).post('/api/v1/auth/mfa/enrol/start').send({ mfaToken: first.body.data.mfaToken });
    expect(start.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(start.body.data.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

    const code = mfa.hotp(start.body.data.secret, mfa.currentStep());
    const done = await request(app()).post('/api/v1/auth/mfa/enrol/confirm').send({ mfaToken: first.body.data.mfaToken, code });
    expect(done.status).toBe(200);
    expect(done.body.data.accessToken).toBeTruthy();
    expect(done.body.data.permissions).toContain('review.credit');

    const second = await login({ staffNo: 'LFB0233', password: PASSWORD });
    expect(second.body.data.mfaRequired).toBe(true);
  });

  it.each(['LFB0233', 'LFB0051', 'LFB0002', 'LFB0318', 'LFB0274', 'LFB0010', 'LFB0129'])('requires MFA for %s', async (staffNo) => {
    const res = await login({ staffNo, password: PASSWORD });
    expect(res.body.data.enrolRequired || res.body.data.mfaRequired).toBe(true);
  });

  it.each(['LFB0412', 'LFB0067'])('does not require MFA for %s', async (staffNo) => {
    const res = await login({ staffNo, password: PASSWORD });
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('refuses a wrong code and counts it toward lockout', async () => {
    await signIn('LFB0233');
    const pw = await login({ staffNo: 'LFB0233', password: PASSWORD });
    const res = await request(app()).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.data.mfaToken, code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.details.remainingAttempts).toBe(4);
  });

  it('refuses a replayed code', async () => {
    await signIn('LFB0233');
    const user = await User.findOne({ staffNo: 'LFB0233' });
    const secret = mfa.decrypt(user.mfa.secretEnc);
    const step = mfa.currentStep();
    await User.updateOne({ _id: user._id }, { $set: { 'mfa.lastUsedStep': step } });
    const pw = await login({ staffNo: 'LFB0233', password: PASSWORD });
    const res = await request(app()).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.data.mfaToken, code: mfa.hotp(secret, step) });
    expect(res.status).toBe(401);
  });

  it('an MFA token cannot be used twice or as an access token', async () => {
    await signIn('LFB0233');
    const pw = await login({ staffNo: 'LFB0233', password: PASSWORD });
    const { currentCode } = require('../helpers');
    const ok = await request(app()).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.data.mfaToken, code: await currentCode('LFB0233') });
    expect(ok.status).toBe(200);
    const again = await request(app()).post('/api/v1/auth/mfa/verify').send({ mfaToken: pw.body.data.mfaToken, code: await currentCode('LFB0233') });
    expect(again.status).toBe(401);
    const asAccess = await request(app()).get('/api/v1/auth/me').set(authed(pw.body.data.mfaToken));
    expect(asAccess.status).toBe(401);
  });
});

describe('access tokens and the profile', () => {
  it('[ESS] rejects profile access without a token', async () => {
    const res = await request(app()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('[ESS] allows profile access with a valid access token', async () => {
    const { token } = await signIn('LFB0412');
    const res = await request(app()).get('/api/v1/auth/me').set(authed(token));
    expect(res.status).toBe(200);
    expect(res.body.data.user.staffNo).toBe('LFB0412');
    expect(res.body.data.roles.map((r) => r.code)).toEqual(['staff']);
  });

  it('[ESS] rejects a token signed with another secret', async () => {
    const forged = jwt.sign({ typ: 'access', sid: 'x' }, 'not-the-secret-0123456789-0123456789', { subject: 'x', issuer: 'slas-api', audience: 'slas' });
    const res = await request(app()).get('/api/v1/auth/me').set(authed(forged));
    expect(res.status).toBe(401);
  });

  it('[ESS] rejects a token for a user who has since been deactivated', async () => {
    const { token } = await signIn('LFB0412');
    await User.updateOne({ staffNo: 'LFB0412' }, { $set: { status: 'deactivated' } });
    const res = await request(app()).get('/api/v1/auth/me').set(authed(token));
    expect(res.status).toBe(401);
  });

  it('signs a user out after the inactivity timeout (NFR-04)', async () => {
    const { token } = await signIn('LFB0412');
    const s = await Settings.get();
    await Session.updateMany({}, { $set: { lastActivityAt: new Date(Date.now() - (s.inactivityTimeoutMin + 1) * 60000) } });
    const res = await request(app()).get('/api/v1/auth/me').set(authed(token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_IDLE');
  });
});

describe('refresh and logout', () => {
  const refresh = (cookies, csrf = cookies['XSRF-TOKEN'].value) =>
    request(app()).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(cookies)).set('X-XSRF-TOKEN', csrf);

  it('[ESS] rotates the refresh token and issues a new access token', async () => {
    const { cookies } = await signIn('LFB0412');
    const res = await refresh(cookies);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    const next = parseCookies(res);
    expect(next.slas_rt.value).not.toBe(cookies.slas_rt.value);
    expect(next['XSRF-TOKEN'].value).not.toBe(cookies['XSRF-TOKEN'].value);
  });

  it('refuses refresh without the CSRF header', async () => {
    const { cookies } = await signIn('LFB0412');
    const res = await request(app()).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(cookies));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_REJECTED');
  });

  it('refuses refresh with a CSRF token from another session', async () => {
    const a = await signIn('LFB0412');
    const b = await signIn('LFB0451');
    const mixed = { slas_rt: a.cookies.slas_rt, 'XSRF-TOKEN': b.cookies['XSRF-TOKEN'] };
    const res = await refresh(mixed);
    expect(res.status).toBe(403);
  });

  it('treats reuse of a rotated refresh token as theft and ends the session', async () => {
    const { cookies, token } = await signIn('LFB0412');
    const first = await refresh(cookies);
    expect(first.status).toBe(200);
    const replay = await refresh(cookies);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_REUSED');
    // The legitimate newer token and the access token are now dead too.
    const newer = await refresh(parseCookies(first));
    expect(newer.status).toBe(401);
    expect((await request(app()).get('/api/v1/auth/me').set(authed(token))).status).toBe(401);
    expect(await AuditLog.countDocuments({ action: 'security.refresh_token_reuse' })).toBe(1);
  });

  it('logout ends the session, the refresh token and the access token', async () => {
    const { cookies, token } = await signIn('LFB0412');
    const out = await request(app()).post('/api/v1/auth/logout').set('Cookie', cookieHeader(cookies)).set('X-XSRF-TOKEN', cookies['XSRF-TOKEN'].value);
    expect(out.status).toBe(200);
    expect((await refresh(cookies)).status).toBe(401);
    expect((await request(app()).get('/api/v1/auth/me').set(authed(token))).status).toBe(401);
  });

  it('logout only ends the current session', async () => {
    const one = await signIn('LFB0412');
    const two = await signIn('LFB0412');
    await request(app()).post('/api/v1/auth/logout').set('Cookie', cookieHeader(one.cookies)).set('X-XSRF-TOKEN', one.cookies['XSRF-TOKEN'].value);
    expect((await request(app()).get('/api/v1/auth/me').set(authed(two.token))).status).toBe(200);
  });
});

describe('passwords', () => {
  it('a temporary password allows only changing it', async () => {
    await User.updateOne({ staffNo: 'LFB0412' }, { $set: { mustChangePassword: true } });
    const { token } = await signIn('LFB0412');
    expect((await request(app()).get('/api/v1/auth/me').set(authed(token))).status).toBe(200);
    const change = await request(app()).post('/api/v1/auth/change-password').set(authed(token)).send({ currentPassword: PASSWORD, newPassword: 'Mwanza#2027' });
    expect(change.status).toBe(200);
    expect(change.body.data.user.mustChangePassword).toBe(false);
  });

  it('enforces the password policy and history', async () => {
    const { token } = await signIn('LFB0412');
    const short = await request(app()).post('/api/v1/auth/change-password').set(authed(token)).send({ currentPassword: PASSWORD, newPassword: 'Ab#1' });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('PASSWORD_POLICY');
    const same = await request(app()).post('/api/v1/auth/change-password').set(authed(token)).send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect(same.body.details.password[0]).toMatch(/reuse/);
  });

  it('refuses a wrong current password', async () => {
    const { token } = await signIn('LFB0412');
    const res = await request(app()).post('/api/v1/auth/change-password').set(authed(token)).send({ currentPassword: 'nope-nope', newPassword: 'Mwanza#2027' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CURRENT_PASSWORD_WRONG');
  });

  it('the new password works and the old one does not', async () => {
    const { token } = await signIn('LFB0412');
    await request(app()).post('/api/v1/auth/change-password').set(authed(token)).send({ currentPassword: PASSWORD, newPassword: 'Mwanza#2027' });
    expect((await login({ staffNo: 'LFB0412', password: PASSWORD })).status).toBe(401);
    expect((await login({ staffNo: 'LFB0412', password: 'Mwanza#2027' })).status).toBe(200);
  });
});

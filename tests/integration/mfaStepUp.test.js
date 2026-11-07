'use strict';

// FR-49 regression guard for UAT: privileged access always needs a session opened with a
// one-time code, however the session was obtained or renewed, and username sign-in
// (a70aba8) still asks privileged users for MFA.

const { app, seed, signIn, cookieHeader, authed, request } = require('../helpers');
const User = require('../../src/models/User');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');

const login = (userName, password = require('../helpers').PASSWORD) => request(app()).post('/api/v1/auth/login').send({ userName, password });

beforeEach(async () => {
  await seed();
});

async function grant(staffNo, roleCode) {
  const user = await User.findOne({ staffNo });
  const role = await Role.findOne({ code: roleCode });
  await RoleAssignment.create({ userId: user._id, roleId: role._id, assignedBy: user._id });
}

async function refresh(cookies) {
  return request(app()).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(cookies)).set('X-XSRF-TOKEN', cookies['XSRF-TOKEN'].value);
}

describe('MFA cannot be bypassed', () => {
  it('username sign-in gives a privileged user an MFA token, never an access token or cookie', async () => {
    const res = await login('lfb0233');
    expect(res.body.data.enrolRequired || res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('upper-case or padded usernames do not skip the MFA step', async () => {
    for (const name of ['LFB0233', '  lfb0233 ']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await login(name);
      expect(res.body.data.accessToken).toBeUndefined();
    }
  });

  it('an MFA token is refused by protected endpoints', async () => {
    const res = await login('lfb0233');
    const me = await request(app()).get('/api/v1/auth/me').set(authed(res.body.data.mfaToken));
    expect(me.status).toBe(401);
  });

  it('a role granted mid-session stays blocked, also after the session is refreshed', async () => {
    const { token, cookies } = await signIn('LFB0412'); // opened without MFA
    await grant('LFB0412', 'sys_admin');

    const before = await request(app()).get('/api/v1/users').set(authed(token));
    expect(before.status).toBe(403);
    expect(before.body.code).toBe('MFA_STEP_UP');

    const renewed = await refresh(cookies);
    expect(renewed.status).toBe(200);
    expect(renewed.body.data.mfaRequired).toBe(true);
    const after = await request(app()).get('/api/v1/users').set(authed(renewed.body.data.accessToken));
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('MFA_STEP_UP');
  });

  it('signing in again after the grant asks for enrolment, then allows access', async () => {
    await grant('LFB0412', 'sys_admin');
    const res = await login('lfb0412');
    expect(res.body.data.enrolRequired).toBe(true);
    const { token } = await signIn('LFB0412');
    expect((await request(app()).get('/api/v1/users').set(authed(token))).status).toBe(200);
  });

  it('a temporary password reset by an administrator does not remove MFA', async () => {
    const admin = await signIn('LFB0274');
    const juma = await User.findOne({ staffNo: 'LFB0233' });
    await signIn('LFB0233'); // enrols
    const reset = await request(app()).post(`/api/v1/users/${juma._id}/reset-password`).set(authed(admin.token)).send({ temporaryPassword: 'Temp@2026x' });
    expect(reset.status).toBe(200);
    const res = await login('lfb0233', 'Temp@2026x');
    expect(res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.accessToken).toBeUndefined();
  });
});

describe('signed-out page loads', () => {
  it('a refresh without a session cookie is a plain 401, not a CSRF security event', async () => {
    const AuditLog = require('../../src/models/AuditLog');
    const res = await request(app()).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_REFRESH');
    expect(await AuditLog.countDocuments({ action: 'security.csrf_rejected' })).toBe(0);
  });
});

'use strict';

// User management ported from ESS and extended (prompt 3a): create from a staff
// record, unlock, MFA reset, password reset, deactivate — all audited.

const { app, seed, signIn, authed, PASSWORD, request } = require('../helpers');
const User = require('../../src/models/User');
const Staff = require('../../src/models/Staff');
const AuditLog = require('../../src/models/AuditLog');

let admin;
const idOf = async (staffNo) => String((await User.findOne({ staffNo }))._id);
const login = (staffNo, password = PASSWORD) => request(app()).post('/api/v1/auth/login').send({ staffNo, password });

beforeEach(async () => {
  await seed();
  admin = await signIn('LFB0274');
});

describe('users list and detail', () => {
  it('[ESS] lists users with search, roles and MFA flags', async () => {
    const res = await request(app()).get('/api/v1/users?q=mollel').set(authed(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    const grace = res.body.data.items[0];
    expect(grace.fullName).toBe('Grace Mollel');
    expect(grace.assignments.map((a) => a.code).sort()).toEqual(['head_pc', 'staff']);
    expect(grace.mfa.required).toBe(true);
  });

  it('[ESS] refuses users list to a non-administrator', async () => {
    const juma = await signIn('LFB0233');
    expect((await request(app()).get('/api/v1/users').set(authed(juma.token))).status).toBe(403);
  });
});

describe('creating a user from a staff record', () => {
  beforeEach(async () => {
    await Staff.create({ staffNo: 'LFB0700', firstName: 'Baraka', lastName: 'Temba', category: 'Non-management', employmentType: 'Permanent', dateJoined: new Date('2025-01-06') });
  });

  it('creates the account with a temporary password and the Staff role', async () => {
    const res = await request(app()).post('/api/v1/users').set(authed(admin.token)).send({ staffNo: 'LFB0700', temporaryPassword: 'Temp#2026x' });
    expect(res.status).toBe(201);
    expect(res.body.data.mustChangePassword).toBe(true);
    expect(res.body.data.assignments.map((a) => a.code)).toEqual(['staff']);
    const first = await login('LFB0700', 'Temp#2026x');
    expect(first.body.data.user.mustChangePassword).toBe(true);
  });

  it('refuses an unknown staff number and a duplicate account', async () => {
    expect((await request(app()).post('/api/v1/users').set(authed(admin.token)).send({ staffNo: 'LFB0701', temporaryPassword: 'Temp#2026x' })).status).toBe(400);
    expect((await request(app()).post('/api/v1/users').set(authed(admin.token)).send({ staffNo: 'LFB0412', temporaryPassword: 'Temp#2026x' })).status).toBe(409);
  });

  it('refuses a temporary password that breaks the policy', async () => {
    const res = await request(app()).post('/api/v1/users').set(authed(admin.token)).send({ staffNo: 'LFB0700', temporaryPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });
});

describe('administrator actions', () => {
  it('unlocks a locked account and audits it (prompt 3a.2)', async () => {
    for (let i = 0; i < 5; i += 1) await login('LFB0412', 'wrong-pass'); // eslint-disable-line no-await-in-loop
    const id = await idOf('LFB0412');
    const res = await request(app()).post(`/api/v1/users/${id}/unlock`).set(authed(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    const entry = await AuditLog.findOne({ action: 'user.unlock' });
    expect(entry.actorStaffNo).toBe('LFB0274');
    expect(entry.before).toMatchObject({ status: 'locked', failedAttempts: 5 });
    expect((await login('LFB0412')).status).toBe(200);
  });

  it('resets MFA so the user enrols again, and ends their sessions', async () => {
    const juma = await signIn('LFB0233');
    const res = await request(app()).post(`/api/v1/users/${await idOf('LFB0233')}/reset-mfa`).set(authed(admin.token));
    expect(res.body.data.mfa.enabled).toBe(false);
    expect((await request(app()).get('/api/v1/auth/me').set(authed(juma.token))).status).toBe(401);
    expect((await login('LFB0233')).body.data.enrolRequired).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'user.mfa_reset' })).toBe(1);
  });

  it('issues a temporary password', async () => {
    await request(app()).post(`/api/v1/users/${await idOf('LFB0412')}/reset-password`).set(authed(admin.token)).send({ temporaryPassword: 'Reset#2026' });
    const res = await login('LFB0412', 'Reset#2026');
    expect(res.body.data.user.mustChangePassword).toBe(true);
  });

  it('deactivates and reactivates; a deactivated user is signed out at once', async () => {
    const neema = await signIn('LFB0412');
    const id = await idOf('LFB0412');
    await request(app()).post(`/api/v1/users/${id}/deactivate`).set(authed(admin.token));
    expect((await request(app()).get('/api/v1/auth/me').set(authed(neema.token))).status).toBe(401);
    expect((await login('LFB0412')).status).toBe(403);
    await request(app()).post(`/api/v1/users/${id}/activate`).set(authed(admin.token));
    expect((await login('LFB0412')).status).toBe(200);
  });

  it('an administrator cannot deactivate or reset MFA on their own account', async () => {
    const me = await idOf('LFB0274');
    expect((await request(app()).post(`/api/v1/users/${me}/deactivate`).set(authed(admin.token))).status).toBe(403);
    expect((await request(app()).post(`/api/v1/users/${me}/reset-mfa`).set(authed(admin.token))).status).toBe(403);
  });
});

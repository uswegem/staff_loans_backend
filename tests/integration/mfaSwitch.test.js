'use strict';

// D-103: MFA_ENABLED=false turns MFA off for every user (internal-only deployment, risk
// accepted). Privileged users sign in with a password alone and are never stepped up.
// The default (MFA on) is covered by auth.test.js and mfaStepUp.test.js.

const env = require('../../src/config/env');
const { app, authed, request } = require('../helpers');
const { seedAll, applyAndSign, decide, signIn, CRB } = require('../flows');
const User = require('../../src/models/User');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');

const login = (userName, password = require('../helpers').PASSWORD) => request(app()).post('/api/v1/auth/login').send({ userName, password });

beforeAll(() => {
  process.env.MFA_ENABLED = 'false';
  env.reset();
});

afterAll(() => {
  process.env.MFA_ENABLED = 'true';
  env.reset();
});

jest.setTimeout(120000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

describe('MFA switched off (D-103)', () => {
  it('a reviewer signs in with the password alone', async () => {
    const res = await login('lfb0233');
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.mfaRequired).toBeFalsy();
    expect(res.body.data.enrolRequired).toBeUndefined();
  });

  it('a role granted mid-session is usable without a one-time code', async () => {
    const { token } = await signIn('LFB0412');
    const user = await User.findOne({ staffNo: 'LFB0412' });
    const role = await Role.findOne({ code: 'sys_admin' });
    await RoleAssignment.create({ userId: user._id, roleId: role._id, assignedBy: user._id });

    const res = await request(app()).get('/api/v1/users').set(authed(token));
    expect(res.status).toBe(200);
  });

  it('a reviewer records a decision on a session opened without a one-time code', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' });
    const juma = await signIn('LFB0233');
    const res = await decide(juma, id, { action: 'approve', crb: CRB, comment: 'Affordable, bureau clear.' });
    expect(res.status).toBe(200);
  });

  it('the profile reports MFA as not required', async () => {
    const { token } = await signIn('LFB0233');
    const me = await request(app()).get('/api/v1/auth/me').set(authed(token));
    expect(me.body.data.mfaRequired).toBe(false);
  });
});

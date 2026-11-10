'use strict';

// NFR-04: sign-out after 10 minutes without user activity, enforced by the server too.
// Only requests the user made count; polling (X-SLAS-Background) and token refresh do not.

const { app, seed, signIn, cookieHeader, authed, request } = require('../helpers');
const Session = require('../../src/models/Session');
const Settings = require('../../src/models/Settings');

const MIN = 60 * 1000;
beforeEach(async () => {
  await seed();
});

const lastActivity = async () => (await Session.findOne({ revokedAt: null }).sort({ _id: -1 })).lastActivityAt.getTime();
const idleFor = (ms) => Session.updateMany({}, { $set: { lastActivityAt: new Date(Date.now() - ms) } });
const refresh = (cookies) => request(app()).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(cookies)).set('X-XSRF-TOKEN', cookies['XSRF-TOKEN'].value);
const me = (token, background) => {
  const r = request(app()).get('/api/v1/auth/me').set(authed(token));
  return background ? r.set('X-SLAS-Background', '1') : r;
};

describe('server-side inactivity limit', () => {
  it('is 10 minutes by default and is sent to the browser', async () => {
    expect((await Settings.get()).inactivityTimeoutMin).toBe(10);
    const { body } = await signIn('LFB0412');
    expect(body.data.session.inactivityTimeoutMin).toBe(10);
  });

  it('a request the user made counts as activity', async () => {
    const { token } = await signIn('LFB0412');
    await idleFor(5 * MIN);
    expect((await me(token)).status).toBe(200);
    expect(Date.now() - (await lastActivity())).toBeLessThan(5000);
  });

  it('background requests (polling) do not count as activity', async () => {
    const { token } = await signIn('LFB0412');
    await idleFor(5 * MIN);
    const before = await lastActivity();
    expect((await me(token, true)).status).toBe(200);
    expect(await lastActivity()).toBe(before);
  });

  it('polling cannot keep a session alive past the limit', async () => {
    const { token } = await signIn('LFB0412');
    await idleFor(9 * MIN);
    expect((await me(token, true)).status).toBe(200);
    await idleFor(10 * MIN + 5000);
    const res = await me(token, true);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_IDLE');
  });

  it('a token refresh does not extend the session, and is refused after the limit', async () => {
    const { cookies } = await signIn('LFB0412');
    await idleFor(5 * MIN);
    const before = await lastActivity();
    const r = await refresh(cookies);
    expect(r.status).toBe(200);
    expect(await lastActivity()).toBe(before);

    const { cookies: other } = await signIn('LFB0412');
    await idleFor(10 * MIN + 5000);
    const late = await refresh(other);
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('SESSION_IDLE');
  });

  it('an expired session stays closed: a later request with the same token is refused', async () => {
    const { token } = await signIn('LFB0412');
    await idleFor(10 * MIN + 5000);
    expect((await me(token)).body.code).toBe('SESSION_IDLE');
    await Session.updateMany({}, { $set: { lastActivityAt: new Date() } }); // even if activity were faked afterwards
    const again = await me(token);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('SESSION_ENDED');
  });

  it('follows the configured limit when an administrator changes it', async () => {
    await Settings.updateOne({}, { $set: { inactivityTimeoutMin: 20 } });
    const { token } = await signIn('LFB0412');
    await idleFor(15 * MIN);
    expect((await me(token)).status).toBe(200);
  });
});

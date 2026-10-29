'use strict';

// Audit log is append-only (NFR-05); workflow settings and holidays are audited (7.3).

const { app, seed, signIn, authed, request } = require('../helpers');
const AuditLog = require('../../src/models/AuditLog');
const audit = require('../../src/services/audit/auditService');

beforeEach(async () => {
  await seed();
});

describe('append-only audit log', () => {
  beforeEach(async () => {
    await audit.record({ action: 'test.entry', description: 'An entry' });
  });

  it.each([
    ['updateOne', () => AuditLog.updateOne({}, { $set: { description: 'changed' } })],
    ['updateMany', () => AuditLog.updateMany({}, { $set: { description: 'changed' } })],
    ['findOneAndUpdate', () => AuditLog.findOneAndUpdate({}, { $set: { description: 'changed' } })],
    ['replaceOne', () => AuditLog.replaceOne({}, { action: 'x.y', description: 'x' })],
    ['deleteOne', () => AuditLog.deleteOne({})],
    ['deleteMany', () => AuditLog.deleteMany({})],
    ['findOneAndDelete', () => AuditLog.findOneAndDelete({})],
  ])('refuses %s', async (_, op) => {
    await expect(op()).rejects.toMatchObject({ code: 'APPEND_ONLY' });
    expect(await AuditLog.countDocuments({ description: 'An entry' })).toBe(1);
  });

  it('refuses saving a changed document', async () => {
    const doc = await AuditLog.findOne();
    doc.description = 'changed';
    await expect(doc.save()).rejects.toMatchObject({ code: 'APPEND_ONLY' });
  });

  it('has no write route', async () => {
    const admin = await signIn('LFB0274');
    for (const method of ['post', 'put', 'patch', 'delete']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app())[method]('/api/v1/audit').set(authed(admin.token)).send({});
      expect(res.status).toBe(404);
    }
  });

  it('is readable with audit.view and filterable', async () => {
    const daniel = await signIn('LFB0067');
    const res = await request(app()).get('/api/v1/audit?action=auth').set(authed(daniel.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items.every((e) => e.action.startsWith('auth'))).toBe(true);
  });
});

describe('workflow settings and calendar', () => {
  it('seeds the prototype targets and holidays', async () => {
    const admin = await signIn('LFB0274');
    const res = await request(app()).get('/api/v1/admin/settings').set(authed(admin.token));
    expect(res.body.data.settings).toMatchObject({ stageTargetHours: 8, ceoTargetHours: 48, workingDays: [1, 2, 3, 4, 5], dayStartMinutes: 480, dayEndMinutes: 1020, approvalSlaDays: 30, probationMonths: 6 });
    expect(res.body.data.holidays.map((h) => h.date)).toContain('2026-12-25');
  });

  it('changes are audited with before and after values', async () => {
    const admin = await signIn('LFB0274');
    await request(app()).put('/api/v1/admin/settings').set(authed(admin.token)).send({ stageTargetHours: 6 });
    const entry = await AuditLog.findOne({ action: 'settings.update' });
    expect(entry.before.stageTargetHours).toBe(8);
    expect(entry.after.stageTargetHours).toBe(6);
  });

  it('refuses a working day that ends before it starts', async () => {
    const admin = await signIn('LFB0274');
    const res = await request(app()).put('/api/v1/admin/settings').set(authed(admin.token)).send({ dayStartMinutes: 600, dayEndMinutes: 540 });
    expect(res.status).toBe(400);
  });

  it('adds and removes holidays', async () => {
    const admin = await signIn('LFB0274');
    const add = await request(app()).post('/api/v1/admin/holidays').set(authed(admin.token)).send({ date: '2027-04-26', name: 'Union Day' });
    expect(add.status).toBe(201);
    const del = await request(app()).delete(`/api/v1/admin/holidays/${add.body.data.id}`).set(authed(admin.token));
    expect(del.status).toBe(200);
  });

  it('only admin.workflow holders can change settings', async () => {
    const grace = await signIn('LFB0051');
    expect((await request(app()).put('/api/v1/admin/settings').set(authed(grace.token)).send({ stageTargetHours: 6 })).status).toBe(403);
  });
});

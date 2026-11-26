'use strict';

// scripts/upgrade-2026-12b.js (D-112): a dry run lists and changes nothing; --apply moves
// loans in Pending Booking to Pending Disbursement (keeping stageEnteredAt, audited), gives
// disb.confirm to the two People and Culture roles and takes loan.book off every role.
// Running it again changes nothing.

const { seedAll, runningLoan } = require('../flows');
const { run } = require('../../scripts/upgrade-2026-12b');
const Application = require('../../src/models/Application');
const AuditLog = require('../../src/models/AuditLog');
const Role = require('../../src/models/Role');

jest.setTimeout(120000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

/** A database as D-107 left it: one loan waiting to be booked, booking roles. */
async function before() {
  const waiting = await runningLoan('LFB0412', products.PL._id, 100000, 'pending_disbursement');
  const entered = new Date('2026-11-20T08:00:00Z');
  await Application.collection.updateOne({ _id: waiting._id }, { $set: { status: 'pending_booking', stageEnteredAt: entered } });
  const ready = await runningLoan('LFB0233', products.PL._id, 100000, 'pending_disbursement');
  const roles = Role.collection;
  await roles.updateMany({ code: { $in: ['pc_manager', 'head_pc'] } }, { $pull: { permissions: 'disb.confirm' } });
  await roles.updateMany({ code: { $in: ['pc_manager', 'head_pc'] } }, { $addToSet: { permissions: 'loan.book' } });
  await roles.updateOne({ code: 'ops' }, { $addToSet: { permissions: 'loan.book' } });
  return { waiting, ready, entered };
}

describe('upgrade 2026-12b (D-112)', () => {
  it('a dry run lists what would change and changes nothing', async () => {
    const { waiting } = await before();
    const r = await run();
    expect(r).toMatchObject({ apply: false, moved: [waiting.ref], rolesGiven: expect.arrayContaining(['pc_manager', 'head_pc']) });
    expect(r.loanBookRemoved.sort()).toEqual(['head_pc', 'ops', 'pc_manager']);
    expect((await Application.collection.findOne({ _id: waiting._id })).status).toBe('pending_booking');
    expect((await Role.collection.findOne({ code: 'head_pc' })).permissions).toContain('loan.book');
    expect(await AuditLog.countDocuments({ action: 'application.status_migrated' })).toBe(0);
  });

  it('--apply moves the loans, keeps the waiting time, fixes the roles and audits; a second run changes nothing', async () => {
    const { waiting, ready, entered } = await before();
    await run({ apply: true });
    const a = await Application.collection.findOne({ _id: waiting._id });
    expect(a.status).toBe('pending_disbursement');
    expect(a.stageEnteredAt).toEqual(entered);
    expect((await Application.findById(ready._id)).status).toBe('pending_disbursement');
    const log = await AuditLog.findOne({ action: 'application.status_migrated', entityId: String(waiting._id) }).lean();
    expect(log).toMatchObject({ appRef: waiting.ref, before: { status: 'pending_booking' }, after: { status: 'pending_disbursement' } });
    expect(log.description).toMatch(/booking step removed, D-112/);
    for (const code of ['pc_manager', 'head_pc', 'ops']) {
      // eslint-disable-next-line no-await-in-loop
      const role = await Role.collection.findOne({ code });
      expect(role.permissions).toContain('disb.confirm');
      expect(role.permissions).not.toContain('loan.book');
    }
    expect(await AuditLog.countDocuments({ action: 'role.update', description: /D-112/ })).toBe(3);

    const again = await run({ apply: true });
    expect(again).toMatchObject({ moved: [], rolesGiven: [], loanBookRemoved: [] });
    expect(await AuditLog.countDocuments({ action: 'application.status_migrated' })).toBe(1);
  });
});

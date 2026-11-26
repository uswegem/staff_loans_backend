'use strict';

// scripts/upgrade-2026-12.js: dry run changes nothing; the run moves crb.fileId into
// crb.fileIds, gives loan.book to the two P&C roles, sends approved loans not yet booked to
// Pending Booking (D-107), loads the data protection notice and codes old notifications.

const mongoose = require('mongoose');
const { seedAll, runningLoan } = require('../flows');
const { run } = require('../../scripts/upgrade-2026-12');
const Application = require('../../src/models/Application');
const LegalNotice = require('../../src/models/LegalNotice');
const Notification = require('../../src/models/Notification');
const Role = require('../../src/models/Role');
const User = require('../../src/models/User');
const Settings = require('../../src/models/Settings');

jest.setTimeout(120000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

async function before() {
  const waiting = await runningLoan('LFB0412', products.PL._id, 100000, 'pending_disbursement');
  const paid = await runningLoan('LFB0233', products.PL._id, 100000, 'disbursed');
  const fileId = new mongoose.Types.ObjectId();
  await Application.collection.updateOne({ _id: waiting._id }, { $set: { 'crb.fileId': fileId } });
  await Role.updateMany({ code: { $in: ['pc_manager', 'head_pc'] } }, { $pull: { permissions: 'loan.book' } });
  await LegalNotice.deleteMany({});
  const user = await User.findOne({ staffNo: 'LFB0412' });
  await Settings.get();
  await Settings.collection.updateOne({ _id: 'global' }, { $set: { payslipMaxAgeDays: 45 } });
  await Notification.collection.insertOne({ userId: user._id, type: 'application.moved', text: 'SL-2026-00007 moved to CEO review.', createdAt: new Date() });
  return { waiting, paid, fileId };
}

describe('upgrade 2026-12', () => {
  it('--dry-run reports and changes nothing', async () => {
    const { waiting } = await before();
    const r = await run({ dryRun: true });
    expect(r).toMatchObject({ crbFiles: 1, roles: expect.arrayContaining(['pc_manager', 'head_pc']), toBooking: [waiting.ref], notices: ['DP-2026-1 (en)', 'DP-2026-1 (sw)'], notificationsCoded: 1, payslipMaxAgeFrom: 45 });
    expect((await Settings.collection.findOne({ _id: 'global' })).payslipMaxAgeDays).toBe(45);
    expect((await Application.findById(waiting._id)).status).toBe('pending_disbursement');
    expect(await LegalNotice.countDocuments()).toBe(0);
    expect((await Role.findOne({ code: 'head_pc' })).permissions).not.toContain('loan.book');
  });

  it('applies every change once; running again changes nothing more', async () => {
    const { waiting, paid, fileId } = await before();
    await run();
    const a = await Application.findById(waiting._id).lean();
    expect(a.status).toBe('pending_booking');
    expect(a.crb.fileIds.map(String)).toEqual([String(fileId)]);
    expect((await Application.findById(paid._id)).status).toBe('disbursed');
    for (const code of ['pc_manager', 'head_pc']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await Role.findOne({ code })).permissions).toContain('loan.book');
    }
    expect(await LegalNotice.countDocuments({ status: 'approved' })).toBe(2);
    expect(await Notification.findOne({ text: 'SL-2026-00007 moved to CEO review.' }).lean()).toMatchObject({ code: 'MOVED_TO_REVIEW', params: { a: 'SL-2026-00007', b: 'CEO' } });

    expect((await Settings.collection.findOne({ _id: 'global' })).payslipMaxAgeDays).toBe(30);
    const again = await run();
    expect(again).toMatchObject({ crbFiles: 0, roles: [], toBooking: [], notices: [], notificationsCoded: 0, payslipMaxAgeFrom: null });
  });
});

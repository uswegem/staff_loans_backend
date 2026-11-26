'use strict';

// scripts/upgrade-2026-12.js: dry run changes nothing; the run moves crb.fileId into
// crb.fileIds, loads the data protection notice, codes old notifications and lowers the
// payslip age limit. It no longer touches roles or loan statuses (the booking step of D-107
// was dropped by D-112; see upgrade202612b.test.js).

const mongoose = require('mongoose');
const { seedAll, runningLoan } = require('../flows');
const { run } = require('../../scripts/upgrade-2026-12');
const Application = require('../../src/models/Application');
const LegalNotice = require('../../src/models/LegalNotice');
const Notification = require('../../src/models/Notification');
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
    expect(r).toMatchObject({ crbFiles: 1, notices: ['DP-2026-1 (en)', 'DP-2026-1 (sw)'], notificationsCoded: 1, payslipMaxAgeFrom: 45 });
    expect((await Settings.collection.findOne({ _id: 'global' })).payslipMaxAgeDays).toBe(45);
    expect((await Application.findById(waiting._id)).status).toBe('pending_disbursement');
    expect(await LegalNotice.countDocuments()).toBe(0);
  });

  it('applies every change once; running again changes nothing more', async () => {
    const { waiting, paid, fileId } = await before();
    await run();
    const a = await Application.findById(waiting._id).lean();
    expect(a.status).toBe('pending_disbursement'); // D-112: not sent to booking
    expect(a.crb.fileIds.map(String)).toEqual([String(fileId)]);
    expect((await Application.findById(paid._id)).status).toBe('disbursed');
    expect(await LegalNotice.countDocuments({ status: 'approved' })).toBe(2);
    expect(await Notification.findOne({ text: 'SL-2026-00007 moved to CEO review.' }).lean()).toMatchObject({ code: 'MOVED_TO_REVIEW', params: { a: 'SL-2026-00007', b: 'CEO' } });

    expect((await Settings.collection.findOne({ _id: 'global' })).payslipMaxAgeDays).toBe(30);
    const again = await run();
    expect(again).toMatchObject({ crbFiles: 0, notices: [], notificationsCoded: 0, payslipMaxAgeFrom: null });
  });
});

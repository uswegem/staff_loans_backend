'use strict';

// D-115: data is kept for ten years after the loan ends; then its files are deleted and its
// records anonymised, unless it is on legal hold. Open applications are never purged.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { api, seedAll, applyAndSign, signIn } = require('../flows');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const AuditLog = require('../../src/models/AuditLog');
const Decision = require('../../src/models/Decision');
const Notification = require('../../src/models/Notification');
const StoredFile = require('../../src/models/StoredFile');
const User = require('../../src/models/User');
const retention = require('../../src/services/retention/retentionService');
const { config } = require('../../src/config/env');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(180000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const yearsAgo = (y, extraDays = 0) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - y);
  return new Date(d.getTime() - extraDays * 24 * 3600 * 1000);
};
const userId = async (staffNo) => (await User.findOne({ staffNo }))._id;

/** A submitted application by staffNo, then set to the given state directly. */
async function loan(staffNo, set) {
  const id = await applyAndSign(await signIn(staffNo), products.PL._id, TERMS);
  await Application.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: set });
  return Application.findById(id).lean();
}

describe('data retention (D-115)', () => {
  it('ten years, never fewer; when each loan ends', () => {
    expect(retention.years()).toBe(10);
    expect(retention.endOf({ status: 'rejected', closedAt: new Date('2026-01-05') })).toEqual(new Date('2026-01-05'));
    expect(retention.endOf({ status: 'disbursed', schedule: [{ due: '2027-01-25' }, { due: '2029-12-25' }] }).toISOString().slice(0, 10)).toBe('2029-12-24'); // local midnight, East Africa
    expect(retention.endOf({ status: 'disbursed', schedule: [{ due: '2029-12-25' }], settledByTopUp: { at: new Date('2027-06-01') } })).toEqual(new Date('2027-06-01'));
    for (const status of ['draft', 'pending_credit', 'returned', 'pending_disbursement', 'pending_reaccept']) expect(retention.endOf({ status })).toBeNull();
  });

  it('purges what is past ten years: files deleted, records anonymised, audited; the rest is kept', async () => {
    const old = await loan('LFB0412', { status: 'rejected', closedAt: yearsAgo(10, 1), closedReason: 'Adverse bureau record for Neema Mushi.', 'repayment.accountNo': '0150123456' });
    const paid = await loan('LFB0233', { status: 'disbursed', schedule: [{ due: localDay(yearsAgo(10, 3)) }], 'disbursement.comment': 'Paid to Juma.' });
    const recent = await loan('LFB0129', { status: 'rejected', closedAt: yearsAgo(9) });
    const held = await loan('LFB0188', { status: 'withdrawn', closedAt: yearsAgo(12), legalHold: { on: true, reason: 'Audit query 2036/14' } });
    const open = await loan('LFB0067', { status: 'pending_credit', submittedAt: yearsAgo(12) });
    await Decision.create({ applicationId: old._id, cycle: 1, stage: 'pc', action: 'reject', actorId: await userId('LFB0051'), comment: 'Neema has arrears elsewhere.', at: new Date() });
    await Notification.create({ userId: await userId('LFB0412'), type: 'application.rejected', text: `${old.ref} was rejected: Neema …`, entity: 'Application', entityId: String(old._id) });
    const oldFiles = await StoredFile.find({ applicationId: old._id }).lean();
    expect(oldFiles.length).toBeGreaterThan(0);

    const dry = await retention.run();
    expect(dry.due.map((d) => d.ref).sort()).toEqual([old.ref, paid.ref].sort());
    expect(fs.existsSync(path.join(config.uploadDir, oldFiles[0].storageKey))).toBe(true);

    const r = await retention.run({ apply: true });
    expect(r.purged.map((p) => p.ref).sort()).toEqual([old.ref, paid.ref].sort());

    // Files: gone from disk; their records stay, marked, without the name.
    for (const f of oldFiles) expect(fs.existsSync(path.join(config.uploadDir, f.storageKey))).toBe(false);
    expect(await StoredFile.countDocuments({ applicationId: old._id, purgedAt: { $ne: null }, originalName: retention.PURGED_NAME })).toBe(oldFiles.length);

    // The application: statistics kept, personal data and the link to the person removed.
    const a = await Application.findById(old._id).lean();
    expect(a).toMatchObject({ ref: old.ref, status: 'rejected', amount: 4500000, tenor: 36, retention: { department: 'Branch Network', category: 'Non-management' } });
    expect(a.purgedAt).toBeTruthy();
    for (const k of ['applicantUserId', 'applicantStaffId', 'purpose', 'payslip', 'calcSnapshot', 'applicantSnapshot', 'closedReason']) expect(a[k]).toBeUndefined();
    expect(a.repayment?.accountNo).toBeUndefined();
    expect((await Application.findById(paid._id).lean()).disbursement.comment).toBeUndefined();

    // Agreements, decisions and notifications.
    const ag = await Agreement.findOne({ applicationId: old._id }).lean();
    expect(ag.text).toBe(retention.PURGED_NAME);
    expect(ag.acceptance.fullName).toBeUndefined();
    expect(ag.number).toMatch(/^MKT-/);
    expect((await Decision.findOne({ applicationId: old._id, action: 'reject' }).lean()).comment).toBeNull();
    expect(await Notification.countDocuments({ entityId: String(old._id) })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'retention.purge', appRef: old.ref, description: /by the retention job/ })).toBe(1);

    // Kept: within ten years, on hold, still open.
    for (const kept of [recent, held, open]) expect((await Application.findById(kept._id).lean()).purgedAt).toBeUndefined();

    // Nothing is shown about a purged application; reports keep it, anonymised.
    const grace = await signIn('LFB0051');
    expect((await api(grace.token).get(`/review/${old._id}`)).status).toBe(404);
    const rep = await api(grace.token).get('/reports/register');
    const report = rep.body.data;
    const row = report.rows.find((x) => x[0] === old.ref);
    expect(row).toEqual(expect.arrayContaining(['Anonymised', 'Branch Network']));

    // A second run changes nothing.
    expect((await retention.run({ apply: true })).purged).toEqual([]);
  });

  it('a legal hold needs a reason, stops the purge until released, and is audited', async () => {
    const app = await loan('LFB0412', { status: 'rejected', closedAt: yearsAgo(11) });
    const by = await User.findOne({ staffNo: 'LFB0274' });
    await expect(retention.hold(app.ref, { on: true, reason: ' ', by })).rejects.toThrow(/reason/);
    await retention.hold(app.ref, { on: true, reason: 'Court case 12/2037', by });
    expect((await retention.run({ apply: true })).purged).toEqual([]);
    await retention.hold(app.ref, { on: false, by });
    expect((await retention.run({ apply: true, by })).purged.map((p) => p.ref)).toEqual([app.ref]);
    expect(await AuditLog.countDocuments({ action: { $in: ['retention.hold', 'retention.release'] }, appRef: app.ref })).toBe(2);
    await expect(retention.hold(app.ref, { on: true, reason: 'Late', by })).rejects.toThrow(/already purged/);
  });

  it('staff uploads older than ten years are deleted', async () => {
    const { db } = mongoose.connection;
    await db.collection('staffimports').insertMany([{ fileName: 'old.xlsx', status: 'committed', rows: [], createdAt: yearsAgo(10, 2) }, { fileName: 'new.xlsx', status: 'committed', rows: [], createdAt: new Date() }]);
    expect((await retention.run()).staffUploadsDue).toBe(1);
    expect((await retention.run({ apply: true })).staffUploadsDeleted).toBe(1);
    expect(await db.collection('staffimports').countDocuments({ fileName: 'old.xlsx' })).toBe(0);
    expect(await db.collection('staffimports').countDocuments({ fileName: 'new.xlsx' })).toBe(1);
  });
});

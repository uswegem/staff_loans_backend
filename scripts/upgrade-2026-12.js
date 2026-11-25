'use strict';

/* eslint-disable no-console */
// Upgrades an existing database to the December 2026 release. Safe to run again.
// Run it once the API is deployed, before the web app. --dry-run reports what would
// change and changes nothing.
//
//  1. Bureau reports (D-105): crb.fileId becomes the list crb.fileIds (the old field stays).
//  2. Booking (D-107): the People and Culture Manager and Head of People and Culture system
//     roles get loan.book. Finally approved loans not yet booked (Pending Disbursement
//     without a booking) go to Pending Booking, so People and Culture book them before OPS
//     disburses. Disbursed loans are not changed.
//  3. Data protection (D-108): the approved notice DP-2026-1 in English and Swahili.
//  4. Notifications (D-109): existing notifications get their message code and params,
//     so they are shown in the reader's language.
//
// Usage: npm run upgrade:2026-12 [-- --dry-run]

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const { seedLegalNotices } = require('../seed/legalNotices');
const { identify } = require('../src/i18n');

const BOOKERS = ['pc_manager', 'head_pc'];

async function run({ dryRun = false } = {}) {
  const { db } = mongoose.connection;
  const apps = db.collection('applications');
  const out = {};

  // 1. crb.fileId -> crb.fileIds
  const single = { 'crb.fileId': { $ne: null }, $or: [{ 'crb.fileIds': { $exists: false } }, { 'crb.fileIds': { $size: 0 } }] };
  out.crbFiles = await apps.countDocuments(single);
  if (!dryRun && out.crbFiles) await apps.updateMany(single, [{ $set: { 'crb.fileIds': ['$crb.fileId'] } }]);

  // 2. loan.book on the two system roles; approved loans not yet booked go to booking.
  const roles = db.collection('roles');
  const needRole = { code: { $in: BOOKERS }, permissions: { $ne: 'loan.book' } };
  out.roles = (await roles.find(needRole).project({ code: 1 }).toArray()).map((r) => r.code);
  if (!dryRun && out.roles.length) await roles.updateMany(needRole, { $addToSet: { permissions: 'loan.book' } });
  const unbooked = { status: 'pending_disbursement', 'booking.loanAccountNumber': { $in: [null, ''] } };
  out.toBooking = (await apps.find(unbooked).project({ ref: 1 }).toArray()).map((a) => a.ref);
  if (!dryRun && out.toBooking.length) await apps.updateMany(unbooked, { $set: { status: 'pending_booking' } });

  // 3. The data protection notice.
  out.notices = await seedLegalNotices({ dryRun });

  // 4. Codes for notifications kept as English text only.
  const notes = db.collection('notifications');
  const uncoded = await notes.find({ code: { $in: [null, ''] } }).project({ text: 1 }).toArray();
  const ops = [];
  out.unmatchedNotifications = 0;
  for (const n of uncoded) {
    const id = identify(n.text);
    if (!id) out.unmatchedNotifications += 1;
    else ops.push({ updateOne: { filter: { _id: n._id }, update: { $set: { code: id.code, params: id.params } } } });
  }
  out.notificationsCoded = ops.length;
  if (!dryRun && ops.length) await notes.bulkWrite(ops, { ordered: false });
  return out;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  connect(config.mongoUri)
    .then(() => run({ dryRun }))
    .then((r) => {
      const verb = dryRun ? 'would be' : 'were';
      console.log(dryRun ? 'DRY RUN: nothing is changed.' : 'Upgrade applied.');
      console.log(`Bureau reports: ${r.crbFiles} applications ${verb} moved to the file list.`);
      console.log(`Roles given loan.book: ${r.roles.join(', ') || 'none (already there)'}.`);
      console.log(`Approved loans ${verb} sent to Pending Booking: ${r.toBooking.length}${r.toBooking.length ? ` (${r.toBooking.join(', ')})` : ''}.`);
      console.log(`Data protection notice versions ${verb} loaded: ${r.notices.join(', ') || 'none (already there)'}.`);
      console.log(`Notifications ${verb} given a message code: ${r.notificationsCoded}; left as text (shown as stored): ${r.unmatchedNotifications}.`);
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run };

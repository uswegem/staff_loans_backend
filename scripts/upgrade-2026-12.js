'use strict';

/* eslint-disable no-console */
// Upgrades an existing database to the December 2026 release. Safe to run again.
// Run it once the API is deployed, before the web app. --dry-run reports what would
// change and changes nothing.
//
//  1. Bureau reports (D-105): crb.fileId becomes the list crb.fileIds (the old field stays).
//  2. (Removed by D-112: the booking step of D-107 is not part of the release. A database
//     that already ran the earlier version of this step is put right by upgrade-2026-12b.)
//  3. Data protection (D-108): the approved notice DP-2026-1 in English and Swahili.
//  4. Notifications (D-109): existing notifications get their message code and params,
//     so they are shown in the reader's language.
//  5. Payslip age (D-111): a payslip may be at most 30 days old; a longer limit in the
//     settings (the earlier default was 45 days) is lowered to 30.
//
// Usage: npm run upgrade:2026-12 [-- --dry-run]

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const { seedLegalNotices } = require('../seed/legalNotices');
const { identify } = require('../src/i18n');

async function run({ dryRun = false } = {}) {
  const { db } = mongoose.connection;
  const apps = db.collection('applications');
  const out = {};

  // 1. crb.fileId -> crb.fileIds
  const single = { 'crb.fileId': { $ne: null }, $or: [{ 'crb.fileIds': { $exists: false } }, { 'crb.fileIds': { $size: 0 } }] };
  out.crbFiles = await apps.countDocuments(single);
  if (!dryRun && out.crbFiles) await apps.updateMany(single, [{ $set: { 'crb.fileIds': ['$crb.fileId'] } }]);

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

  // 5. The payslip age limit: at most 30 days.
  const settings = db.collection('settings');
  const longer = { payslipMaxAgeDays: { $gt: 30 } };
  out.payslipMaxAgeFrom = (await settings.findOne(longer))?.payslipMaxAgeDays ?? null;
  if (!dryRun && out.payslipMaxAgeFrom) await settings.updateMany(longer, { $set: { payslipMaxAgeDays: 30 } });
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
      console.log(`Data protection notice versions ${verb} loaded: ${r.notices.join(', ') || 'none (already there)'}.`);
      console.log(`Notifications ${verb} given a message code: ${r.notificationsCoded}; left as text (shown as stored): ${r.unmatchedNotifications}.`);
      console.log(r.payslipMaxAgeFrom ? `Payslip age limit ${verb} lowered from ${r.payslipMaxAgeFrom} to 30 days.` : 'Payslip age limit: already 30 days or less.');
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run };

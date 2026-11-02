'use strict';

// One-off data change for D-85: names become First Name and Surname. Safe to run again.
//
//  - Staff: a middle name is folded into the surname ("Neema Joyce Mushi" keeps
//    firstName "Neema", surname "Joyce Mushi"), and middleName is removed.
//  - Next of kin: the single full name is split; the first word becomes the first name
//    and the rest the surname.
//  Names that cannot be split cleanly (one word, empty, or digits) are kept as they are
//  as far as possible and listed in the log for People and Culture to correct.
//
// Usage: node scripts/split-names.js   (reads MONGODB_URI from .env)

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const AuditLog = require('../src/models/AuditLog');

/** Splits a full name: first word, then the rest. */
function splitName(full) {
  const words = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { firstName: '', lastName: '', clean: false, reason: 'empty name' };
  const [firstName, ...rest] = words;
  const lastName = rest.join(' ');
  if (!lastName) return { firstName, lastName: '', clean: false, reason: 'only one word: no surname' };
  if (/\d/.test(full)) return { firstName, lastName, clean: false, reason: 'contains digits' };
  return { firstName, lastName, clean: true };
}

async function run(db = mongoose.connection.db) {
  const staffCol = db.collection('staffs');
  const report = { staffFolded: 0, kinSplit: 0, unclean: [] };

  for (const s of await staffCol.find({ middleName: { $exists: true } }).toArray()) {
    const lastName = [s.middleName, s.lastName].filter((x) => x && String(x).trim()).join(' ');
    // eslint-disable-next-line no-await-in-loop
    await staffCol.updateOne({ _id: s._id }, { $set: { lastName }, $unset: { middleName: '' } });
    report.staffFolded += 1;
  }
  for (const s of await staffCol.find({ $or: [{ firstName: { $in: [null, ''] } }, { lastName: { $in: [null, ''] } }] }).toArray()) {
    report.unclean.push({ staffNo: s.staffNo, who: 'staff', name: [s.firstName, s.lastName].filter(Boolean).join(' '), reason: 'first name or surname missing' });
  }

  for (const s of await staffCol.find({ 'nextOfKin.name': { $exists: true } }).toArray()) {
    const kin = (s.nextOfKin || []).map((k, i) => {
      if (k.firstName || !k.name) return k;
      const part = splitName(k.name);
      if (!part.clean) report.unclean.push({ staffNo: s.staffNo, who: `next of kin ${i + 1}`, name: k.name, reason: part.reason });
      report.kinSplit += 1;
      const rest = { ...k };
      delete rest.name;
      return { ...rest, firstName: part.firstName, lastName: part.lastName };
    });
    // eslint-disable-next-line no-await-in-loop
    await staffCol.updateOne({ _id: s._id }, { $set: { nextOfKin: kin } });
  }

  if (report.staffFolded || report.kinSplit) {
    await AuditLog.create({ action: 'data.split_names', description: `Names split into first name and surname: ${report.staffFolded} staff, ${report.kinSplit} next of kin; ${report.unclean.length} to check (D-85)`, entity: 'Staff', entityId: 'all', after: { unclean: report.unclean } });
  }
  return report;
}

if (require.main === module) {
  connect(config.mongoUri)
    .then(() => run())
    .then((r) => {
      /* eslint-disable no-console */
      console.log(`Staff middle names folded into surname: ${r.staffFolded}. Next of kin names split: ${r.kinSplit}.`);
      if (r.unclean.length) {
        console.log('Names to check (not split cleanly):');
        r.unclean.forEach((u) => console.log(`  ${u.staffNo} ${u.who}: "${u.name}" (${u.reason})`));
      }
      /* eslint-enable no-console */
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run, splitName };

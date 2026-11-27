'use strict';

/* eslint-disable no-console */
// Data retention (D-115): ten years after a loan ends, its files are deleted and its records
// anonymised. The API runs this every night (RETENTION_PURGE_ENABLED, default true); this
// script shows what is due, runs it by hand, and places or releases a legal hold.
//
//   npm run retention                                   lists what is due now (nothing changes)
//   npm run retention -- --apply --by <username>        purges what is due
//   npm run retention -- --hold SL-2026-00031 --reason "<why>" --by <username>
//   npm run retention -- --release SL-2026-00031 --by <username>
//
// A held application is never purged until it is released. Every purge, hold and release is
// audited (retention.purge, retention.hold, retention.release).

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const User = require('../src/models/User');
const retention = require('../src/services/retention/retentionService');

function argsOf(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { apply: argv.includes('--apply'), by: value('--by'), hold: value('--hold'), release: value('--release'), reason: value('--reason') };
}

async function userOf(who) {
  if (!who) throw new Error('Name who is doing this: --by <username or staff number>.');
  const user = await User.findOne({ $or: [{ userName: String(who).toLowerCase() }, { staffNo: String(who).toUpperCase() }] });
  if (!user) throw new Error(`No user "${who}".`);
  return user;
}

async function main(opts) {
  if (opts.hold || opts.release) {
    const by = await userOf(opts.by);
    const r = await retention.hold(opts.hold || opts.release, { on: !!opts.hold, reason: opts.reason, by });
    console.log(`${r.ref}: legal hold ${r.on ? 'placed' : 'released'}.`);
    return;
  }
  const by = opts.apply ? await userOf(opts.by) : null;
  const r = await retention.run({ apply: opts.apply, by });
  console.log(`Retention period: ${r.years} years after the loan ends.`);
  if (!opts.apply) {
    console.log('DRY RUN: nothing is changed. Add --apply --by <username> to purge.');
    r.due.forEach((x) => console.log(`  ${x.ref}  ${x.status}  ended ${x.endedAt.toISOString().slice(0, 10)}  due ${x.purgeAfter.toISOString().slice(0, 10)}`));
    console.log(`${r.due.length} application(s) due; ${r.staffUploadsDue} staff upload(s) due.`);
    return;
  }
  r.purged.forEach((x) => console.log(`  ${x.ref}  ${x.files} file(s) deleted${x.errors.length ? `; ${x.errors.length} could not be deleted` : ''}`));
  console.log(`${r.purged.length} application(s) purged; ${r.staffUploadsDeleted} staff upload(s) deleted.`);
}

if (require.main === module) {
  connect(config.mongoUri)
    .then(() => main(argsOf(process.argv.slice(2))))
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { argsOf, main };

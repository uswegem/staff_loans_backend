'use strict';

/* eslint-disable no-console */
// Adds staff from the staff table without deleting anything (D-95). Safe to run again:
// the staff number is the key, so staff already on file are left as they are (People
// and Culture maintain them in the app) and nobody is added twice.
//
//   npm run staff:load -- --dry-run      lists who would be added
//   npm run staff:load                   adds them
//
// The table is STAFF_CSV, or seed/data/lfb-staff.csv (not in git; the format is in
// seed/data/lfb-staff.example.csv). New staff get an account with the temporary
// password RESET_TEMP_PASSWORD (change forced at first sign-in), the Staff role, and
// any further role listed for their staff number in scripts/reset-staff-and-products.js.
// Nothing else is filled in: date of birth, NIDA, date joined and the other details are
// left for the staff member and People and Culture.

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const Staff = require('../src/models/Staff');
const Role = require('../src/models/Role');
const passwordPolicy = require('../src/services/auth/passwordPolicy');
const { readStaff, loadStaffRows, describeTarget, ROLES_BY_STAFF_NO, CSV } = require('./reset-staff-and-products');

const REQUIRED = [
  ['firstName', 'First Name'],
  ['lastName', 'Surname'],
  ['staffNo', 'Staff No'],
  ['title', 'Title'],
];

/** opts: { dryRun, file, ownConnection }. Throws, changing nothing, when a row lacks a required value. */
async function run({ dryRun = false, file = CSV, ownConnection = true } = {}) {
  const target = describeTarget();
  console.log(`Environment: NODE_ENV=${target.nodeEnv}; database "${target.db}" on ${target.host}:${target.port}`);
  const rows = readStaff(file);
  const blocked = rows.flatMap((r) => REQUIRED.filter(([k]) => !r[k]).map(([, h]) => `${r.staffNo || '(no staff number)'}: ${h} is empty`));
  if (blocked.length) throw new Error(`Required values are missing, nothing changed:\n  ${blocked.join('\n  ')}`);

  if (ownConnection) await connect(config.mongoUri);
  const onFile = new Set(await Staff.distinct('staffNo', { staffNo: { $in: rows.map((r) => r.staffNo) } }));
  const fresh = rows.filter((r) => !onFile.has(r.staffNo));
  const out = { target, toAdd: fresh.map((r) => `${r.firstName} ${r.lastName} (${r.staffNo}), ${r.title}`), alreadyOnFile: onFile.size, noExtraRole: fresh.filter((r) => !ROLES_BY_STAFF_NO[r.staffNo]).map((r) => `${r.staffNo} ${r.title}`) };
  if (dryRun || !fresh.length) {
    if (ownConnection) await mongoose.disconnect();
    return { ...out, dryRun, loaded: null };
  }
  const password = process.env.RESET_TEMP_PASSWORD;
  if (!password) throw new Error('Set RESET_TEMP_PASSWORD to the temporary password for the new accounts.');
  const problems = passwordPolicy.check(password);
  if (problems.length) throw new Error(`RESET_TEMP_PASSWORD: ${problems.join(' ')}`);

  const roleByCode = Object.fromEntries((await Role.find().lean()).map((r) => [r.code, r]));
  const loaded = await loadStaffRows(fresh, { password, roleByCode, source: 'the staff loader', updateExisting: false });
  if (ownConnection) await mongoose.disconnect();
  return { ...out, dryRun: false, loaded };
}

if (require.main === module) {
  run({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => {
      console.log(`Already on file (left as they are): ${r.alreadyOnFile}`);
      console.log(`${r.dryRun ? 'Would add' : 'Added'}: ${r.toAdd.length}`);
      r.toAdd.forEach((x) => console.log(`  ${x}`));
      if (r.loaded) console.log(`Accounts created: ${r.loaded.usersCreated} (temporary password, change forced at first sign-in)`);
      if (r.noExtraRole.length) console.log(`No role beyond Staff (no matching role for the title): ${r.noExtraRole.join('; ')}`);
    })
    .catch(async (err) => {
      console.error(`Stopped: ${err.message}`);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run };

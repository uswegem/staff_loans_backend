'use strict';

/* eslint-disable no-console */
// Upgrades an existing database to this release. Safe to run again. No migrations exist
// in MongoDB, so data changes are made here:
//
//  1. Names: staff middle names fold into the surname; next-of-kin full names split into
//     first name and surname (D-85). Names that do not split cleanly are listed.
//  2. Agreement templates: versions approved before D-88 ("active"/"retired", with the
//     Legal-approved tick) become "approved".
//  3. Product and pricing changes waiting for approval before D-89 wait for the Head of
//     Credit (stage 1).
//  4. System roles are synced to the catalogue; the retired Product Checker role and its
//     assignments are removed (D-89).
//  5. The date of birth setup (scripts/dob-verification-setup.js).
//  6. Profile formats and the location list (scripts/profile-formats.js, D-93): NIDA with
//     hyphens, phone numbers as +255 and nine digits, nationality from the country list.
//     A number confirmed as entered wrongly: --fix-phone <as stored>=<correct number>.
//
// Usage: npm run upgrade

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const { run: splitNames } = require('./split-names');
const { run: dobSetup } = require('./dob-verification-setup');
const { syncRoles } = require('./reset-staff-and-products');
const { run: profileFormats, phoneFixes } = require('./profile-formats');

async function run() {
  const { db } = mongoose.connection;
  const names = await splitNames(db);
  const templates = await db.collection('agreementtemplates').updateMany({ status: { $in: ['active', 'retired'] } }, [{ $set: { status: 'approved', approvedAt: { $ifNull: ['$approvedAt', '$updatedAt'] } } }]);
  const versions = {};
  for (const name of ['productversions', 'pricingversions']) {
    // eslint-disable-next-line no-await-in-loop
    versions[name] = (await db.collection(name).updateMany({ state: 'pending_approval', stage: { $in: [null] } }, { $set: { stage: 'credit', approvals: [] } })).modifiedCount;
    // eslint-disable-next-line no-await-in-loop
    versions[`${name} rejected→draft`] = (await db.collection(name).updateMany({ state: 'rejected' }, { $set: { state: 'draft' } })).modifiedCount;
  }
  const roles = await syncRoles(db);
  const dob = await dobSetup();
  const formats = await profileFormats(db, { fixes: phoneFixes() });
  return { names, templates: templates.modifiedCount, versions, roles, dob, formats };
}

if (require.main === module) {
  connect(config.mongoUri)
    .then(run)
    .then((r) => {
      console.log(`Names: ${r.names.staffFolded} staff middle names folded, ${r.names.kinSplit} next of kin split.`);
      r.names.unclean.forEach((u) => console.log(`  check ${u.staffNo} ${u.who}: "${u.name}" (${u.reason})`));
      console.log(`Agreement templates marked approved: ${r.templates}.`);
      Object.entries(r.versions).forEach(([k, n]) => console.log(`${k}: ${n}`));
      console.log(`Roles: created ${r.roles.created.join(', ') || 'none'}; updated ${r.roles.updated.join(', ') || 'none'}; removed ${r.roles.removed.join(', ') || 'none'}.`);
      console.log(`Date of birth setup: ${r.dob.pendingOpened} birthdates sent for verification.`);
      const f = r.formats;
      console.log(`Locations: ${f.reference.regions} regions, ${f.reference.districts} districts, ${f.reference.wards} wards${f.reference.loaded ? ' loaded' : ' already there'}.`);
      console.log(`Profile formats: NIDA hyphenated ${f.nida}; phone numbers normalised ${f.phones}; nationality mapped ${f.nationality}; required-field settings updated: ${f.settings ? 'yes' : 'no'}.`);
      f.fixed.forEach((x) => console.log(`  corrected ${x.staffNo} ${x.field}: ${x.from} → ${x.to}`));
      f.invalid.forEach((x) => console.log(`  left for the staff member to correct: ${x.staffNo} ${x.field} "${x.value}"`));
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run };

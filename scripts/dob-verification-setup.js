'use strict';

// One-off deployment step for date of birth verification (D-82). Safe to run again.
//
// 1. Adds staff.verifyDob to the Head of People and Culture and People and Culture
//    Manager system roles (seeded roles are only inserted, never updated).
// 2. For every staff member with a date of birth entered before verification existed
//    (personal.dob) and no verified or pending one, opens a pending change so People and
//    Culture can verify it in the queue. Loans and applications are not touched.
//
// Usage: node scripts/dob-verification-setup.js   (reads MONGODB_URI from .env)

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const Role = require('../src/models/Role');
const Staff = require('../src/models/Staff');
const DobChange = require('../src/models/DobChange');
const AuditLog = require('../src/models/AuditLog');
const { localDay } = require('../src/utils/dates');

async function run() {
  const roles = await Role.updateMany({ code: { $in: ['head_pc', 'pc_manager'] }, permissions: { $ne: 'staff.verifyDob' } }, { $addToSet: { permissions: 'staff.verifyDob' } });

  const legacy = await Staff.find({ 'personal.dob': { $ne: null }, 'dateOfBirth.value': null, 'dateOfBirth.pending.changeId': null }).select('staffNo personal.dob').lean();
  let opened = 0;
  for (const s of legacy) {
    const proposed = localDay(s.personal.dob);
    const now = new Date();
    // eslint-disable-next-line no-await-in-loop
    const change = await DobChange.create({ staffId: s._id, proposed, previous: null, source: 'legacy', submittedBy: null, submittedAt: now });
    // eslint-disable-next-line no-await-in-loop
    await Staff.updateOne({ _id: s._id, 'dateOfBirth.pending.changeId': null }, { $set: { 'dateOfBirth.pending': { changeId: change._id, proposed, submittedAt: now } } });
    // eslint-disable-next-line no-await-in-loop
    await AuditLog.create({ action: 'dob.submit', description: `${s.staffNo}: date of birth ${proposed} from the profile sent for verification (deployment of D-82)`, entity: 'Staff', entityId: String(s._id), after: { proposed, changeId: String(change._id), status: 'pending' } });
    opened += 1;
  }
  return { rolesUpdated: roles.modifiedCount, pendingOpened: opened };
}

if (require.main === module) {
  connect(config.mongoUri)
    .then(run)
    .then((out) => {
      // eslint-disable-next-line no-console
      console.log(`Roles given staff.verifyDob: ${out.rolesUpdated}. Birthdates sent for verification: ${out.pendingOpened}.`);
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run };

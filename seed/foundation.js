'use strict';

// Milestone 1 seed: roles, settings, holidays, staff, salaries and user accounts.
// Idempotent: upserts by role code, staff number and holiday date.

const Role = require('../src/models/Role');
const Staff = require('../src/models/Staff');
const User = require('../src/models/User');
const RoleAssignment = require('../src/models/RoleAssignment');
const Settings = require('../src/models/Settings');
const Holiday = require('../src/models/Holiday');
const local = require('../src/services/auth/localCredentialProvider');
const { DEFAULT_ROLES } = require('../src/constants/systemRoles');
const { PEOPLE, toStaffDoc } = require('./data/people');
const { seedReferenceData } = require('./referenceData');

const HOLIDAYS = [
  { date: '2026-12-09', name: 'Independence Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-12', name: 'Zanzibar Revolution Day' },
];

async function seedRoles() {
  const byCode = {};
  for (const r of DEFAULT_ROLES) {
    // eslint-disable-next-line no-await-in-loop
    byCode[r.code] = await Role.findOneAndUpdate({ code: r.code }, { $setOnInsert: { ...r, active: true } }, { upsert: true, new: true });
  }
  return byCode;
}

/**
 * @param {object} opts
 * @param {string} opts.password  password given to every seeded account
 * @param {boolean} [opts.mustChangePassword=false]
 */
async function seedFoundation({ password, mustChangePassword = false } = {}) {
  if (!password) throw new Error('A seed password is required (SEED_PASSWORD).');
  await Settings.get();
  for (const h of HOLIDAYS) {
    // eslint-disable-next-line no-await-in-loop
    await Holiday.updateOne({ date: h.date }, { $setOnInsert: h }, { upsert: true });
  }
  const roles = await seedRoles();
  await seedReferenceData();
  const hash = await local.hash(password);

  // Bulk upserts keep the seed fast enough to run before every integration test.
  await Staff.bulkWrite(PEOPLE.map((p) => ({ updateOne: { filter: { staffNo: p.staffNo }, update: { $setOnInsert: toStaffDoc(p) }, upsert: true } })));
  await Staff.bulkWrite(PEOPLE.map((p) => ({ updateOne: { filter: { staffNo: p.staffNo }, update: { $set: { userName: p.staffNo.toLowerCase() } } } })));
  const staffByNo = new Map((await Staff.find({ staffNo: { $in: PEOPLE.map((p) => p.staffNo) } }).select('_id staffNo').lean()).map((s) => [s.staffNo, s._id]));

  // No salary records (D-100): each person's pay is on the payslip they attach when applying.

  const existing = new Set(await User.distinct('staffNo', { staffNo: { $in: PEOPLE.map((p) => p.staffNo) } }));
  const fresh = PEOPLE.filter((p) => !existing.has(p.staffNo));
  if (fresh.length) {
    const created = await User.insertMany(fresh.map((p) => ({ staffNo: p.staffNo, userName: p.staffNo.toLowerCase(), staffId: staffByNo.get(p.staffNo), passwordHash: hash, passwordChangedAt: new Date(), mustChangePassword })));
    const idByNo = new Map(created.map((u) => [u.staffNo, u._id]));
    await RoleAssignment.insertMany(fresh.flatMap((p) => p.roles.map((code) => ({ userId: idByNo.get(p.staffNo), roleId: roles[code]._id }))));
  }
  const users = Object.fromEntries((await User.find({ staffNo: { $in: PEOPLE.map((p) => p.staffNo) } })).map((u) => [u.staffNo, u]));
  return { roles, users };
}

/** System data only: settings, holidays, roles and the location list. No people, products or applications. */
async function seedSystem() {
  await Settings.get();
  await seedReferenceData();
  for (const h of HOLIDAYS) {
    // eslint-disable-next-line no-await-in-loop
    await Holiday.updateOne({ date: h.date }, { $setOnInsert: h }, { upsert: true });
  }
  return seedRoles();
}

module.exports = { seedFoundation, seedSystem, seedRoles, HOLIDAYS };

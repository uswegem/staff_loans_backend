'use strict';

// Milestone 1 seed: roles, settings, holidays, staff, salaries and user accounts.
// Idempotent: upserts by role code, staff number and holiday date.

const Role = require('../src/models/Role');
const Staff = require('../src/models/Staff');
const Salary = require('../src/models/Salary');
const User = require('../src/models/User');
const RoleAssignment = require('../src/models/RoleAssignment');
const Settings = require('../src/models/Settings');
const Holiday = require('../src/models/Holiday');
const local = require('../src/services/auth/localCredentialProvider');
const { DEFAULT_ROLES } = require('../src/constants/systemRoles');
const { PEOPLE, toStaffDoc } = require('./data/people');

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
  const hash = await local.hash(password);

  // Bulk upserts keep the seed fast enough to run before every integration test.
  await Staff.bulkWrite(PEOPLE.map((p) => ({ updateOne: { filter: { staffNo: p.staffNo }, update: { $setOnInsert: toStaffDoc(p) }, upsert: true } })));
  const staffByNo = new Map((await Staff.find({ staffNo: { $in: PEOPLE.map((p) => p.staffNo) } }).select('_id staffNo').lean()).map((s) => [s.staffNo, s._id]));

  const withSalary = new Set((await Salary.distinct('staffId', { staffId: { $in: [...staffByNo.values()] } })).map(String));
  const salaries = PEOPLE.filter((p) => !withSalary.has(String(staffByNo.get(p.staffNo)))).map((p) => {
    const allowances = p.pay.allowances || 0;
    return { staffId: staffByNo.get(p.staffNo), basic: p.pay.basic, allowances, commission: 0, gross: p.pay.basic + allowances, effectiveFrom: new Date('2026-01-01T00:00:00+03:00'), source: 'seed' };
  });
  if (salaries.length) await Salary.insertMany(salaries);

  const existing = new Set(await User.distinct('staffNo', { staffNo: { $in: PEOPLE.map((p) => p.staffNo) } }));
  const fresh = PEOPLE.filter((p) => !existing.has(p.staffNo));
  if (fresh.length) {
    const created = await User.insertMany(fresh.map((p) => ({ staffNo: p.staffNo, staffId: staffByNo.get(p.staffNo), passwordHash: hash, passwordChangedAt: new Date(), mustChangePassword })));
    const idByNo = new Map(created.map((u) => [u.staffNo, u._id]));
    await RoleAssignment.insertMany(fresh.flatMap((p) => p.roles.map((code) => ({ userId: idByNo.get(p.staffNo), roleId: roles[code]._id }))));
  }
  const users = Object.fromEntries((await User.find({ staffNo: { $in: PEOPLE.map((p) => p.staffNo) } })).map((u) => [u.staffNo, u]));
  return { roles, users };
}

module.exports = { seedFoundation, HOLIDAYS };

'use strict';

/* eslint-disable no-console */
// Ten fictional TEST staff (seed/data/testStaff.js) for a NON-PRODUCTION system: complete
// records, accounts, roles and salaries, and a matching November 2026 payslip each.
//
//   npm run test-staff -- payslips [dir]       writes the payslip PDFs (default
//                                              tests/fixtures/payslips/test-staff)
//   npm run test-staff -- sheet [dir]          writes the staff sheet (CSV and Excel; default
//                                              seed/data)
//   npm run test-staff -- load --dry-run       shows the target and who would be loaded
//   npm run test-staff -- load                 loads them (RESET_TEMP_PASSWORD needed)
//
// Loading refuses NODE_ENV=production, and refuses to touch a staff number held by
// anyone other than the same test person. It is safe to run again: test records are
// brought back to the dataset, accounts keep their password, roles are not duplicated,
// and the salary is recorded once. New accounts get the temporary password
// RESET_TEMP_PASSWORD, with a change forced at first sign-in.

const fs = require('fs');
const path = require('path');
const calc = require('../src/services/calc/loanCalculator');
const { samplePayslip } = require('../seed/samplePayslip');
const { PRICING } = require('../seed/pricing');
const { TEST_STAFF, TEST_STAFF_PREFIX, PAY_DATE, toStaffDoc, fullName } = require('../seed/data/testStaff');
const { formatNida } = require('../src/services/staff/profileService');

const PAYSLIP_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'payslips', 'test-staff');
const SHEET_DIR = path.join(__dirname, '..', 'seed', 'data');
const SHEET_NAME = 'test-staff';
const WATERMARK = 'SAMPLE - TEST DATA';
const SALARY_FROM = new Date(`${PAY_DATE.slice(0, 7)}-01T00:00:00+03:00`);

/** The payslip PDF for one test person. */
function payslipFor(p, pricing = PRICING) {
  return samplePayslip({
    staff: { fullName: fullName(p), staffNo: p.staffNo, title: p.title, department: p.department },
    basic: p.pay.basic,
    allowances: p.pay.allowances || 0,
    payDate: PAY_DATE,
    lfbLines: p.lfbLines.map((l) => ({ label: l.label, amount: l.amount })),
    pricing,
    watermark: WATERMARK,
  });
}

/** Writes every payslip to dir; returns the file names. */
async function writePayslips(dir = PAYSLIP_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const p of TEST_STAFF) {
    const name = `${p.staffNo}-${p.firstName}-${p.lastName}-${PAY_DATE.slice(0, 7)}.pdf`.toLowerCase();
    // eslint-disable-next-line no-await-in-loop
    fs.writeFileSync(path.join(dir, name), await payslipFor(p));
    files.push(name);
  }
  return files;
}

// The staff sheet's columns, in order, as asked by the business.
const SHEET_COLUMNS = [
  ['SN', (p, i) => i + 1],
  ['Staff Number', (p) => p.staffNo],
  ['Full Name', (p) => fullName(p)],
  ['First Name', (p) => p.firstName],
  ['Middle Name', (p) => p.middleName || ''],
  ['Last Name', (p) => p.lastName],
  ['Gender', (p) => p.gender],
  ['Department', (p) => p.department],
  ['Job Title', (p) => p.title],
  ['Category', (p) => p.category],
  ['Employment Type', (p) => p.employmentType],
  ['Date Joined', (p) => p.dateJoined],
  ['Probation End Date', (p) => p.probationEndDate || ''],
  ['Contract End Date', (p) => p.contractEndDate || ''],
  ['Email', (p, i, doc) => doc.email],
  ['Username', (p) => p.userName],
  ['Marital Status', (p) => p.maritalStatus],
  ['Date of Birth', (p) => p.dob],
  ['NIDA Number', (p, i, doc) => formatNida(doc.personal.nida)],
  ['Nationality', (p, i, doc) => doc.personal.nationality],
  ['Mobile Phone', (p) => p.mobile],
  ['Work Phone', (p) => p.workPhone],
  ['Region', (p) => p.address.region],
  ['District', (p) => p.address.district],
  ['Ward', (p) => p.address.ward],
  ['Street', (p) => p.address.street],
  ['House Number', (p) => p.address.house],
  ['Branch', (p) => p.station],
  ['Bank Name', (p, i, doc) => doc.bank.bank],
  ['Bank Branch', (p) => p.bankBranch],
  ['Bank Account Name', (p, i, doc) => doc.bank.accountName],
  ['Bank Account Number', (p) => p.accountNo],
  ['Next of Kin First Name', (p) => p.nextOfKin[0]?.firstName || ''],
  ['Next of Kin Surname', (p) => p.nextOfKin[0]?.lastName || ''],
  ['Next of Kin Relationship', (p) => p.nextOfKin[0]?.relationship || ''],
  ['Next of Kin Phone', (p) => p.nextOfKin[0]?.phone || ''],
  ['Next of Kin Address', (p) => p.nextOfKin[0]?.address || ''],
];

/** The staff sheet as rows: headings, then one row per person. */
function sheetRows() {
  return [SHEET_COLUMNS.map(([h]) => h), ...TEST_STAFF.map((p, i) => {
    const doc = toStaffDoc(p);
    return SHEET_COLUMNS.map(([, get]) => get(p, i, doc));
  })];
}

/** Writes the staff sheet as CSV and Excel to dir; returns the file names. */
function writeSheet(dir = SHEET_DIR) {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  fs.mkdirSync(dir, { recursive: true });
  const rows = sheetRows();
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  fs.writeFileSync(path.join(dir, `${SHEET_NAME}.csv`), `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = rows[0].map((h, c) => ({ wch: Math.max(h.length, ...rows.slice(1).map((r) => String(r[c]).length)) + 2 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Test staff');
  XLSX.writeFile(wb, path.join(dir, `${SHEET_NAME}.xlsx`));
  return [`${SHEET_NAME}.csv`, `${SHEET_NAME}.xlsx`];
}

/** Salary figures as on the payslip. */
function salaryFor(p, pricing = PRICING) {
  const allowances = p.pay.allowances || 0;
  const ps = calc.payslip({ basic: p.pay.basic }, pricing);
  const lfb = p.lfbLines.reduce((s, l) => s + l.amount, 0);
  const gross = p.pay.basic + allowances;
  return { basic: p.pay.basic, allowances, gross, net: gross - ps.tax - ps.pension - lfb };
}

/** opts: { dryRun, ownConnection }. */
async function load({ dryRun = false, ownConnection = true } = {}) {
  // Required here, not at the top: writing payslips needs no configuration or database.
  /* eslint-disable global-require */
  const mongoose = require('mongoose');
  const { config } = require('../src/config/env');
  const { connect } = require('../src/config/db');
  const Staff = require('../src/models/Staff');
  const User = require('../src/models/User');
  const Role = require('../src/models/Role');
  const RoleAssignment = require('../src/models/RoleAssignment');
  const Salary = require('../src/models/Salary');
  const AuditLog = require('../src/models/AuditLog');
  const credentials = require('../src/services/auth/credentialProvider');
  const passwordPolicy = require('../src/services/auth/passwordPolicy');
  const rbac = require('../src/services/rbac/rbacService');
  const { describeTarget } = require('./reset-staff-and-products');
  /* eslint-enable global-require */
  const target = describeTarget();
  console.log(`Environment: NODE_ENV=${target.nodeEnv}; database "${target.db}" on ${target.host}:${target.port}`);
  if (target.nodeEnv === 'production') throw new Error('NODE_ENV is production. Test staff are never loaded there; nothing changed.');
  if (TEST_STAFF.some((p) => !p.staffNo.startsWith(TEST_STAFF_PREFIX))) throw new Error(`Every test staff number must start with ${TEST_STAFF_PREFIX}.`);

  if (ownConnection) await connect(config.mongoUri);
  try {
    // A staff number already held by someone else is never overwritten.
    const existing = await Staff.find({ staffNo: { $in: TEST_STAFF.map((p) => p.staffNo) } }).lean();
    const clashes = existing.filter((s) => {
      const p = TEST_STAFF.find((t) => t.staffNo === s.staffNo);
      return s.firstName !== p.firstName || s.lastName !== p.lastName;
    });
    if (clashes.length) throw new Error(`These staff numbers belong to someone else, nothing changed: ${clashes.map((s) => `${s.staffNo} (${s.firstName} ${s.lastName})`).join(', ')}`);
    // Nor is a username already used by another staff number.
    const names = TEST_STAFF.map((p) => p.userName);
    const takenBy = [...await Staff.find({ userName: { $in: names } }, { staffNo: 1, userName: 1 }).lean(), ...await User.find({ userName: { $in: names } }, { staffNo: 1, userName: 1 }).lean()]
      .filter((x) => x.staffNo !== TEST_STAFF.find((p) => p.userName === x.userName).staffNo);
    if (takenBy.length) throw new Error(`These usernames are already used by other staff, nothing changed: ${[...new Set(takenBy.map((x) => `${x.userName} (${x.staffNo})`))].join(', ')}`);

    const plan = TEST_STAFF.map((p) => `${fullName(p)} (${p.staffNo}), ${p.title}${p.roles.length ? ` [${p.roles.join(', ')}]` : ''}`);
    if (dryRun) return { target, dryRun, plan, alreadyOnFile: existing.length, loaded: null };

    const password = process.env.RESET_TEMP_PASSWORD;
    if (!password) throw new Error('Set RESET_TEMP_PASSWORD to the temporary password for the new accounts.');
    const problems = passwordPolicy.check(password);
    if (problems.length) throw new Error(`RESET_TEMP_PASSWORD: ${problems.join(' ')}`);

    const roleByCode = Object.fromEntries((await Role.find().lean()).map((r) => [r.code, r]));
    for (const p of TEST_STAFF) {
      const wanted = ['staff', ...p.roles];
      const missing = wanted.filter((c) => !roleByCode[c]);
      if (missing.length) throw new Error(`${p.staffNo}: role ${missing.join(', ')} is not set up in this system; run the seed first. Nothing changed.`);
      const sod = rbac.checkUserRoles(wanted.map((c) => roleByCode[c]));
      if (sod.length) throw new Error(`${p.staffNo}: segregation of duties: ${JSON.stringify(sod)}`);
    }

    const probe = new User({ staffNo: 'TST0', mustChangePassword: true });
    await credentials.forUser(probe).setPassword(probe, password, { skipHistory: true });
    const hash = { passwordHash: probe.passwordHash, passwordChangedAt: probe.passwordChangedAt };

    const loaded = { created: 0, updated: 0, usersCreated: 0, salaries: 0, roles: [] };
    /* eslint-disable no-await-in-loop */
    for (const p of TEST_STAFF) {
      const doc = toStaffDoc(p);
      let staff = await Staff.findOne({ staffNo: p.staffNo });
      if (staff) {
        staff.set(doc);
        await staff.save();
        loaded.updated += 1;
      } else {
        staff = await Staff.create(doc);
        loaded.created += 1;
      }

      let user = await User.findOne({ staffNo: p.staffNo });
      if (!user) {
        user = await User.create({ staffNo: p.staffNo, userName: p.userName, staffId: staff._id, mustChangePassword: true, ...hash });
        await AuditLog.create({ action: 'user.create', description: `User created for test staff ${p.staffNo} (${fullName(p)}) by the test staff loader; temporary password, change forced at first sign-in`, entity: 'User', entityId: String(user._id), after: { staffNo: p.staffNo, roles: ['staff', ...p.roles] } });
        loaded.usersCreated += 1;
      }
      for (const code of ['staff', ...p.roles]) {
        const role = roleByCode[code];
        if (!(await RoleAssignment.exists({ userId: user._id, roleId: role._id, revokedAt: null }))) await RoleAssignment.create({ userId: user._id, roleId: role._id });
        if (code !== 'staff') loaded.roles.push(`${fullName(p)} (${p.staffNo}): ${role.name}`);
      }
      if (!(await Salary.exists({ staffId: staff._id, effectiveFrom: SALARY_FROM }))) {
        await Salary.create({ staffId: staff._id, ...salaryFor(p), effectiveFrom: SALARY_FROM, source: 'test staff loader' });
        loaded.salaries += 1;
      }
    }
    /* eslint-enable no-await-in-loop */
    return { target, dryRun: false, plan, alreadyOnFile: existing.length, loaded };
  } finally {
    if (ownConnection) await mongoose.disconnect();
  }
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const dirArg = arg && !arg.startsWith('--') ? path.resolve(arg) : null;
  const job = cmd === 'sheet'
    ? Promise.resolve(writeSheet(dirArg || SHEET_DIR)).then((files) => console.log(`Wrote ${files.join(' and ')}`))
    : cmd === 'payslips'
    ? writePayslips(arg && !arg.startsWith('--') ? path.resolve(arg) : PAYSLIP_DIR).then((files) => {
      console.log(`Wrote ${files.length} payslips:`);
      files.forEach((f) => console.log(`  ${f}`));
    })
    : cmd === 'load'
      ? load({ dryRun: process.argv.includes('--dry-run') }).then((r) => {
        console.log(`Test staff already on file: ${r.alreadyOnFile}`);
        console.log(`${r.dryRun ? 'Would load' : 'Loaded'}:`);
        r.plan.forEach((x) => console.log(`  ${x}`));
        if (r.loaded) console.log(`Created ${r.loaded.created}, updated ${r.loaded.updated}; accounts created ${r.loaded.usersCreated}; salaries recorded ${r.loaded.salaries}`);
      })
      : Promise.reject(new Error('Usage: npm run test-staff -- sheet [dir] | payslips [dir] | load [--dry-run]'));
  job.catch((err) => {
    console.error(`Stopped: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { load, writePayslips, writeSheet, sheetRows, payslipFor, salaryFor, PAYSLIP_DIR, SHEET_COLUMNS };

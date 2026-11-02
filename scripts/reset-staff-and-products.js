'use strict';

/* eslint-disable no-console */
// Data reset for a NON-PRODUCTION system (§7, D-92). Repeatable and reviewable:
//
//   npm run reset:staff -- --dry-run        shows the target and what would change
//   npm run reset:staff                      backs up, loads the staff, then deletes
//
// 1. Shows the environment and database, and refuses NODE_ENV=production or a
//    non-local database.
// 2. Backs up every collection (Extended JSON) and the uploaded files to
//    <upload dir>/../backups/<timestamp>/.
// 3. Syncs the system roles to the catalogue (src/constants/systemRoles.js) and removes
//    the retired Product Checker role.
// 4. Loads the staff table: STAFF_CSV, or seed/data/lfb-staff.csv (not in git: real staff
//    data stays out of the repository; seed/data/lfb-staff.example.csv shows the format).
//    Staff numbers are loaded exactly as given; it stops on duplicates. It creates their accounts as the user management flow does (temporary
//    password RESET_TEMP_PASSWORD, change forced at first sign-in), and assigns roles.
//    Loading comes before any deletion, so an administrator login always exists.
// 5. Deletes every other staff member and their accounts, and all applications,
//    approvals, agreements, documents, notifications, birthdate verifications,
//    delegations, staff imports and salaries, and every loan product and version.
//    Kept: pricing, settings, holidays, roles, agreement templates and the audit log
//    (append-only evidence).
// Running it again loads nothing twice and deletes nothing more.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const Staff = require('../src/models/Staff');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const RoleAssignment = require('../src/models/RoleAssignment');
const AuditLog = require('../src/models/AuditLog');
const credentials = require('../src/services/auth/credentialProvider');
const passwordPolicy = require('../src/services/auth/passwordPolicy');
const rbac = require('../src/services/rbac/rbacService');
const { DEFAULT_ROLES } = require('../src/constants/systemRoles');
const { STAFF_NO } = require('../src/constants/staffNo');

const CSV = process.env.STAFF_CSV || path.join(__dirname, '..', 'seed', 'data', 'lfb-staff.csv');

/** Roles beyond Staff, by staff number (the brief, and titles for CEO, OPS and admin). */
const ROLES_BY_STAFF_NO = {
  AT697: ['head_credit'], // Head of Credit, first product approver (also prepares products)
  AT727: ['head_risk'], // Head of Risk and Compliance, second product approver
  AT534: ['head_legal'], // Head of Legal, approves agreement templates
  AT700: ['legal_officer'], // Legal Officer, uploads and edits templates
  AT646: ['credit_analyst'], // Credit Analyst, identity only
  AT663: ['head_pc'], // Head of People and Culture, verifies birthdates
  AT540: ['auditor'], // Auditor, read-only
  AT648: ['ceo'], // CEO (by title)
  AT144: ['ops'], // Lending Operations Manager → OPS (by title)
  AT656: ['sys_admin'], // System Administrator (by title); the admin login kept
};

/** Collections deleted entirely (test data); staff and users are handled separately. */
const WIPE = ['applications', 'agreements', 'decisions', 'storedfiles', 'notifications', 'dobchanges', 'delegations', 'staffimports', 'products', 'productversions'];


function readStaff(file = CSV) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (header !== 'First Name,Surname,Staff No,Gender,Department,Title') throw new Error(`Unexpected header in ${file}`);
  const rows = lines.map((l, i) => {
    const [firstName, lastName, staffNo, gender, department, title] = l.split(',').map((x) => x.trim());
    if (!STAFF_NO.test(staffNo)) throw new Error(`Row ${i + 2}: staff number "${staffNo}" is not valid.`);
    return { firstName, lastName, staffNo, gender: gender || undefined, department, title };
  });
  const seen = new Map();
  const dupes = rows.filter((r) => (seen.has(r.staffNo) ? true : (seen.set(r.staffNo, r), false)));
  if (dupes.length) throw new Error(`Duplicate staff numbers, nothing changed: ${dupes.map((d) => d.staffNo).join(', ')}`);
  return rows;
}

/** CEO and the Heads are management (BRD 7.3); everyone else non-management. */
const categoryFor = (title) => (/^(Chief Executive Officer|Head of )/i.test(title) ? 'Management' : 'Non-management');

function describeTarget() {
  const u = new URL(config.mongoUri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
  const db = (u.pathname || '/').slice(1) || '(default)';
  return { nodeEnv: config.nodeEnv, host: u.hostname, port: u.port || '27017', db };
}

async function backup(db, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const counts = {};
  for (const { name } of await db.listCollections().toArray()) {
    // eslint-disable-next-line no-await-in-loop
    const docs = await db.collection(name).find().toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), EJSON.stringify(docs, null, 0, { relaxed: false }));
    counts[name] = docs.length;
  }
  if (fs.existsSync(config.uploadDir)) fs.cpSync(config.uploadDir, path.join(dir, 'uploads'), { recursive: true });
  return counts;
}

async function syncRoles(db) {
  const out = { updated: [], created: [], removed: [] };
  for (const r of DEFAULT_ROLES) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await Role.findOne({ code: r.code });
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await Role.create({ ...r, active: true });
      out.created.push(r.name);
    } else if (r.system && JSON.stringify([...existing.permissions].sort()) !== JSON.stringify([...r.permissions].sort())) {
      // eslint-disable-next-line no-await-in-loop
      await db.collection('roles').updateOne({ _id: existing._id }, { $set: { permissions: r.permissions, name: r.name, description: r.description, system: true, active: true } });
      out.updated.push(r.name);
    }
  }
  const retired = await Role.findOne({ code: 'product_checker' });
  if (retired) {
    await RoleAssignment.deleteMany({ roleId: retired._id });
    await db.collection('roles').deleteOne({ _id: retired._id });
    out.removed.push(retired.name);
  }
  return out;
}

/**
 * opts.dryRun: count only; opts.file: the staff table (CSV); opts.ownConnection: false when the caller is already connected
 * (tests), so the script neither connects nor disconnects.
 */
async function run({ dryRun = false, ownConnection = true, file = CSV } = {}) {
  const DRY = dryRun;
  const target = describeTarget();
  const local = ['localhost', '127.0.0.1', '::1'].includes(target.host);
  console.log(`Environment: NODE_ENV=${target.nodeEnv}; database "${target.db}" on ${target.host}:${target.port}`);
  if (target.nodeEnv === 'production' || !local) throw new Error('This looks like production or a remote database. Stopping; nothing changed.');

  const staffRows = readStaff(file);
  const keepNos = new Set(staffRows.map((r) => r.staffNo));
  const odd = staffRows.filter((r) => !/^AT\d+$/.test(r.staffNo)).map((r) => r.staffNo);
  const password = process.env.RESET_TEMP_PASSWORD;
  if (!DRY) {
    if (!password) throw new Error('Set RESET_TEMP_PASSWORD to the temporary password for the new accounts.');
    const problems = passwordPolicy.check(password);
    if (problems.length) throw new Error(`RESET_TEMP_PASSWORD: ${problems.join(' ')}`);
  }

  if (ownConnection) await connect(config.mongoUri);
  const { db } = mongoose.connection;

  // Dry-run counts.
  const oldStaff = await Staff.find({ staffNo: { $nin: [...keepNos] } }).select('_id staffNo').lean();
  const oldUsers = await User.find({ staffNo: { $nin: [...keepNos] } }).select('_id').lean();
  const oldUserIds = oldUsers.map((u) => u._id);
  const plan = {
    staffs: oldStaff.length,
    users: oldUsers.length,
    roleassignments: await RoleAssignment.countDocuments({ userId: { $in: oldUserIds } }),
    sessions: await db.collection('sessions').countDocuments({ userId: { $in: oldUserIds } }),
    refreshtokens: await db.collection('refreshtokens').countDocuments({ userId: { $in: oldUserIds } }),
    salaries: await db.collection('salaries').countDocuments({ staffId: { $in: oldStaff.map((s) => s._id) } }),
    counters: await db.collection('counters').countDocuments({ _id: { $regex: '^(SL|MKT)-' } }),
  };
  for (const name of WIPE) {
    // eslint-disable-next-line no-await-in-loop
    plan[name] = await db.collection(name).countDocuments();
  }
  const toLoad = staffRows.length;
  console.log('\nTo delete (dry run):');
  Object.entries(plan).forEach(([k, n]) => console.log(`  ${k.padEnd(16)} ${n}`));
  console.log(`To load or update: ${toLoad} staff from ${path.relative(process.cwd(), file)}`);
  if (odd.length) console.log(`Staff numbers not following "AT" + digits (loaded as given): ${odd.join(', ')}`);
  if (DRY) {
    if (ownConnection) await mongoose.disconnect();
    return { dryRun: true, target, plan };
  }

  // Backup.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(path.dirname(path.resolve(config.uploadDir)), 'backups', `reset-${stamp}`);
  const backedUp = await backup(db, backupDir);
  console.log(`\nBackup: ${backupDir} (${Object.values(backedUp).reduce((a, b) => a + b, 0)} documents in ${Object.keys(backedUp).length} collections, plus uploaded files)`);

  // Roles.
  const roleChanges = await syncRoles(db);
  const roleByCode = Object.fromEntries((await Role.find().lean()).map((r) => [r.code, r]));

  // Load staff and accounts first.
  const hash = await (async () => {
    const probe = new User({ staffNo: 'AT0', mustChangePassword: true });
    await credentials.forUser(probe).setPassword(probe, password, { skipHistory: true });
    return { passwordHash: probe.passwordHash, passwordChangedAt: probe.passwordChangedAt };
  })();
  const loaded = { created: 0, updated: 0, usersCreated: 0, assignments: [] };
  for (const r of staffRows) {
    /* eslint-disable no-await-in-loop */
    const fields = { firstName: r.firstName, lastName: r.lastName, title: r.title, department: r.department, category: categoryFor(r.title), status: 'active' };
    const existing = await Staff.findOne({ staffNo: r.staffNo });
    let staff;
    if (existing) {
      existing.set(fields);
      existing.gender = r.gender;
      await existing.save();
      staff = existing;
      loaded.updated += 1;
    } else {
      // Date of birth left empty: the staff member enters it and People and Culture verify it (D-82).
      staff = await Staff.create({ staffNo: r.staffNo, ...fields, gender: r.gender, bank: { bank: 'Letshego Faidika Bank', accountName: `${r.firstName} ${r.lastName}` } });
      loaded.created += 1;
    }
    let user = await User.findOne({ staffNo: r.staffNo });
    if (!user) {
      user = await User.create({ staffNo: r.staffNo, staffId: staff._id, mustChangePassword: true, ...hash });
      await AuditLog.create({ action: 'user.create', description: `User created for ${r.staffNo} (${r.firstName} ${r.lastName}) by the data reset; temporary password, change forced at first sign-in`, entity: 'User', entityId: String(user._id), after: { staffNo: r.staffNo, roles: ['staff', ...(ROLES_BY_STAFF_NO[r.staffNo] || [])] } });
      loaded.usersCreated += 1;
    }
    const wanted = ['staff', ...(ROLES_BY_STAFF_NO[r.staffNo] || [])];
    const sod = rbac.checkUserRoles(wanted.map((c) => roleByCode[c]));
    if (sod.length) throw new Error(`${r.staffNo}: segregation of duties: ${JSON.stringify(sod)}`);
    for (const code of wanted) {
      const role = roleByCode[code];
      const has = await RoleAssignment.exists({ userId: user._id, roleId: role._id, revokedAt: null });
      if (!has) await RoleAssignment.create({ userId: user._id, roleId: role._id });
      if (code !== 'staff') loaded.assignments.push(`${r.firstName} ${r.lastName} (${r.staffNo}): ${role.name}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  // Then delete the old data.
  const deleted = {};
  deleted.roleassignments = (await RoleAssignment.deleteMany({ userId: { $in: oldUserIds } })).deletedCount;
  deleted.sessions = (await db.collection('sessions').deleteMany({ userId: { $in: oldUserIds } })).deletedCount;
  deleted.refreshtokens = (await db.collection('refreshtokens').deleteMany({ userId: { $in: oldUserIds } })).deletedCount;
  deleted.users = (await User.deleteMany({ _id: { $in: oldUserIds } })).deletedCount;
  deleted.salaries = (await db.collection('salaries').deleteMany({ staffId: { $in: oldStaff.map((s) => s._id) } })).deletedCount;
  deleted.staffs = (await Staff.deleteMany({ _id: { $in: oldStaff.map((s) => s._id) } })).deletedCount;
  const files = await db.collection('storedfiles').find().project({ storageKey: 1 }).toArray();
  for (const name of WIPE) {
    // eslint-disable-next-line no-await-in-loop
    deleted[name] = (await db.collection(name).deleteMany({})).deletedCount;
  }
  files.forEach((f) => fs.rmSync(path.join(config.uploadDir, f.storageKey), { force: true }));
  deleted.counters = (await db.collection('counters').deleteMany({ _id: { $regex: '^(SL|MKT)-' } })).deletedCount;

  const perDepartment = staffRows.reduce((m, r) => ({ ...m, [r.department]: (m[r.department] || 0) + 1 }), {});
  await AuditLog.create({ action: 'data.reset', description: `Staff and products reset: ${staffRows.length} staff loaded, ${deleted.staffs} removed, ${deleted.products} products removed (backup ${backupDir})`, entity: 'System', entityId: 'reset', after: { deleted, loaded: { ...loaded, assignments: loaded.assignments.length }, roles: roleChanges } });
  if (ownConnection) await mongoose.disconnect();
  return { target, backupDir, deleted, loaded, perDepartment, roleChanges, odd, admins: staffRows.filter((r) => (ROLES_BY_STAFF_NO[r.staffNo] || []).includes('sys_admin')).map((r) => `${r.firstName} ${r.lastName} (${r.staffNo})`) };
}

if (require.main === module) {
  run({ dryRun: process.argv.includes('--dry-run') })
    .then((out) => {
      if (out.dryRun) {
        console.log('\nDry run only: nothing changed.');
        return;
      }
      console.log('\nDeleted:');
      Object.entries(out.deleted).forEach(([k, n]) => console.log(`  ${k.padEnd(16)} ${n}`));
      console.log(`\nStaff: ${out.loaded.created} created, ${out.loaded.updated} updated; user accounts created: ${out.loaded.usersCreated}`);
      console.log('Per department:');
      Object.entries(out.perDepartment).forEach(([d, n]) => console.log(`  ${d.padEnd(22)} ${n}`));
      console.log('Roles beyond Staff:');
      out.loaded.assignments.forEach((a) => console.log(`  ${a}`));
      console.log(`System roles: created ${out.roleChanges.created.join(', ') || 'none'}; updated ${out.roleChanges.updated.join(', ') || 'none'}; removed ${out.roleChanges.removed.join(', ') || 'none'}`);
      console.log(`Administrator login kept: ${out.admins.join(', ')}`);
    })
    .catch(async (err) => {
      console.error(`Stopped: ${err.message}`);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run, readStaff, categoryFor, syncRoles, ROLES_BY_STAFF_NO };

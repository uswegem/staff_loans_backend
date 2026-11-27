'use strict';
/* eslint-disable no-console, no-await-in-loop */
// SLAS production go-live reset (27 Nov 2026).
//
// Dry run by default: checks the staff file and shows exactly what would change. Nothing
// is written. Run again with --apply to do it.
//
// KEPT (production configuration): products and product versions, agreement templates,
// legal notices (data protection), roles, settings (incl. agreement logo), pricing,
// holidays, location regions. Staff and user records that are in the file keep their
// database ids, so the product and template approval records still name the right people.
//
// CLEARED (testing): applications, agreements, approval decisions, uploaded files (except
// the agreement logo), notifications, date-of-birth changes, delegations, staff imports,
// salaries, sessions, refresh tokens, reference counters (SL-/MKT-), and the audit log
// (exported to a file first). Staff not in the file are deleted with their accounts.
//
// LOADED from the file: every staff member's HR and profile details; date of birth stored
// as verified (D-114); a unique temporary password each (change forced at first
// sign-in); roles from PROD_ROLES below (test role assignments are dropped).
//
// Usage (as root):
//   cd /opt/slas/api && node /root/slas-tools/prod-reset.js /root/slas-prod/Final_Staff_List_final.xlsx
//   XLSX_PASSWORD=... node /root/slas-tools/prod-reset.js <file> --apply

const API = process.env.SLAS_API_DIR || '/opt/slas/api';
process.chdir(API);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const req = (p) => require(path.join(API, p));
const mongoose = req('node_modules/mongoose');
const bcrypt = req('node_modules/bcryptjs');
const XLSX = req('node_modules/xlsx');
const { EJSON } = mongoose.mongo.BSON;
const { config } = req('src/config/env');
const { connect, withTransaction } = req('src/config/db');
const Staff = req('src/models/Staff');
const User = req('src/models/User');
const Role = req('src/models/Role');
const RoleAssignment = req('src/models/RoleAssignment');
const Settings = req('src/models/Settings');
const LocationRegion = req('src/models/LocationRegion');
const AuditLog = req('src/models/AuditLog');
const rbac = req('src/services/rbac/rbacService');
const passwordPolicy = req('src/services/auth/passwordPolicy');
const { problemWith } = req('src/services/staff/dobService');
const { localMidnight, localDay } = req('src/utils/dates');
const { normaliseNida, normalisePhone } = req('src/utils/formats');
const { normaliseCountry } = req('src/constants/countries');
const { STAFF_NO } = req('src/constants/staffNo');

const FILE = process.argv.slice(2).find((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
const OUT_DIR = '/root/slas-prod';
const ACTOR_NO = 'AT656'; // System Administrator: recorded as verifier of uploaded dates of birth
// Production role holders by staff number (agreed with the Head of Operations, 27 Nov 2026).
// Everyone in the file also gets Staff. Nothing from testing is carried over.
// Dates joined given by the Head of Operations where the HR file is blank (#N/A), 27 Nov 2026.
const DATE_JOINED_SET = {
  AT648: '2023-07-01', // Baraka Munisi
  AT663: '2023-07-01', // Rashid Said
};

const PROD_ROLES = {
  sys_admin: ['AT656', 'AT623', 'AT664', 'AT603', 'AT637'], // Ramadhani, Agias, Iddi, Nurdin, Uswege
  ceo: ['AT648'], // Baraka Munisi
  head_pc: ['AT663'], // Rashid Said
  pc_manager: ['AT676'], // Elizabeth Buberwa
  head_credit: ['AT697'], // Said Mbaruku
  credit_manager: ['AT658'], // Elias Marenga
  credit_analyst: ['AT646', 'AT709'], // Pelagia Ngowi, Ally Mussa
  head_risk: ['AT727'], // Jackline Muro
  head_legal: ['AT534'], // Ladislaus Muhagachi
  legal_officer: ['AT700'], // Benard Charle
  ops: ['AT144', 'AT118'], // Neema Balozi, Adriano Mwazembe
};

// Cleared entirely. Raw collection calls, because decisions and the audit log are
// append-only through the app's models.
const WIPE = ['applications', 'agreements', 'decisions', 'notifications', 'dobchanges', 'delegations', 'staffimports', 'salaries', 'sessions', 'refreshtokens'];
const KEEP = ['products', 'productversions', 'agreementtemplates', 'legalnotices', 'roles', 'settings', 'pricingversions', 'holidays', 'locationregions'];

const t = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const letters = (v) => t(v).toLowerCase().replace(/[^a-z]/g, '');
const split = (v) => t(v).split(';').map((x) => x.trim());
const MARITAL = ['Single', 'Married', 'Divorced', 'Widowed'];

function phone(v) {
  let d = t(v).replace(/\D/g, '');
  if (d.startsWith('255255')) d = d.slice(3);
  if (d.startsWith('2550') && d.length === 13) d = `255${d.slice(4)}`;
  return normalisePhone(d.startsWith('255') ? `+${d}` : d);
}
function relationship(v) {
  const s = letters(v);
  if (!s) return '';
  if (/spouse|wife|husband|mke|mume/.test(s)) return 'Spouse';
  if (/inlaw|uncle|aunt|cousin|nephew|niece|grand/.test(s)) return 'Other relative';
  if (/mother|mather|father|dad|baba|mama|parent/.test(s)) return 'Parent';
  if (/son|daughter|child/.test(s)) return 'Child';
  if (/brother|sister|sibling/.test(s)) return 'Sibling';
  if (/guardian/.test(s)) return 'Guardian';
  return 'Other relative';
}
/** Excel serial date, Date, or dd/mm/yyyy text → YYYY-MM-DD (no time zone shifts). */
function day(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    return p ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null;
  }
  const m = t(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/) || t(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = m[1].length === 4 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** 12 characters, all four character classes, no look-alike characters. */
function tempPassword(staffNo) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '#@$%&*!?'];
  for (;;) {
    const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
    const all = sets.join('');
    while (chars.length < 12) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const pw = chars.join('');
    if (!passwordPolicy.check(pw, { staffNo }).length) return pw;
  }
}

function readFile(file, ctx) {
  const wb = XLSX.readFile(file, { raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true }).filter((r) => t(r['Staff Number']));
  const need = ['Staff Number', 'First Name', 'Middle Name', 'Last Name', 'Gender', 'Department', 'Job Title', 'Category', 'Email', 'Username', 'Marital Status', 'Date of Birth', 'Date Joined', 'NIDA Number', 'Nationality', 'Mobile Phone', 'Region', 'Branch', 'Bank Account Number', 'Next of Kin First Name', 'Next of Kin Surname', 'Next of Kin Relationship', 'Next of Kin Phone', 'Next of Kin Address'];
  const missing = need.filter((h) => !(h in rows[0]));
  if (missing.length) throw new Error(`STOP: columns not found in sheet "${wb.SheetNames[0]}": ${missing.join(', ')}`);

  const errors = [];
  const notes = [];
  const seen = { no: new Map(), user: new Map(), email: new Map(), nida: new Map() };
  const once = (kind, key, no) => {
    if (!key) return;
    if (seen[kind].has(key)) errors.push(`${no}: ${kind} ${key} repeats ${seen[kind].get(key)}`);
    else seen[kind].set(key, no);
  };
  const out = rows.map((r) => {
    const no = t(r['Staff Number']).toUpperCase();
    const err = (m) => errors.push(`${no}: ${m}`);
    const note = (m) => notes.push(`${no}: ${m}`);
    if (!STAFF_NO.test(no)) err('staff number not valid');
    const firstName = t(r['First Name']);
    const lastName = t(r['Last Name']);
    let middleName = t(r['Middle Name']);
    if (!firstName || !lastName) err('first name or last name empty');
    if (middleName && middleName.toLowerCase() === lastName.toLowerCase()) {
      note(`middle name "${middleName}" repeats the surname, left out`);
      middleName = '';
    }
    const userName = t(r['Username']).toLowerCase();
    if (!/^[a-z][a-z0-9._-]{2,63}$/.test(userName)) err(`username "${userName}" not valid`);
    const category = ['Management', 'Non-management'].find((c) => c.toLowerCase() === t(r['Category']).toLowerCase());
    if (!category) err(`category "${t(r['Category'])}" must be Management or Non-management`);
    const gender = ['Male', 'Female'].find((g) => g.toLowerCase() === t(r['Gender']).toLowerCase());
    if (!gender) note('gender empty or not Male/Female, left empty');
    const email = t(r['Email']).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err(`email "${email}" not valid`);
    once('no', no, no);
    once('user', userName, no);
    once('email', email, no);

    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
    const doc = { staffNo: no, userName, firstName, lastName, title: t(r['Job Title']) || 'Staff', department: t(r['Department']) || undefined, category, gender, email: email || undefined, status: 'active', personal: {}, nextOfKin: [] };
    if (middleName) doc.middleName = middleName;

    const joined = DATE_JOINED_SET[no] || day(r['Date Joined']);
    if (DATE_JOINED_SET[no]) note(`date joined set to ${DATE_JOINED_SET[no]} (given by the Head of Operations; the file has "${t(r['Date Joined'])}")`);
    if (!joined) note(`date joined ${t(r['Date Joined']) ? `"${t(r['Date Joined'])}" is not a date` : 'is empty'}, left for the staff member`);
    else if (joined > ctx.today) err(`date joined ${joined} is in the future`);
    else doc.dateJoined = localMidnight(joined);

    const dob = day(r['Date of Birth']);
    if (!dob) note('date of birth empty or not a date, left for the staff member');
    else {
      const wrong = problemWith(dob, ctx.settings);
      if (wrong) note(`date of birth ${dob}: ${wrong}; left for the staff member`);
      else doc.dob = dob;
    }

    const ms = MARITAL.find((m) => m.toLowerCase() === t(r['Marital Status']).toLowerCase());
    if (ms) doc.personal.maritalStatus = ms;
    const nida = normaliseNida(t(r['NIDA Number']));
    if (nida) {
      doc.personal.nida = nida;
      once('nida', nida, no);
    } else note(`NIDA ${t(r['NIDA Number']) ? `"${t(r['NIDA Number'])}" is not 20 digits` : 'is empty'}, left for the staff member`);
    const nat = normaliseCountry(t(r['Nationality']));
    if (nat) doc.personal.nationality = nat;
    const mobile = phone(split(r['Mobile Phone'])[0]);
    if (mobile) doc.personal.mobile = mobile;
    else note('mobile not a valid Tanzanian number, left for the staff member');
    const region = ctx.regions.find((n) => letters(n) === letters(r['Region']));
    if (region) doc.personal.address = { region };
    else if (t(r['Region'])) note(`region "${t(r['Region'])}" not in the location list, left for the staff member`);
    const branch = t(r['Branch']);
    if (branch) doc.station = branch;
    const acct = t(r['Bank Account Number']).replace(/\D/g, '');
    doc.bank = { bank: 'Letshego Faidika Bank', branch: branch || undefined, accountName: [firstName, lastName].join(' ') };
    if (acct.length >= 6 && acct.length <= 20) {
      doc.bank.accountNo = acct;
      doc.lfbAccountNo = acct;
    } else note('bank account number not valid, left for the staff member');

    const [fn, ln, rel, ph, ad] = ['Next of Kin First Name', 'Next of Kin Surname', 'Next of Kin Relationship', 'Next of Kin Phone', 'Next of Kin Address'].map((h) => split(r[h]));
    for (let i = 0; i < Math.max(fn.length, ln.length); i += 1) {
      if (!fn[i] && !ln[i]) continue;
      const k = { firstName: fn[i] || '', lastName: ln[i] || '', relationship: relationship(rel[i] || rel[0]), address: ad[i] || ad[0] || '' };
      const p = phone(ph[i] || '');
      if (p) k.phone = p;
      else if (ph[i]) note(`next of kin ${i + 1} phone "${ph[i]}" not valid, left blank`);
      const same = doc.nextOfKin.some((x) => letters(x.firstName + x.lastName) === letters(k.firstName + k.lastName));
      if (same) note(`next of kin ${i + 1} repeats an earlier one, left out`);
      else doc.nextOfKin.push(k);
    }
    if (!doc.nextOfKin.length) note('no next of kin in the file');
    return { doc, fullName, branch };
  });
  return { rows: out, errors, notes };
}

async function main() {
  if (!FILE || !fs.existsSync(FILE)) throw new Error('STOP: give the staff file path, e.g. /root/slas-prod/Final_Staff_List_final.xlsx');
  let XlsxPopulate = null;
  if (APPLY) {
    if (!process.env.XLSX_PASSWORD || process.env.XLSX_PASSWORD.length < 8) throw new Error('STOP: set XLSX_PASSWORD (at least 8 characters) to protect the password file.');
    XlsxPopulate = require('/root/slas-tools/node_modules/xlsx-populate');
  }
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (nothing is changed)'}`);
  console.log(`Environment: NODE_ENV=${config.nodeEnv}`);
  await connect(config.mongoUri);
  const { db } = mongoose.connection;

  const settings = await Settings.get();
  const regions = (await LocationRegion.find().select('name').lean()).map((r) => r.name);
  const { rows, errors, notes } = readFile(FILE, { settings, regions, today: localDay() });
  const fileNos = new Set(rows.map((r) => r.doc.staffNo));
  console.log(`\nStaff in file: ${rows.length}`);
  if (errors.length) {
    console.log(`\nSTOP, errors in the file (${errors.length}); nothing changed:\n  ${errors.join('\n  ')}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Production roles (agreed 27 Nov 2026). Test role assignments are NOT carried over.
  const roles = await Role.find().lean();
  const roleByCode = Object.fromEntries(roles.map((r) => [r.code, r]));
  const missingRoles = Object.keys(PROD_ROLES).concat('staff').filter((c) => !roleByCode[c]);
  if (missingRoles.length) throw new Error(`STOP: roles missing in the database: ${missingRoles.join(', ')} (run the 2026-12c upgrade first)`);
  const users = await User.find().select('staffNo').lean();
  const wanted = new Map([...fileNos].map((n) => [n, new Set(['staff'])]));
  const notInFile = [];
  for (const [code, nos] of Object.entries(PROD_ROLES)) {
    for (const no of nos) {
      if (wanted.has(no)) wanted.get(no).add(code);
      else notInFile.push(`${no} (${code})`);
    }
  }
  if (notInFile.length) throw new Error(`STOP: role holders not in the file: ${notInFile.join(', ')}`);
  const now = new Date();
  const missingAdmins = PROD_ROLES.sys_admin.filter((no) => !fileNos.has(no));
  if (missingAdmins.length) throw new Error(`STOP: System Administrators not in the file: ${missingAdmins.join(', ')}`);
  const sod = [];
  for (const [no, codes] of wanted) {
    const c = rbac.checkUserRoles([...codes].map((code) => roleByCode[code]));
    if (c.length) sod.push(`${no}: ${[...codes].join(', ')} → ${JSON.stringify(c)}`);
  }
  if (sod.length) throw new Error(`STOP: segregation of duties conflicts:\n  ${sod.join('\n  ')}`);

  // What changes.
  const staffOnFile = await Staff.find().select('staffNo').lean();
  const keepStaff = staffOnFile.filter((s) => fileNos.has(s.staffNo));
  const dropStaff = staffOnFile.filter((s) => !fileNos.has(s.staffNo));
  const dropUsers = users.filter((u) => !fileNos.has(u.staffNo));
  const logoId = settings.agreementLogoFileId ? String(settings.agreementLogoFileId) : null;
  const files = await db.collection('storedfiles').find(logoId ? { _id: { $ne: new mongoose.Types.ObjectId(logoId) } } : {}).project({ storageKey: 1 }).toArray();
  const plan = {};
  for (const c of WIPE) plan[c] = await db.collection(c).countDocuments();
  plan.storedfiles = files.length;
  plan.auditlogs = await db.collection('auditlogs').countDocuments();
  plan.counters = await db.collection('counters').countDocuments({ _id: { $regex: '^(SL|MKT)-' } });
  const kept = {};
  for (const c of KEEP) kept[c] = await db.collection(c).countDocuments();

  console.log(`Staff records updated in place: ${keepStaff.length}; new: ${rows.length - keepStaff.length}; deleted (not in file): ${dropStaff.length} ${dropStaff.map((s) => s.staffNo).join(' ')}`);
  console.log(`User accounts deleted (not in file): ${dropUsers.length}`);
  console.log('\nCleared:');
  Object.entries(plan).forEach(([k, n]) => console.log(`  ${k.padEnd(16)} ${n}`));
  console.log('\nKept:');
  Object.entries(kept).forEach(([k, n]) => console.log(`  ${k.padEnd(18)} ${n}`));
  console.log(`  agreement logo     ${logoId ? 'custom logo kept' : 'default logo'}`);
  console.log('\nRoles beyond Staff:');
  for (const [no, codes] of wanted) {
    const extra = [...codes].filter((c) => c !== 'staff');
    if (extra.length) {
      const r = rows.find((x) => x.doc.staffNo === no);
      console.log(`  ${no} ${r.fullName}: ${extra.map((c) => roleByCode[c].name).join(', ')}`);
    }
  }
  const dobs = rows.filter((r) => r.doc.dob).length;
  console.log(`\nDates of birth stored as verified: ${dobs} of ${rows.length}`);
  console.log(`Notes (${notes.length}): fields left for the staff member to complete in My profile`);
  notes.forEach((n) => console.log(`  ${n}`));

  if (!APPLY) {
    console.log('\nDRY RUN: nothing changed. Check the lists above, then run again with --apply.');
    await mongoose.disconnect();
    return;
  }

  // ---------- APPLY ----------
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const archive = path.join(OUT_DIR, `test-audit-log-${stamp}.json`);
  fs.writeFileSync(archive, EJSON.stringify(await db.collection('auditlogs').find().toArray(), null, 0, { relaxed: false }), { mode: 0o600 });
  console.log(`\nTest audit log exported: ${archive}`);

  // Passwords hashed before the transaction (bcrypt is slow).
  const creds = new Map();
  for (const r of rows) {
    const pw = tempPassword(r.doc.staffNo);
    creds.set(r.doc.staffNo, { pw, hash: await bcrypt.hash(pw, config.bcryptRounds) });
  }
  const actorUser = await User.findOne({ staffNo: ACTOR_NO }).select('_id').lean();

  const result = await withTransaction(async (session) => {
    const done = { staffUpdated: 0, staffCreated: 0, usersUpdated: 0, usersCreated: 0, roles: 0 };
    for (const c of WIPE) await db.collection(c).deleteMany({}, { session });
    await db.collection('storedfiles').deleteMany(logoId ? { _id: { $ne: new mongoose.Types.ObjectId(logoId) } } : {}, { session });
    await db.collection('counters').deleteMany({ _id: { $regex: '^(SL|MKT)-' } }, { session });
    await db.collection('auditlogs').deleteMany({}, { session });
    await db.collection('roleassignments').deleteMany({}, { session });
    await db.collection('users').deleteMany({ staffNo: { $nin: [...fileNos] } }, { session });
    await db.collection('staffs').deleteMany({ staffNo: { $nin: [...fileNos] } }, { session });

    for (const r of rows) {
      const { dob, ...fields } = r.doc;
      const existing = await Staff.findOne({ staffNo: fields.staffNo }).select('_id createdAt').session(session).lean();
      const staff = new Staff({ ...fields, ...(existing ? { _id: existing._id } : {}) });
      if (dob) {
        staff.dateOfBirth = { value: dob, verifiedAt: now, verifiedBy: actorUser?._id };
        staff.personal.dob = localMidnight(dob);
      }
      await staff.validate();
      const obj = staff.toObject({ depopulate: true });
      obj.updatedAt = now;
      obj.__v = 0;
      obj.createdAt = existing?.createdAt || now;
      if (existing) {
        await db.collection('staffs').replaceOne({ _id: existing._id }, obj, { session });
        done.staffUpdated += 1;
      } else {
        await db.collection('staffs').insertOne(obj, { session });
        done.staffCreated += 1;
      }
      const { hash } = creds.get(fields.staffNo);
      const fresh = { staffNo: fields.staffNo, userName: fields.userName, staffId: obj._id, authProvider: 'local', passwordHash: hash, passwordHistory: [], passwordChangedAt: now, mustChangePassword: true, status: 'active', failedAttempts: 0, mfa: { enabled: false }, preferences: { language: 'en', theme: 'light' }, updatedAt: now };
      const u = await User.findOne({ staffNo: fields.staffNo }).select('_id createdAt').session(session).lean();
      let userId;
      if (u) {
        await db.collection('users').replaceOne({ _id: u._id }, { _id: u._id, ...fresh, createdAt: u.createdAt || now, __v: 0 }, { session });
        userId = u._id;
        done.usersUpdated += 1;
      } else {
        userId = new mongoose.Types.ObjectId();
        await db.collection('users').insertOne({ _id: userId, ...fresh, createdAt: now, __v: 0 }, { session });
        done.usersCreated += 1;
      }
      for (const code of wanted.get(fields.staffNo)) {
        await db.collection('roleassignments').insertOne({ userId, roleId: roleByCode[code]._id, endsOn: null, assignedAt: now, revokedAt: null, createdAt: now, updatedAt: now, __v: 0 }, { session });
        done.roles += 1;
      }
    }
    await AuditLog.create(
      [{
        action: 'system.production_baseline',
        description: `Production go-live: test data cleared and ${rows.length} staff loaded from ${path.basename(FILE)} by the server administrator. Each staff member has a unique temporary password, change forced at first sign-in. Dates of birth from the HR file stored as verified (D-114). Kept: products, product versions, agreement templates, legal notices, roles, settings, pricing, holidays, location regions. Test audit log archived on the server (${path.basename(archive)}).`,
        actorId: actorUser?._id,
        actorStaffNo: ACTOR_NO,
        entity: 'System',
        entityId: 'production',
        after: { staff: rows.length, ...done, kept, cleared: plan },
      }],
      { session }
    );
    return done;
  });

  // Uploaded test files, after the database commit.
  let removed = 0;
  for (const f of files) {
    if (!f.storageKey) continue;
    const p = path.join(config.uploadDir, f.storageKey);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      removed += 1;
    }
  }

  // Password file, encrypted.
  const wb = await XlsxPopulate.fromBlankAsync();
  const sh = wb.sheet(0).name('Temporary passwords');
  const head = ['Staff No', 'Full name', 'Username', 'Department', 'Branch', 'Temporary password', 'Roles'];
  sh.cell('A1').value([head, ...rows.map((r) => [r.doc.staffNo, r.fullName, r.doc.userName, r.doc.department || '', r.branch || '', creds.get(r.doc.staffNo).pw, [...wanted.get(r.doc.staffNo)].map((c) => roleByCode[c].name).join(', ')])]);
  sh.row(1).style({ bold: true });
  [10, 34, 18, 22, 18, 20, 40].forEach((w, i) => sh.column(i + 1).width(w));
  sh.freezePanes(0, 1);
  const pwFile = path.join(OUT_DIR, `SLAS-temporary-passwords-${stamp}.xlsx`);
  await wb.toFileAsync(pwFile, { password: process.env.XLSX_PASSWORD });
  fs.chmodSync(pwFile, 0o600);

  console.log(`\nDone. Staff updated ${result.staffUpdated}, created ${result.staffCreated}; accounts reset ${result.usersUpdated}, created ${result.usersCreated}; role assignments ${result.roles}; uploaded test files removed ${removed}.`);
  console.log(`Password file (encrypted): ${pwFile}`);
  await mongoose.disconnect();
}

if (require.main !== module) {
  module.exports = { readFile, tempPassword, day };
} else main().catch(async (e) => {
  console.log(`Stopped: ${e.message}${e.details ? ` ${JSON.stringify(e.details)}` : ''}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

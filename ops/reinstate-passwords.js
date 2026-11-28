'use strict';
/* eslint-disable no-console, no-await-in-loop */
// Re-instates the temporary passwords from an encrypted SLAS password file (the one already
// handed to staff), unlocks the accounts and forces a password change at next sign-in.
// Dry run by default: reports, for each account, whether the file's password already works.
//
// Usage (as root):
//   read -rs XP   (the Excel file's password)
//   cd /opt/slas/api && XLSX_PASSWORD="$XP" node /root/slas-tools/reinstate-passwords.js <file.xlsx> [--apply]

const API = process.env.SLAS_API_DIR || '/opt/slas/api';
process.chdir(API);
const path = require('path');

const req = (p) => require(path.join(API, p));
const mongoose = req('node_modules/mongoose');
const bcrypt = req('node_modules/bcryptjs');
const { config } = req('src/config/env');
const { connect, withTransaction } = req('src/config/db');
const User = req('src/models/User');
const AuditLog = req('src/models/AuditLog');
const policy = req('src/services/auth/passwordPolicy');
const XlsxPopulate = require('/root/slas-tools/node_modules/xlsx-populate');

const FILE = process.argv.slice(2).find((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');

async function main() {
  if (!FILE) throw new Error('STOP: give the password file path.');
  if (!process.env.XLSX_PASSWORD) throw new Error('STOP: set XLSX_PASSWORD (the Excel file password).');
  let wb;
  try {
    wb = await XlsxPopulate.fromFileAsync(FILE, { password: process.env.XLSX_PASSWORD });
  } catch (e) {
    throw new Error(`STOP: could not open the file (wrong Excel password?): ${e.message}`);
  }
  const rows = wb.sheet(0).usedRange().value();
  const head = rows[0].map((h) => String(h || '').trim());
  const iNo = head.indexOf('Staff No');
  const iUser = head.indexOf('Username');
  const iPw = head.indexOf('Temporary password');
  if (iNo < 0 || iUser < 0 || iPw < 0) throw new Error(`STOP: columns Staff No / Username / Temporary password not found (found: ${head.join(', ')})`);
  const list = rows.slice(1).filter((r) => r[iNo]).map((r) => ({ staffNo: String(r[iNo]).trim().toUpperCase(), userName: String(r[iUser] || '').trim().toLowerCase(), pw: String(r[iPw] ?? '') }));

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (nothing is changed)'}`);
  console.log(`Accounts in file: ${list.length}`);
  await connect(config.mongoUri);

  const plan = [];
  const problems = [];
  let already = 0;
  let locked = 0;
  for (const x of list) {
    const u = await User.findOne({ staffNo: x.staffNo }).select('staffNo userName passwordHash status failedAttempts').lean();
    if (!u) { problems.push(`${x.staffNo}: no account on the server`); continue; }
    if (u.userName !== x.userName) problems.push(`${x.staffNo}: username on server "${u.userName}" differs from file "${x.userName}" (password still set)`);
    const bad = policy.check(x.pw, { staffNo: x.staffNo });
    if (bad.length) { problems.push(`${x.staffNo}: password in file fails the policy, skipped: ${bad.join('; ')}`); continue; }
    const works = await bcrypt.compare(x.pw, u.passwordHash);
    if (works) already += 1;
    if (u.status !== 'active' || u.failedAttempts) locked += 1;
    plan.push({ id: u._id, staffNo: x.staffNo, pw: x.pw, works, status: u.status, failed: u.failedAttempts });
  }
  const others = await User.countDocuments({ staffNo: { $nin: list.map((x) => x.staffNo) } });
  console.log(`Matched to accounts: ${plan.length}; file password already works: ${already}; locked or with failed attempts: ${locked}`);
  console.log(`Accounts on the server not in the file (left unchanged): ${others}`);
  if (problems.length) console.log(`Problems (${problems.length}):\n  ${problems.join('\n  ')}`);
  if (!APPLY) {
    console.log('\nDRY RUN: nothing changed. Run again with --apply to set these passwords.');
    await mongoose.disconnect();
    return;
  }

  const hashed = [];
  for (const p of plan) hashed.push({ ...p, hash: await bcrypt.hash(p.pw, config.bcryptRounds) });
  const now = new Date();
  const { db } = mongoose.connection;
  await withTransaction(async (session) => {
    for (const p of hashed) {
      await db.collection('users').updateOne(
        { _id: p.id },
        { $set: { passwordHash: p.hash, passwordHistory: [], passwordChangedAt: now, mustChangePassword: true, status: 'active', failedAttempts: 0, updatedAt: now }, $unset: { lockedAt: '' } },
        { session }
      );
      await db.collection('sessions').deleteMany({ userId: p.id }, { session });
      await db.collection('refreshtokens').deleteMany({ userId: p.id }, { session });
    }
    await AuditLog.create(
      [{
        action: 'user.passwords_reinstated',
        description: `Temporary passwords re-instated from ${path.basename(FILE)} for ${hashed.length} accounts by the server administrator; accounts unlocked, sessions ended, password change required at next sign-in.`,
        entity: 'User',
        entityId: 'bulk',
        after: { accounts: hashed.length, staffNos: hashed.map((p) => p.staffNo) },
      }],
      { session }
    );
  });
  console.log(`\nDone. Passwords set: ${hashed.length}; all unlocked; change required at next sign-in.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.log(`Stopped: ${e.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

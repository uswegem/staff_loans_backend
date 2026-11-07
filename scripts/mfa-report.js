'use strict';

// Read-only MFA status report (FR-49). Run on any environment to see who must use a
// one-time code, who has not enrolled yet, and recent sign-ins without a code:
//   node scripts/mfa-report.js [--days 7]
// Prints staff numbers, usernames and role codes only; never secrets or names.
const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');
const Delegation = require('../src/models/Delegation');
const rbac = require('../src/services/rbac/rbacService');

async function main() {
  const i = process.argv.indexOf('--days');
  const days = i > 0 ? Number(process.argv[i + 1]) || 7 : 7;
  await connect(config.mongoUri);
  const users = await User.find().sort({ staffNo: 1 }).lean();
  const delegates = new Set((await Delegation.find(Delegation.activeFilter()).select('delegateId').lean()).map((d) => String(d.delegateId)));
  const rows = [];
  for (const u of users) {
    // eslint-disable-next-line no-await-in-loop
    const eff = await rbac.effectiveFor(u._id);
    rows.push({ staffNo: u.staffNo, userName: u.userName || '(none)', roles: eff.roles.map((r) => r.code).join('+'), mfaRequired: eff.mfaRequired || delegates.has(String(u._id)), enrolled: !!u.mfa?.enabled, status: u.status });
  }
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const logins = await AuditLog.find({ action: 'auth.login', at: { $gte: since } }).select('at description').lean();
  const privileged = new Set(rows.filter((r) => r.mfaRequired).map((r) => r.staffNo));
  const withoutCode = logins.filter((l) => !/with MFA/.test(l.description)).map((l) => ({ at: l.at, staffNo: l.description.split(' ')[0] }));
  const report = {
    environment: config.nodeEnv,
    accounts: rows.length,
    withoutUsername: rows.filter((r) => r.userName === '(none)').map((r) => r.staffNo),
    mfaRequired: rows.filter((r) => r.mfaRequired),
    notYetEnrolled: rows.filter((r) => r.mfaRequired && !r.enrolled).map((r) => r.staffNo),
    signInsWithoutCode: { days, total: withoutCode.length, privileged: withoutCode.filter((l) => privileged.has(l.staffNo)) },
    note: 'Accounts with only the Staff role do not need a code (FR-49). A privileged sign-in without a code means the role was granted after that sign-in; privileged actions stay refused (MFA_STEP_UP) until the user signs in again.',
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => mongoose.disconnect()).catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  await mongoose.disconnect();
  process.exitCode = 1;
});

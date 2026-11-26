'use strict';

/* eslint-disable no-console */
// D-112: one Disbursement queue after final approval. People and Culture book loans in the
// loan management system outside SLAS, so the in-system booking step of D-107 goes.
// Run after upgrade-2026-12, once the API is deployed. Safe to run again.
//
//  1. Every application in Pending Booking moves to Pending Disbursement. stageEnteredAt
//     (the date of final approval) is kept, so the waiting time and Outside SLA are
//     unchanged. Each move is audited (application.status_migrated).
//  2. The People and Culture Manager and Head of People and Culture system roles get
//     disb.confirm (Disbursement). loan.book is removed from every role. Each role change
//     is audited (role.update).
//
// Stored bookings stay on the loans, read-only. Nothing is deleted.
//
// Dry run by default: it lists what would change and changes nothing. --apply changes it.
// Usage: npm run upgrade:2026-12b [-- --apply]

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const audit = require('../src/services/audit/auditService');

const PC_ROLES = ['pc_manager', 'head_pc'];
const NOTE = 'booking step removed, D-112';

async function run({ apply = false } = {}) {
  const { db } = mongoose.connection;
  const apps = db.collection('applications');
  const roles = db.collection('roles');
  const out = { apply, moved: [], rolesGiven: [], loanBookRemoved: [] };

  // 1. Pending Booking -> Pending Disbursement.
  const waiting = await apps.find({ status: 'pending_booking' }).project({ ref: 1 }).toArray();
  for (const a of waiting) {
    out.moved.push(a.ref);
    if (!apply) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await apps.updateOne({ _id: a._id, status: 'pending_booking' }, { $set: { status: 'pending_disbursement', updatedAt: new Date() } });
    if (!res.modifiedCount) continue;
    // eslint-disable-next-line no-await-in-loop
    await audit.record({
      actor: null,
      action: 'application.status_migrated',
      description: `${a.ref}: Pending Booking to Pending Disbursement (${NOTE})`,
      entity: 'Application',
      entityId: String(a._id),
      appRef: a.ref,
      before: { status: 'pending_booking' },
      after: { status: 'pending_disbursement' },
    });
  }

  // 2. disb.confirm for the two People and Culture roles; loan.book off every role.
  const all = await roles.find({ $or: [{ code: { $in: PC_ROLES }, permissions: { $ne: 'disb.confirm' } }, { permissions: 'loan.book' }] }).toArray();
  for (const r of all) {
    const give = PC_ROLES.includes(r.code) && !(r.permissions || []).includes('disb.confirm');
    const take = (r.permissions || []).includes('loan.book');
    if (give) out.rolesGiven.push(r.code);
    if (take) out.loanBookRemoved.push(r.code);
    if (!apply) continue;
    const after = [...new Set([...(r.permissions || []).filter((p) => p !== 'loan.book'), ...(give ? ['disb.confirm'] : [])])];
    // eslint-disable-next-line no-await-in-loop
    await roles.updateOne({ _id: r._id }, { $set: { permissions: after, updatedAt: new Date() } });
    // eslint-disable-next-line no-await-in-loop
    await audit.record({
      actor: null,
      action: 'role.update',
      description: `Role ${r.name || r.code}: ${[give && 'disb.confirm added', take && 'loan.book removed'].filter(Boolean).join(', ')} (${NOTE})`,
      entity: 'Role',
      entityId: String(r._id),
      before: { permissions: r.permissions },
      after: { permissions: after },
    });
  }
  return out;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  connect(config.mongoUri)
    .then(() => run({ apply }))
    .then((r) => {
      const verb = apply ? 'were' : 'would be';
      console.log(apply ? 'Upgrade applied.' : 'DRY RUN: nothing is changed. Run again with --apply to change it.');
      console.log(`Loans ${verb} moved from Pending Booking to Pending Disbursement: ${r.moved.length}${r.moved.length ? ` (${r.moved.join(', ')})` : ''}.`);
      console.log(`Roles ${verb} given disb.confirm: ${r.rolesGiven.join(', ') || 'none (already there)'}.`);
      console.log(`Roles ${verb} cleared of loan.book: ${r.loanBookRemoved.join(', ') || 'none'}.`);
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run };

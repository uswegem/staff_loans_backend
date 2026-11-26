'use strict';

/* eslint-disable no-console */
// D-113: Credit Underwriting (the credit stage, formerly "Credit Analyst") is decided by the
// Credit Analyst, the Credit Manager and the Head of Credit. Run once the API is deployed.
// Safe to run again.
//
//  1. The Head of Credit system role gets review.credit and review.delegate.
//  2. The Credit Manager system role is created if it does not exist.
// Each change is audited (role.update, role.create). Nothing else changes; people still need
// the Credit Manager role assigned under Users and roles.
//
// Dry run by default: it lists what would change and changes nothing. --apply changes it.
// Usage: npm run upgrade:2026-12c [-- --apply]

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const audit = require('../src/services/audit/auditService');
const { DEFAULT_ROLES } = require('../src/constants/systemRoles');

const NOTE = 'Credit Underwriting, D-113';
const HEAD_CREDIT_ADDS = ['review.credit', 'review.delegate'];

async function run({ apply = false } = {}) {
  const roles = mongoose.connection.db.collection('roles');
  const out = { apply, headCreditAdded: [], created: [] };

  const head = await roles.findOne({ code: 'head_credit' });
  if (head) {
    out.headCreditAdded = HEAD_CREDIT_ADDS.filter((p) => !(head.permissions || []).includes(p));
    if (apply && out.headCreditAdded.length) {
      const after = [...(head.permissions || []), ...out.headCreditAdded];
      await roles.updateOne({ _id: head._id }, { $set: { permissions: after, updatedAt: new Date() } });
      await audit.record({ actor: null, action: 'role.update', description: `Role ${head.name}: ${out.headCreditAdded.join(', ')} added (${NOTE})`, entity: 'Role', entityId: String(head._id), before: { permissions: head.permissions }, after: { permissions: after } });
    }
  }

  const manager = DEFAULT_ROLES.find((r) => r.code === 'credit_manager');
  if (!(await roles.findOne({ code: 'credit_manager' }))) {
    out.created.push(manager.code);
    if (apply) {
      const now = new Date();
      const { insertedId } = await roles.insertOne({ ...manager, active: true, createdAt: now, updatedAt: now });
      await audit.record({ actor: null, action: 'role.create', description: `Role ${manager.name} created (${NOTE})`, entity: 'Role', entityId: String(insertedId), after: { permissions: manager.permissions } });
    }
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
      console.log(`Head of Credit permissions that ${verb} added: ${r.headCreditAdded.join(', ') || 'none (already there)'}.`);
      console.log(`Roles that ${verb} created: ${r.created.join(', ') || 'none (already there)'}.`);
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run };

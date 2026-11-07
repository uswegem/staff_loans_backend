'use strict';

// Dry-run by default. Back up the database before using --apply.
// Links existing authentication accounts to HR usernames by immutable staffId.
const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const Staff = require('../src/models/Staff');
const User = require('../src/models/User');

async function main() {
  const apply = process.argv.includes('--apply');
  await connect(config.mongoUri);
  const users = await User.find().lean();
  const staff = await Staff.find({ _id: { $in: users.map((u) => u.staffId) } }).lean();
  const byId = new Map(staff.map((s) => [String(s._id), s]));
  const seen = new Map();
  const changes = [];
  const errors = [];
  for (const user of users) {
    const person = byId.get(String(user.staffId));
    const name = person?.userName?.trim().toLowerCase();
    if (!person || !name || !/^[a-z][a-z0-9._-]{2,63}$/.test(name)) {
      errors.push(`Missing or invalid username for user ${user.staffNo}`);
      continue;
    }
    if (seen.has(name)) errors.push(`Username collision between ${seen.get(name)} and ${user.staffNo}`);
    seen.set(name, user.staffNo);
    if (user.userName && user.userName !== name) errors.push(`Existing username mismatch for ${user.staffNo}`);
    if (!user.userName) changes.push({ id: user._id, staffNo: user.staffNo, userName: name });
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', users: users.length, changes: changes.map(({ staffNo, userName }) => ({ staffNo, userName })), errors }, null, 2));
  if (errors.length) throw new Error('Username migration blocked: resolve all errors before retrying.');
  if (apply && changes.length) {
    await mongoose.connection.transaction(async (session) => {
      for (const change of changes) {
        // eslint-disable-next-line no-await-in-loop
        await User.updateOne({ _id: change.id, userName: { $exists: false } }, { $set: { userName: change.userName } }, { session });
      }
    });
  }
}
main().then(() => mongoose.disconnect()).catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  await mongoose.disconnect();
  process.exitCode = 1;
});

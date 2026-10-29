'use strict';

// Local passwords hashed with bcrypt (ported from the pre-save hook in
// Ess-Backend/src/models/User.js, commit 522bdbd). Implements the
// credentialProvider interface.

const bcrypt = require('bcryptjs');
const { config } = require('../../config/env');
const policy = require('./passwordPolicy');
const { badRequest } = require('../../utils/errors');

async function hash(password) {
  return bcrypt.hash(password, config.bcryptRounds);
}

module.exports = {
  name: 'local',
  supportsPasswordChange: true,

  async verify(user, password) {
    if (!user.passwordHash || typeof password !== 'string') return false;
    return bcrypt.compare(password, user.passwordHash);
  },

  /** Sets a new password on the user document (caller saves). Enforces policy and history. */
  async setPassword(user, newPassword, { skipHistory = false } = {}) {
    const errors = policy.check(newPassword, { staffNo: user.staffNo });
    if (errors.length) throw badRequest('The new password does not meet the password policy.', { password: errors }, 'PASSWORD_POLICY');
    if (!skipHistory) {
      const previous = [user.passwordHash, ...(user.passwordHistory || [])].filter(Boolean).slice(0, policy.HISTORY);
      for (const h of previous) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(newPassword, h)) {
          throw badRequest('The new password does not meet the password policy.', { password: [`Do not reuse any of your last ${policy.HISTORY} passwords.`] }, 'PASSWORD_POLICY');
        }
      }
    }
    if (user.passwordHash) user.passwordHistory = [user.passwordHash, ...(user.passwordHistory || [])].slice(0, policy.HISTORY - 1);
    user.passwordHash = await hash(newPassword);
    user.passwordChangedAt = new Date();
  },

  hash,
};

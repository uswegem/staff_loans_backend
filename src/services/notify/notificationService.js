'use strict';

// Notification service (BRD 12, prompt 4.6). Only the in-app channel exists; email or
// SMS can be added later by registering another channel, without changing callers.
// A channel implements: name, send(recipientUserIds, message, { session }).

const Notification = require('../../models/Notification');
const User = require('../../models/User');
const rbac = require('../rbac/rbacService');
const { identify } = require('../../i18n');

const inApp = {
  name: 'in_app',
  async send(userIds, message, { session } = {}) {
    if (!userIds.length) return;
    // D-109: kept as code and params, rendered in the reader's language when read. The
    // English text stays as the record of what was sent.
    const coded = message.code ? { code: message.code, params: message.params || {} } : identify(message.text) || {};
    await Notification.insertMany(
      userIds.map((userId) => ({ userId, ...message, code: coded.code, params: coded.params })),
      { session }
    );
  },
};

const channels = [inApp];

function registerChannel(channel) {
  if (!channel.name || typeof channel.send !== 'function') throw new Error('A channel needs name and send()');
  channels.push(channel);
}

/**
 * Sends one message to users. message: { type, text, href?, entity?, entityId? }.
 * Duplicate and excluded recipients are dropped.
 */
async function notifyUsers(userIds, message, { exclude = [], session } = {}) {
  const skip = new Set(exclude.map(String));
  const ids = [...new Set(userIds.map(String))].filter((id) => !skip.has(id));
  for (const ch of channels) {
    // eslint-disable-next-line no-await-in-loop
    await ch.send(ids, message, { session });
  }
  return ids;
}

/** Notifies every active user who holds a permission (e.g. all checkers, FR-59). */
async function notifyPermission(permission, message, opts = {}) {
  const holderIds = await rbac.holdersOf(permission, { session: opts.session });
  const active = await User.find({ _id: { $in: holderIds }, status: 'active' }).select('_id').session(opts.session || null).lean();
  return notifyUsers(active.map((u) => u._id), message, opts);
}

module.exports = { notifyUsers, notifyPermission, registerChannel };

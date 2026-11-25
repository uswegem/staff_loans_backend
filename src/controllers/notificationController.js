'use strict';

// The signed-in user's inbox. Users only ever see their own notifications.

const Notification = require('../models/Notification');
const { notFound } = require('../utils/errors');
const { translate, render } = require('../i18n');

// Stored as code and params, rendered in the reader's language when read (D-94, D-109).
// Notifications kept before codes were stored are matched from their English text.
const textOf = (n, lang) => (n.code && render(n.code, n.params, lang)) || translate(n.text, lang);
const view = (n, lang) => ({ id: String(n._id), type: n.type, code: n.code || null, params: n.params || {}, text: textOf(n, lang), href: n.href, read: !!n.readAt, createdAt: n.createdAt });

const NotificationController = {
  async list(req, res) {
    const { unread, limit } = req.query;
    const filter = { userId: req.auth.user._id, ...(unread && { readAt: null }) };
    const [items, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ userId: req.auth.user._id, readAt: null }),
    ]);
    res.json({ success: true, data: { items: items.map((n) => view(n, req.lang)), unread: unreadCount } });
  },

  async unreadCount(req, res) {
    res.json({ success: true, data: { unread: await Notification.countDocuments({ userId: req.auth.user._id, readAt: null }) } });
  },

  async markRead(req, res) {
    const n = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.auth.user._id }, { $set: { readAt: new Date() } }, { new: true });
    if (!n) throw notFound('Notification not found.');
    res.json({ success: true, data: view(n, req.lang) });
  },

  async markAllRead(req, res) {
    await Notification.updateMany({ userId: req.auth.user._id, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ success: true, message: 'All marked as read.' });
  },
};

module.exports = NotificationController;

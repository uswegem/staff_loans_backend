'use strict';

// The signed-in user's inbox. Users only ever see their own notifications.

const Notification = require('../models/Notification');
const { notFound } = require('../utils/errors');
const { translate } = require('../i18n');

// The text is stored in English and shown in the reader's language (D-94).
const view = (n, lang) => ({ id: String(n._id), type: n.type, text: translate(n.text, lang), href: n.href, read: !!n.readAt, createdAt: n.createdAt });

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

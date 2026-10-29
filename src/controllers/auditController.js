'use strict';

// Read-only audit log (BRD NFR-05, RP-10). There is no write, update or delete route.

const AuditLog = require('../models/AuditLog');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const AuditController = {
  async list(req, res) {
    const { q, action, actorId, entity, entityId, from, to, page, limit } = req.query;
    const filter = {};
    if (action) filter.action = new RegExp(`^${escapeRe(action)}`);
    if (actorId) filter.actorId = actorId;
    if (entity) filter.entity = entity;
    if (entityId) filter.entityId = entityId;
    if (from || to) filter.at = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    if (q) {
      const re = new RegExp(escapeRe(q), 'i');
      filter.$or = [{ description: re }, { action: re }, { actorStaffNo: re }, { appRef: re }];
    }
    const [total, items] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    res.json({ success: true, data: { items, total, page, limit } });
  },
};

module.exports = AuditController;

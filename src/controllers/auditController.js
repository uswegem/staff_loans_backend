'use strict';

// Read-only audit log (BRD NFR-05, RP-10). There is no write, update or delete route.

const AuditLog = require('../models/AuditLog');
const Staff = require('../models/Staff');
const { escapeRe, auditFilter } = require('../services/audit/auditQuery');

const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(' ');

const AuditController = {
  async list(req, res) {
    const { q, action, actor, actorId, entity, entityId, from, to, page, limit } = req.query;
    const filter = auditFilter({ q, action, actor });
    if (actorId) filter.actorId = actorId;
    if (entity) filter.entity = entity;
    if (entityId) filter.entityId = entityId;
    if (from || to) filter.at = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const [total, items] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    // Names for the people on this page, so the log reads "Juma Kassim (LFB0233)". Display only.
    const staffNos = [...new Set(items.map((e) => e.actorStaffNo).filter(Boolean))];
    const people = await Staff.find({ staffNo: { $in: staffNos } }).select('staffNo firstName lastName').lean();
    const names = new Map(people.map((s) => [s.staffNo, fullName(s)]));
    const withNames = items.map((e) => ({ ...e, actorName: names.get(e.actorStaffNo) || null }));
    res.json({ success: true, data: { items: withNames, total, page, limit } });
  },

  /** People to filter the log by: staff records matching a name or staff number. */
  async people(req, res) {
    const filter = {};
    if (req.query.q) {
      const re = new RegExp(escapeRe(req.query.q), 'i');
      filter.$or = [{ firstName: re }, { lastName: re }, { staffNo: re }];
    }
    const rows = await Staff.find(filter).select('staffNo firstName lastName').sort({ staffNo: 1 }).limit(20).lean();
    res.json({ success: true, data: rows.map((s) => ({ staffNo: s.staffNo, name: fullName(s) })) });
  },
};

module.exports = AuditController;

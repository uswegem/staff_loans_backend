'use strict';

// OPS disbursements (FR-20 to FR-22) and the disbursed loans register (FR-26).

const disbursements = require('../services/disbursement/disbursementService');
const audit = require('../services/audit/auditService');
const { localDay } = require('../utils/dates');

const BOM = String.fromCharCode(0xfeff); // so Excel reads the CSV as UTF-8

const DisbursementController = {
  async list(req, res) {
    res.json({ success: true, data: await disbursements.list(req, req.query) });
  },

  async get(req, res) {
    res.json({ success: true, data: await disbursements.detail(req, req.params.id) });
  },

  async confirm(req, res) {
    const data = await disbursements.confirm(req, req.params.id, req.body);
    res.json({ success: true, message: `${data.ref} disbursed. Journey complete.`, data });
  },

  async registerCsv(req, res) {
    const csv = await disbursements.registerCsv(req.query);
    await audit.record({ req, action: 'report.export', description: `Disbursed loans register exported (CSV)${req.query.from || req.query.to ? `, ${req.query.from || '…'} to ${req.query.to || '…'}` : ''}`, entity: 'Report', entityId: 'disbursed' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="disbursed-loans-register-${localDay()}.csv"`);
    res.send(BOM + csv);
  },
};

module.exports = DisbursementController;

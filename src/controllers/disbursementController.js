'use strict';

// OPS disbursements (FR-20 to FR-22) and the disbursed loans register (FR-26).

const disbursements = require('../services/disbursement/disbursementService');
const audit = require('../services/audit/auditService');
const reports = require('../services/reports/reportsService');
const { toCsv } = require('../services/reports/exporters');
const { localDay } = require('../utils/dates');


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

  /** RP-04 as CSV: the same builder as the Reports screen, so FR-55 holds here too. */
  async registerCsv(req, res) {
    const report = await reports.build(req, 'disbursed', req.query, { forExport: true });
    await audit.record({ req, action: 'report.export', description: `${report.id} ${report.name} exported (CSV, ${report.rows.length} rows)`, entity: 'Report', entityId: 'disbursed', after: { filters: report.filters, rows: report.rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="disbursed-loans-register-${localDay()}.csv"`);
    res.send(toCsv(report));
  },
};

module.exports = DisbursementController;

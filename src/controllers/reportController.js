'use strict';

// Reports (BRD 12; RP-01 to RP-07, RP-10) on screen and as CSV, Excel and PDF. The
// screen and the exports use one builder, so FR-55 applies to both (prompt 4).

const reports = require('../services/reports/reportsService');
const { FORMATS } = require('../services/reports/exporters');
const audit = require('../services/audit/auditService');
const { localDay } = require('../utils/dates');

const ReportController = {
  async catalogue(req, res) {
    res.json({ success: true, data: { reports: reports.catalogue(req), options: await reports.filterOptions() } });
  },

  async overview(req, res) {
    res.json({ success: true, data: await reports.overview(req) });
  },

  async show(req, res) {
    const data = await reports.build(req, req.params.key, req.query);
    res.json({ success: true, data });
  },

  async export(req, res) {
    const fmt = FORMATS[req.params.format];
    const report = await reports.build(req, req.params.key, req.query, { forExport: true });
    const body = await fmt.build(report);
    await audit.record({
      req,
      action: 'report.export',
      description: `${report.id} ${report.name} exported (${fmt.ext.toUpperCase()}, ${report.rows.length} rows${report.limitedCount ? `, ${report.limitedCount} limited` : ''})`,
      entity: 'Report',
      entityId: req.params.key,
      after: { filters: report.filters, rows: report.rows.length },
    });
    res.setHeader('Content-Type', fmt.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}-${localDay()}.${fmt.ext}"`);
    res.send(body);
  },
};

module.exports = ReportController;

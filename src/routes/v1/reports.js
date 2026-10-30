'use strict';

const express = require('express');
const Joi = require('joi');
const ReportController = require('../../controllers/reportController');
const { requireAny } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');
const { REPORTS } = require('../../services/reports/reportsService');

const router = express.Router();
const isRealDay = (v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const day = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((v, h) => (isRealDay(v) ? v : h.message('Enter a real date as YYYY-MM-DD.')))
  .messages({ 'string.pattern.base': 'Enter dates as YYYY-MM-DD.' });
const REPORT_PERMS = ['reports.view', 'disb.confirm', 'admin.users', 'admin.roles', 'audit.view'];
const key = Joi.string().valid(...Object.keys(REPORTS)).required();
const filters = Joi.object({
  from: day,
  to: day,
  productId: Joi.string().hex().length(24),
  department: Joi.string().trim().max(80),
  station: Joi.string().trim().max(80),
  category: Joi.string().valid('Management', 'Non-management'),
  status: Joi.string().max(40).pattern(/^[a-z_]+$/),
  groupBy: Joi.string().valid('product', 'branch', 'category'),
  q: Joi.string().trim().max(80).allow(''),
  action: Joi.string().max(60).pattern(/^[a-z._]+$/),
});

/**
 * @openapi
 * /reports:
 *   get: { tags: [Reports], summary: "Reports this user may open, and filter values", security: [{ bearer: [] }], responses: { 200: { description: Catalogue } } }
 * /reports/overview:
 *   get: { tags: [Reports], summary: "Dashboard figures: in review, overdue, pending disbursement, outside SLA, time per stage, disbursed by product", security: [{ bearer: [] }], responses: { 200: { description: Overview } } }
 * /reports/{key}:
 *   get: { tags: [Reports], summary: "One report on screen (RP-01 to RP-07, RP-10) with filters; FR-55 applied", security: [{ bearer: [] }], responses: { 200: { description: Columns and rows } } }
 * /reports/{key}/export/{format}:
 *   get: { tags: [Reports], summary: "Export as csv, xlsx or pdf; same rows as the screen; audited", security: [{ bearer: [] }], responses: { 200: { description: File } } }
 */
router.get('/reports', requireAny(...REPORT_PERMS), asyncHandler(ReportController.catalogue));
router.get('/reports/overview', requireAny('reports.view'), asyncHandler(ReportController.overview));
router.get('/reports/:key', requireAny(...REPORT_PERMS), validate({ params: Joi.object({ key }), query: filters }), asyncHandler(ReportController.show));
router.get(
  '/reports/:key/export/:format',
  requireAny(...REPORT_PERMS),
  validate({ params: Joi.object({ key, format: Joi.string().valid('csv', 'xlsx', 'pdf').required() }), query: filters }),
  asyncHandler(ReportController.export)
);

module.exports = router;

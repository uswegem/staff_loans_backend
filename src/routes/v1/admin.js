'use strict';

const express = require('express');
const Joi = require('joi');
const SettingsController = require('../../controllers/settingsController');
const AuditController = require('../../controllers/auditController');
const { requireAll } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);


/**
 * @openapi
 * /admin/settings:
 *   get: { tags: [Admin], summary: "Workflow targets, working calendar, holidays", security: [{ bearer: [] }], responses: { 200: { description: Settings } } }
 *   put: { tags: [Admin], summary: Change workflow settings (audited), security: [{ bearer: [] }], responses: { 200: { description: Saved } } }
 * /admin/holidays:
 *   post: { tags: [Admin], summary: Add a public holiday, security: [{ bearer: [] }], responses: { 201: { description: Added } } }
 * /admin/holidays/{id}:
 *   delete: { tags: [Admin], summary: Remove a public holiday, security: [{ bearer: [] }], responses: { 200: { description: Removed } } }
 * /audit:
 *   get: { tags: [Audit], summary: Read-only audit log with filters (RP-10), security: [{ bearer: [] }], responses: { 200: { description: Entries } } }
 */
router.get('/admin/settings', requireAll('admin.workflow'), asyncHandler(SettingsController.get));
router.put(
  '/admin/settings',
  requireAll('admin.workflow'),
  validate({
    body: Joi.object({
      stageTargetHours: Joi.number().integer().min(1).max(200),
      ceoTargetHours: Joi.number().integer().min(1).max(500),
      workingDays: Joi.array().items(Joi.number().integer().min(0).max(6)).unique(),
      dayStartMinutes: Joi.number().integer().min(0).max(1439),
      dayEndMinutes: Joi.number().integer().min(1).max(1440),
      revisedTermsExpiryDays: Joi.number().integer().min(1).max(90),
      approvalSlaDays: Joi.number().integer().min(1).max(365),
      probationMonths: Joi.number().integer().min(0).max(24),
      maxUploadMb: Joi.number().integer().min(1).max(50),
      firstDueDay: Joi.number().integer().min(1).max(31),
      inactivityTimeoutMin: Joi.number().integer().min(1).max(240),
      lockoutThreshold: Joi.number().integer().min(3).max(10),
      payslipMaxAgeDays: Joi.number().integer().min(1).max(120),
      retirementAge: Joi.number().integer().min(40).max(75),
      retirementBufferDays: Joi.number().integer().min(0).max(365),
      dobMinAge: Joi.number().integer().min(14).max(30),
      dobMaxAge: Joi.number().integer().min(40).max(75),
      payslipRules: Joi.object({
        basicLabels: Joi.array().items(Joi.string().trim().min(2).max(40)).min(1).max(20),
        lfbLabels: Joi.array().items(Joi.string().trim().min(2).max(40)).min(1).max(20),
        dateLabels: Joi.array().items(Joi.string().trim().min(2).max(40)).min(1).max(20),
      }),
    }).min(1),
  }),
  asyncHandler(SettingsController.update)
);
router.post(
  '/admin/holidays',
  requireAll('admin.workflow'),
  validate({ body: Joi.object({ date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(), name: Joi.string().trim().min(2).max(80).required() }) }),
  asyncHandler(SettingsController.addHoliday)
);
router.delete('/admin/holidays/:id', requireAll('admin.workflow'), validate({ params: Joi.object({ id: objectId.required() }) }), asyncHandler(SettingsController.removeHoliday));

router.get(
  '/audit',
  requireAll('audit.view'),
  validate({
    query: Joi.object({
      q: Joi.string().max(80).allow(''),
      action: Joi.string().max(60).pattern(/^[a-z._]+$/),
      actorId: objectId,
      entity: Joi.string().max(40),
      entityId: Joi.string().max(40),
      from: Joi.date().iso(),
      to: Joi.date().iso(),
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(AuditController.list)
);

module.exports = router;

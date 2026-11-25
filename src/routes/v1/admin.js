'use strict';

const express = require('express');
const Joi = require('joi');
const SettingsController = require('../../controllers/settingsController');
const AuditController = require('../../controllers/auditController');
const { requireAll } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const multer = require('multer');
const brand = require('../../services/agreement/brandAssets');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);


/**
 * @openapi
 * /admin/settings:
 *   get: { tags: [Admin], summary: "Workflow targets, working calendar, holidays", security: [{ bearer: [] }], responses: { 200: { description: Settings } } }
 *   put: { tags: [Admin], summary: Change workflow settings (audited), security: [{ bearer: [] }], responses: { 200: { description: Saved } } }
 * /admin/settings/agreement-logo:
 *   get: { tags: [Admin], summary: "The logo printed on agreements and repayment schedules: default or replaced (D-110)", security: [{ bearer: [] }], responses: { 200: { description: Logo information } } }
 *   put: { tags: [Admin], summary: "Replace the agreement logo: PNG or JPG, up to 1 MB, multipart field 'file' (audited, D-110)", security: [{ bearer: [] }], responses: { 200: { description: Replaced } } }
 *   delete: { tags: [Admin], summary: "Go back to the default LFB logo (audited, D-110)", security: [{ bearer: [] }], responses: { 200: { description: Default restored } } }
 * /admin/settings/agreement-logo/image:
 *   get: { tags: [Admin], summary: "The logo image in use", security: [{ bearer: [] }], responses: { 200: { description: PNG or JPG } } }
 * /admin/holidays:
 *   post: { tags: [Admin], summary: Add a public holiday, security: [{ bearer: [] }], responses: { 201: { description: Added } } }
 * /admin/holidays/{id}:
 *   delete: { tags: [Admin], summary: Remove a public holiday, security: [{ bearer: [] }], responses: { 200: { description: Removed } } }
 * /audit:
 *   get: { tags: [Audit], summary: Read-only audit log with filters (RP-10), security: [{ bearer: [] }], responses: { 200: { description: Entries } } }
 * /audit/people:
 *   get: { tags: [Audit], summary: Staff to filter the audit log by (name or staff number), security: [{ bearer: [] }], responses: { 200: { description: People } } }
 */
router.get('/admin/settings', requireAll('admin.workflow'), asyncHandler(SettingsController.get));
// D-110: the agreement logo (System Administrator).
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 + 1, files: 1 } }).single('file');
router.get('/admin/settings/agreement-logo', requireAll('admin.workflow'), asyncHandler(async (req, res) => res.json({ success: true, data: await brand.logoInfo() })));
router.get('/admin/settings/agreement-logo/image', requireAll('admin.workflow'), asyncHandler(async (req, res) => {
  const bytes = await brand.logoBytes();
  res.set('Content-Type', bytes[0] === 0x89 ? 'image/png' : 'image/jpeg');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
}));
router.put('/admin/settings/agreement-logo', requireAll('admin.workflow'), (req, res, next) => logoUpload(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, code: 'FILE_TOO_LARGE', message: 'The logo must be 1 MB or smaller.' });
  return next(err);
}), asyncHandler(async (req, res) => res.json({ success: true, message: 'Agreement logo replaced.', data: await brand.replaceLogo(req, req.file) })));
router.delete('/admin/settings/agreement-logo', requireAll('admin.workflow'), asyncHandler(async (req, res) => res.json({ success: true, message: 'Agreement logo set back to the default.', data: await brand.resetLogo(req) })));
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
      action: Joi.string().max(300).pattern(/^[a-z._,]+$/),
      actor: Joi.string().trim().max(20).pattern(/^[A-Za-z0-9-]+$/),
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
router.get(
  '/audit/people',
  requireAll('audit.view'),
  validate({ query: Joi.object({ q: Joi.string().trim().max(80).allow('') }) }),
  asyncHandler(AuditController.people)
);

module.exports = router;

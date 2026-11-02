'use strict';

const express = require('express');
const Joi = require('joi');
const TemplateController = require('../../controllers/templateController');
const { requireAll, requireAny } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const idParams = { params: Joi.object({ id: Joi.string().hex().length(24).required() }) };
const text = Joi.string().max(200000).required().messages({ 'any.required': 'Add the agreement text.', 'string.empty': 'Add the agreement text.' });
const version = Joi.string().trim().pattern(/^\d{4}\.\d{1,2}[a-z]?$/).messages({ 'string.pattern.base': 'Use a version like 2027.01.' });
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const VIEW = ['admin.templates', 'templates.approve'];

/**
 * @openapi
 * /admin/templates:
 *   get: { tags: [Admin], summary: "Agreement template versions with their Legal approval status (FR-40, D-88)", security: [{ bearer: [] }], responses: { 200: { description: Versions } } }
 *   post: { tags: [Admin], summary: "Legal Officer uploads a version; Pending Legal Approval; audited", security: [{ bearer: [] }], responses: { 201: { description: Pending } } }
 * /admin/templates/preview:
 *   post: { tags: [Admin], summary: "Render template text with a fictional applicant", security: [{ bearer: [] }], responses: { 200: { description: Blocks } } }
 * /admin/templates/{id}:
 *   get: { tags: [Admin], summary: "One version with its text and a sample rendering", security: [{ bearer: [] }], responses: { 200: { description: Version } } }
 *   put: { tags: [Admin], summary: "Legal Officer edits; an approved version becomes a new version pending approval", security: [{ bearer: [] }], responses: { 200: { description: Pending } } }
 * /admin/templates/{id}/approve:
 *   post: { tags: [Admin], summary: "Head of Legal approves; not the uploader or an editor; audited", security: [{ bearer: [] }], responses: { 200: { description: Approved }, 403: { description: Own version } } }
 * /admin/templates/{id}/reject:
 *   post: { tags: [Admin], summary: "Head of Legal rejects with a reason; audited", security: [{ bearer: [] }], responses: { 200: { description: Rejected }, 400: { description: No reason } } }
 */
router.get('/admin/templates', requireAny(...VIEW), asyncHandler(TemplateController.list));
router.post('/admin/templates/preview', requireAny(...VIEW), validate({ body: Joi.object({ body: text }) }), asyncHandler(TemplateController.preview));
router.get('/admin/templates/:id', requireAny(...VIEW), validate(idParams), asyncHandler(TemplateController.get));
router.post(
  '/admin/templates',
  requireAll('admin.templates'),
  validate({ body: Joi.object({ version: version.required().messages({ 'any.required': 'Enter the version.' }), effectiveFrom: day.required().messages({ 'any.required': 'Enter the date it is used from.' }), body: text, note: Joi.string().trim().max(500).allow('') }) }),
  asyncHandler(TemplateController.upload)
);
router.put(
  '/admin/templates/:id',
  requireAll('admin.templates'),
  validate({ ...idParams, body: Joi.object({ version, effectiveFrom: day, body: text, note: Joi.string().trim().max(500).allow('') }) }),
  asyncHandler(TemplateController.edit)
);
router.post('/admin/templates/:id/approve', requireAll('templates.approve'), validate(idParams), asyncHandler(TemplateController.approve));
router.post('/admin/templates/:id/reject', requireAll('templates.approve'), validate({ ...idParams, body: Joi.object({ reason: Joi.string().trim().max(500).allow('').default('') }) }), asyncHandler(TemplateController.reject));

module.exports = router;

'use strict';

const express = require('express');
const Joi = require('joi');
const TemplateController = require('../../controllers/templateController');
const { requireAll } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const text = Joi.string().max(200000).required().messages({ 'any.required': 'Add the agreement text.', 'string.empty': 'Add the agreement text.' });

/**
 * @openapi
 * /admin/templates:
 *   get: { tags: [Admin], summary: "Agreement template versions: current, scheduled and retired, with agreement counts (FR-40)", security: [{ bearer: [] }], responses: { 200: { description: Versions } } }
 *   post: { tags: [Admin], summary: "Load a new version after Legal approval; checked by rendering a sample; audited", security: [{ bearer: [] }], responses: { 201: { description: Loaded }, 400: { description: Invalid text or no Legal approval } } }
 * /admin/templates/preview:
 *   post: { tags: [Admin], summary: "Render template text with a fictional applicant", security: [{ bearer: [] }], responses: { 200: { description: Blocks } } }
 * /admin/templates/{id}:
 *   get: { tags: [Admin], summary: "One version with its text and a sample rendering", security: [{ bearer: [] }], responses: { 200: { description: Version } } }
 */
router.get('/admin/templates', requireAll('admin.templates'), asyncHandler(TemplateController.list));
router.post('/admin/templates/preview', requireAll('admin.templates'), validate({ body: Joi.object({ body: text }) }), asyncHandler(TemplateController.preview));
router.get('/admin/templates/:id', requireAll('admin.templates'), validate({ params: Joi.object({ id: Joi.string().hex().length(24).required() }) }), asyncHandler(TemplateController.get));
router.post(
  '/admin/templates',
  requireAll('admin.templates'),
  validate({
    body: Joi.object({
      version: Joi.string().trim().pattern(/^\d{4}\.\d{1,2}[a-z]?$/).required().messages({ 'string.pattern.base': 'Use a version like 2027.01.', 'any.required': 'Enter the version.' }),
      effectiveFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().messages({ 'any.required': 'Enter the date it is used from.' }),
      body: text,
      legalApproved: Joi.boolean().required(),
      legalApprovalRef: Joi.string().trim().max(120).allow(''),
      note: Joi.string().trim().max(500).allow(''),
    }),
  }),
  asyncHandler(TemplateController.load)
);

module.exports = router;

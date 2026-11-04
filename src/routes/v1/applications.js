'use strict';

const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const ApplicationController = require('../../controllers/applicationController');
const { requireAll } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { badRequest, asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);
const idParams = { params: Joi.object({ id: objectId.required() }) };
const money = Joi.number().integer().min(0).max(10_000_000_000);

// Documents: PDF, JPG, PNG (checked again by content). The per-file size limit is the
// configurable setting; 50 MB is the absolute ceiling here.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/\.(pdf|jpe?g|png)$/i.test(file.originalname) ? cb(null, true) : cb(badRequest('Only PDF, JPG and PNG files can be uploaded.', { file: ['Only PDF, JPG and PNG files can be uploaded.'] }, 'FILE_TYPE'))),
});
const uploadOne = (req, res, next) => upload.single('file')(req, res, (err) => next(err && err.code === 'LIMIT_FILE_SIZE' ? badRequest('The file is too large.', { file: ['The file is too large.'] }, 'FILE_TOO_LARGE') : err));

/**
 * @openapi
 * /applications:
 *   get: { tags: [Applications], summary: "My applications (FR-11)", security: [{ bearer: [] }], responses: { 200: { description: List } } }
 *   post: { tags: [Applications], summary: "Start a draft for a product; refused with the reason when not eligible (FR-05, BR-01, BR-02, BR-07, BR-08, NS-02)", security: [{ bearer: [] }], responses: { 201: { description: Draft with checks and calculator inputs } } }
 * /applications/{id}:
 *   get: { tags: [Applications], summary: "My application with route, history, checks and quote", security: [{ bearer: [] }], responses: { 200: { description: Application } } }
 *   patch: { tags: [Applications], summary: "Change the request while a draft or returned (FR-06)", security: [{ bearer: [] }], responses: { 200: { description: Application with fresh checks } } }
 * /applications/{id}/agreement/preview:
 *   get: { tags: [Applications], summary: "The Swahili agreement for these terms, with schedule and text fingerprint (FR-33)", security: [{ bearer: [] }], responses: { 200: { description: Blocks and SHA-256 }, 400: { description: Hard rules fail } } }
 * /applications/{id}/sign-and-submit:
 *   post: { tags: [Applications], summary: "Consents, acceptance tick, password and the fingerprint read; signing submits (FR-10, FR-34, FR-35, FR-37)", security: [{ bearer: [] }], responses: { 200: { description: Submitted }, 401: { description: Wrong password }, 409: { description: Agreement changed } } }
 * /applications/{id}/withdraw:
 *   post: { tags: [Applications], summary: "Withdraw before final approval; voids the agreement (FR-11)", security: [{ bearer: [] }], responses: { 200: { description: Withdrawn } } }
 * /applications/{id}/documents:
 *   post: { tags: [Applications], summary: "Attach an optional document: PDF, JPG or PNG (FR-09)", security: [{ bearer: [] }], responses: { 201: { description: Document } } }
 * /applications/{id}/payslip:
 *   post: { tags: [Applications], summary: "Attach the latest payslip PDF; Basic Pay, LFB deductions and pay date are read from it (D-78, D-79)", security: [{ bearer: [] }], responses: { 201: { description: Application with the payslip figures }, 400: { description: Payslip not readable, not yours, or not a PDF } } }
 * /applications/{id}/documents/{fileId}:
 *   delete: { tags: [Applications], summary: "Remove a document from a draft or returned application", security: [{ bearer: [] }], responses: { 200: { description: Removed } } }
 * /files/{id}:
 *   get: { tags: [Applications], summary: "Download my document or agreement PDF (audited)", security: [{ bearer: [] }], responses: { 200: { description: File } } }
 * /agreements/{id}:
 *   get: { tags: [Applications], summary: "My signed agreement: text, schedule and acceptance evidence (FR-25)", security: [{ bearer: [] }], responses: { 200: { description: Agreement } } }
 * /agreements/{id}/pdf:
 *   get: { tags: [Applications], summary: "The locked PDF (FR-37)", security: [{ bearer: [] }], responses: { 200: { description: PDF } } }
 */
router.get('/applications', requireAll('loan.viewOwn'), asyncHandler(ApplicationController.list));
router.post('/applications', requireAll('loan.apply'), validate({ body: Joi.object({ productId: objectId.required() }) }), asyncHandler(ApplicationController.create));
router.get('/applications/:id', requireAll('loan.viewOwn'), validate(idParams), asyncHandler(ApplicationController.get));
router.patch(
  '/applications/:id',
  requireAll('loan.apply'),
  validate({
    ...idParams,
    body: Joi.object({
      amount: money.allow(null),
      tenor: Joi.number().integer().min(0).max(600).allow(null),
      purpose: Joi.string().trim().max(500).allow(''),
      productFields: Joi.object().pattern(/^[a-z][a-zA-Z0-9]{0,30}$/, Joi.alternatives(Joi.string().trim().max(500).allow(''), Joi.number(), Joi.boolean())).max(20),
      repaymentMethod: Joi.string().valid('payroll').messages({ 'any.only': 'Salary deduction is the only repayment method.' }), // D-84
      // D-87: a top-up names one of the applicant's SLAS loans; its instalment comes from SLAS.
      // D-101: a top-up names the payslip line topped up (when the payslip shows several), not a SLAS loan.
      topUp: Joi.object({ on: Joi.boolean().required(), applicationId: objectId.allow(null), payslipLine: Joi.object({ label: Joi.string().trim().max(120).required(), amount: money.required() }).allow(null) }),
      probationReason: Joi.string().trim().max(1000).allow(''),
    }).min(1),
  }),
  asyncHandler(ApplicationController.update)
);
router.get('/applications/:id/agreement/preview', requireAll('loan.apply'), validate(idParams), asyncHandler(ApplicationController.preview));
router.post(
  '/applications/:id/sign-and-submit',
  requireAll('loan.apply'),
  validate({
    ...idParams,
    body: Joi.object({
      consents: Joi.object({ truth: Joi.boolean(), deduct: Joi.boolean(), crb: Joi.boolean(), sms: Joi.boolean() }).required(),
      accepted: Joi.boolean().required(),
      scrolledToEnd: Joi.boolean().required(),
      password: Joi.string().max(128).required(),
      textSha256: Joi.string().hex().length(64).required(),
    }),
  }),
  asyncHandler(ApplicationController.signAndSubmit)
);
router.post('/applications/:id/withdraw', requireAll('loan.viewOwn'), validate({ ...idParams, body: Joi.object({ reason: Joi.string().trim().max(500).allow('') }) }), asyncHandler(ApplicationController.withdraw));
router.post('/applications/:id/documents', requireAll('loan.apply'), validate(idParams), uploadOne, asyncHandler(ApplicationController.addDocument));
router.post('/applications/:id/payslip', requireAll('loan.apply'), validate(idParams), uploadOne, asyncHandler(ApplicationController.setPayslip));
router.delete('/applications/:id/documents/:fileId', requireAll('loan.apply'), validate({ params: Joi.object({ id: objectId.required(), fileId: objectId.required() }) }), asyncHandler(ApplicationController.removeDocument));
router.get('/files/:id', validate(idParams), asyncHandler(ApplicationController.file));
router.get('/agreements/:id', validate(idParams), asyncHandler(ApplicationController.agreement));
router.get('/agreements/:id/pdf', validate(idParams), asyncHandler(ApplicationController.agreementPdf));

module.exports = router;

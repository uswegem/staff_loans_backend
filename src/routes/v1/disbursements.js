'use strict';

const express = require('express');
const Joi = require('joi');
const DisbursementController = require('../../controllers/disbursementController');
const { requireAll, requireAny } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Enter the date as YYYY-MM-DD.' });

/**
 * @openapi
 * /disbursements:
 *   get: { tags: [Disbursement], summary: "OPS queue: ready to disburse (with Outside SLA flags) or disbursed (FR-20, Q3)", security: [{ bearer: [] }], responses: { 200: { description: Queue } } }
 * /disbursements/register.csv:
 *   get: { tags: [Disbursement], summary: "Disbursed loans register as CSV (FR-26); audited", security: [{ bearer: [] }], responses: { 200: { description: CSV } } }
 * /disbursements/{id}:
 *   get: { tags: [Disbursement], summary: "Loan summary for disbursement and recovery set-up", security: [{ bearer: [] }], responses: { 200: { description: Summary } } }
 * /disbursements/{id}/confirm:
 *   post: { tags: [Disbursement], summary: "Confirm disbursement: date, optional reference, comment, checklist; regenerates the schedule (FR-20 to FR-22, FR-24)", security: [{ bearer: [] }], responses: { 200: { description: Disbursed }, 403: { description: Own or approved loan (SoD) } } }
 */
router.get(
  '/disbursements',
  requireAll('disb.confirm'),
  validate({ query: Joi.object({ tab: Joi.string().valid('ready', 'done').default('ready'), q: Joi.string().trim().max(100).allow('') }) }),
  asyncHandler(DisbursementController.list)
);
router.get(
  '/disbursements/register.csv',
  requireAny('disb.confirm', 'reports.export'),
  validate({ query: Joi.object({ from: day, to: day }) }),
  asyncHandler(DisbursementController.registerCsv)
);
router.get('/disbursements/:id', requireAll('disb.confirm'), validate({ params: Joi.object({ id: objectId.required() }) }), asyncHandler(DisbursementController.get));
router.post(
  '/disbursements/:id/confirm',
  requireAll('disb.confirm'),
  validate({
    params: Joi.object({ id: objectId.required() }),
    body: Joi.object({
      date: day.required().messages({ 'any.required': 'Enter the disbursement date.' }),
      transactionRef: Joi.string().trim().max(40).pattern(/^[A-Za-z0-9/-]*$/).allow('').messages({ 'string.pattern.base': 'Use letters, digits, / and - only.' }),
      comment: Joi.string().trim().max(1000).allow(''),
      conditions: Joi.array().items(Joi.boolean()).max(50).default([]),
      topUpSettled: Joi.boolean(),
    }),
  }),
  asyncHandler(DisbursementController.confirm)
);

module.exports = router;

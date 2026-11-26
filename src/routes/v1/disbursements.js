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
 *   get: { tags: [Disbursement], summary: "Disbursement queue (D-112): ready to disburse or disbursed, with Outside SLA flags and what the caller may do on each loan (canConfirm, blockedReason, canDownload: false on the caller's own loan, agreementId). OPS, Head of People and Culture and P&C Manager (disb.confirm) (FR-20, Q3)", security: [{ bearer: [] }], responses: { 200: { description: Queue } } }
 * /disbursements/register.csv:
 *   get: { tags: [Disbursement], summary: "Disbursed loans register as CSV, with the comment (FR-26, D-112); audited", security: [{ bearer: [] }], responses: { 200: { description: CSV } } }
 * /disbursements/{id}:
 *   get: { tags: [Disbursement], summary: "Loan details for disbursement and recovery set-up; a booking recorded before D-112 is shown read-only", security: [{ bearer: [] }], responses: { 200: { description: Summary } } }
 * /disbursements/{id}/summary.pdf:
 *   get: { tags: [Disbursement], summary: "Loan Summary PDF (D-112): reference, agreement, staff and crediting account, approved terms, top-up, approval trail and disbursement; one page in the agreement's language; no schedule, CRB or payslip figures. disb.confirm, Pending Disbursement or Disbursed only, not the applicant (403 OWN_LOAN); audited as summary.download", security: [{ bearer: [] }], responses: { 200: { description: PDF }, 403: { description: "Own loan (OWN_LOAN) or no final approval yet (NOT_APPROVED)" }, 404: { description: Not found } } }
 * /disbursements/{id}/confirm:
 *   post: { tags: [Disbursement], summary: "Mark as disbursed (D-112), by OPS or People and Culture (disb.confirm): date (not future, not before final approval), unique transaction reference, comment of 5 to 1000 characters, checklist and top-up settlement; not your own loan nor one you approved (also as a delegate or on whose behalf); regenerates the schedule from the disbursement date; notifies the applicant; audited as loan.disbursed (FR-20 to FR-22, FR-24)", security: [{ bearer: [] }], responses: { 200: { description: Disbursed }, 403: { description: Own or approved loan (SOD_DISBURSE) }, 409: { description: Already disbursed, or reference already used (DUPLICATE_TRANSACTION_REF) } } }
 */
router.get(
  '/disbursements',
  requireAll('disb.confirm'),
  validate({ query: Joi.object({ tab: Joi.string().valid('ready', 'done'), q: Joi.string().trim().max(100).allow('') }) }),
  asyncHandler(DisbursementController.list)
);
router.get(
  '/disbursements/register.csv',
  requireAny('disb.confirm', 'reports.export'),
  validate({ query: Joi.object({ from: day, to: day }) }),
  asyncHandler(DisbursementController.registerCsv)
);
router.get('/disbursements/:id/summary.pdf', requireAll('disb.confirm'), validate({ params: Joi.object({ id: objectId.required() }) }), asyncHandler(DisbursementController.summaryPdf));
router.get('/disbursements/:id', requireAll('disb.confirm'), validate({ params: Joi.object({ id: objectId.required() }) }), asyncHandler(DisbursementController.get));
router.post(
  '/disbursements/:id/confirm',
  requireAll('disb.confirm'),
  validate({
    params: Joi.object({ id: objectId.required() }),
    body: Joi.object({
      date: day.required().messages({ 'any.required': 'Enter the disbursement date.' }),
      transactionRef: Joi.string().trim().min(1).max(40).pattern(/^[A-Za-z0-9/-]+$/).required().messages({ 'any.required': 'Enter the core banking transaction reference.', 'string.empty': 'Enter the core banking transaction reference.' }).messages({ 'string.pattern.base': 'Use letters, digits, / and - only.' }),
      // D-112: required, 5 to 1000 characters.
      comment: Joi.string().trim().min(5).max(1000).required().messages({ 'any.required': 'Add a comment for the disbursement record.', 'string.empty': 'Add a comment for the disbursement record.', 'string.min': 'Add a comment for the disbursement record.' }),
      topUpSettled: Joi.boolean(),
    }),
  }),
  asyncHandler(DisbursementController.confirm)
);

module.exports = router;

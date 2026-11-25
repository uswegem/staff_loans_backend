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
 *   get: { tags: [Disbursement], summary: "Final approval queue: to book (People and Culture), ready to disburse (OPS) or disbursed, with Outside SLA flags and what the caller may do on each loan (FR-20, Q3, D-107)", security: [{ bearer: [] }], responses: { 200: { description: Queue } } }
 * /disbursements/register.csv:
 *   get: { tags: [Disbursement], summary: "Disbursed loans register as CSV (FR-26); audited", security: [{ bearer: [] }], responses: { 200: { description: CSV } } }
 * /disbursements/{id}:
 *   get: { tags: [Disbursement], summary: "Loan summary for disbursement and recovery set-up", security: [{ bearer: [] }], responses: { 200: { description: Summary } } }
 * /disbursements/{id}/book:
 *   post: { tags: [Disbursement], summary: "Book a finally approved loan: core banking loan account number, booking date (not future, not before final approval), optional note; moves it to Pending Disbursement (D-107)", security: [{ bearer: [] }], responses: { 200: { description: Booked }, 403: { description: Own loan (SoD) }, 409: { description: Already booked } } }
 * /disbursements/{id}/confirm:
 *   post: { tags: [Disbursement], summary: "Confirm disbursement: date, mandatory reference, comment, checklist; regenerates the schedule (FR-20 to FR-22, FR-24)", security: [{ bearer: [] }], responses: { 200: { description: Disbursed }, 403: { description: Own or approved loan (SoD) } } }
 */
router.get(
  '/disbursements',
  requireAny('disb.confirm', 'loan.book'),
  validate({ query: Joi.object({ tab: Joi.string().valid('booking', 'ready', 'done'), q: Joi.string().trim().max(100).allow('') }) }),
  asyncHandler(DisbursementController.list)
);
router.get(
  '/disbursements/register.csv',
  requireAny('disb.confirm', 'reports.export'),
  validate({ query: Joi.object({ from: day, to: day }) }),
  asyncHandler(DisbursementController.registerCsv)
);
router.get('/disbursements/:id', requireAny('disb.confirm', 'loan.book'), validate({ params: Joi.object({ id: objectId.required() }) }), asyncHandler(DisbursementController.get));
router.post(
  '/disbursements/:id/book',
  requireAll('loan.book'),
  validate({
    params: Joi.object({ id: objectId.required() }),
    body: Joi.object({
      loanAccountNumber: Joi.string().trim().min(1).max(40).pattern(/^[A-Za-z0-9/-]+$/).required().messages({ 'any.required': 'Enter the core banking loan account number.', 'string.empty': 'Enter the core banking loan account number.', 'string.pattern.base': 'Use letters, digits, / and - only.' }),
      date: day.required().messages({ 'any.required': 'Enter the booking date.' }),
      note: Joi.string().trim().max(1000).allow(''),
    }),
  }),
  asyncHandler(DisbursementController.book)
);
router.post(
  '/disbursements/:id/confirm',
  requireAll('disb.confirm'),
  validate({
    params: Joi.object({ id: objectId.required() }),
    body: Joi.object({
      date: day.required().messages({ 'any.required': 'Enter the disbursement date.' }),
      transactionRef: Joi.string().trim().min(1).max(40).pattern(/^[A-Za-z0-9/-]+$/).required().messages({ 'any.required': 'Enter the core banking transaction reference.', 'string.empty': 'Enter the core banking transaction reference.' }).messages({ 'string.pattern.base': 'Use letters, digits, / and - only.' }),
      comment: Joi.string().trim().max(1000).allow(''),
      topUpSettled: Joi.boolean(),
    }),
  }),
  asyncHandler(DisbursementController.confirm)
);

module.exports = router;

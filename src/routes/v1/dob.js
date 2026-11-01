'use strict';

const express = require('express');
const Joi = require('joi');
const DobController = require('../../controllers/dobController');
const { requireAll } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const idParams = { params: Joi.object({ id: Joi.string().hex().length(24).required() }) };
const dob = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().messages({ 'string.pattern.base': 'Enter the date of birth as YYYY-MM-DD.', 'any.required': 'Enter the date of birth.' });

/**
 * @openapi
 * /dob-verifications:
 *   get: { tags: [Staff], summary: "Dates of birth waiting for People and Culture (or decided ones with ?status=); D-82", security: [{ bearer: [] }], responses: { 200: { description: Changes } } }
 * /dob-verifications/{id}/approve:
 *   post: { tags: [Staff], summary: "Verify a proposed date of birth; not by its submitter or the staff member concerned; audited", security: [{ bearer: [] }], responses: { 200: { description: Verified }, 403: { description: Own submission or own record } } }
 * /dob-verifications/{id}/reject:
 *   post: { tags: [Staff], summary: "Reject a proposed date of birth with a reason; audited", security: [{ bearer: [] }], responses: { 200: { description: Rejected }, 400: { description: No reason } } }
 * /dob-verifications/{id}/withdraw:
 *   post: { tags: [Staff], summary: "The submitter withdraws a pending date of birth", security: [{ bearer: [] }], responses: { 200: { description: Withdrawn } } }
 * /staff/{id}/date-of-birth:
 *   get: { tags: [Staff], summary: "Verified and pending date of birth of a staff record", security: [{ bearer: [] }], responses: { 200: { description: Status } } }
 *   post: { tags: [Staff], summary: "People and Culture propose a date of birth; it waits for verification", security: [{ bearer: [] }], responses: { 201: { description: Pending } } }
 */
router.get('/dob-verifications', requireAll('staff.verifyDob'), validate({ query: Joi.object({ status: Joi.string().valid('pending', 'approved', 'rejected', 'withdrawn').default('pending') }) }), asyncHandler(DobController.list));
router.post('/dob-verifications/:id/approve', requireAll('staff.verifyDob'), validate(idParams), asyncHandler(DobController.approve));
router.post(
  '/dob-verifications/:id/reject',
  requireAll('staff.verifyDob'),
  validate({ ...idParams, body: Joi.object({ reason: Joi.string().trim().max(500).allow('').default('') }) }),
  asyncHandler(DobController.reject)
);
// Self-service: the service checks that the caller submitted the change.
router.post('/dob-verifications/:id/withdraw', validate(idParams), asyncHandler(DobController.withdraw));
router.get('/staff/:id/date-of-birth', requireAll('staff.view'), validate(idParams), asyncHandler(DobController.statusForStaff));
router.post('/staff/:id/date-of-birth', requireAll('staff.manage'), validate({ ...idParams, body: Joi.object({ dob }) }), asyncHandler(DobController.proposeForStaff));

module.exports = router;

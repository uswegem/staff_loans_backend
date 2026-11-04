'use strict';

const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const ReviewController = require('../../controllers/reviewController');
const { requireAll } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { badRequest, asyncHandler } = require('../../utils/errors');
const { CRB_OUTCOMES } = require('../../constants/crb');

const router = express.Router();
const objectId = Joi.string().hex().length(24);
const idParams = { params: Joi.object({ id: objectId.required() }) };
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const money = Joi.number().integer().min(1).max(10_000_000_000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/\.(pdf|jpe?g|png)$/i.test(file.originalname) ? cb(null, true) : cb(badRequest('Only PDF, JPG and PNG files can be uploaded.', undefined, 'FILE_TYPE'))),
});

/**
 * @openapi
 * /queue:
 *   get: { tags: [Review], summary: "My review queue: waiting, overdue (working hours) and handled (FR-13); limited rows on management routes (FR-55)", security: [{ bearer: [] }], responses: { 200: { description: Queue } } }
 * /review/{id}:
 *   get: { tags: [Review], summary: "Review screen: full (FR-14) or limited to name, mobile and NIDA (FR-55); audited", security: [{ bearer: [] }], responses: { 200: { description: Review view }, 403: { description: Own application } } }
 * /review/{id}/decision:
 *   post: { tags: [Review], summary: "Approve, return or reject with the stage's checks (FR-15 to FR-18, FR-42, FR-56)", security: [{ bearer: [] }], responses: { 200: { description: Outcome }, 400: { description: Missing comment or checks } } }
 * /review/{id}/crb-report:
 *   post: { tags: [Review], summary: "Attach the credit bureau report (FR-42)", security: [{ bearer: [] }], responses: { 201: { description: File } } }
 * /applications/{id}/revised:
 *   get: { tags: [Review], summary: "Signed vs approved terms with the revised agreement (FR-54)", security: [{ bearer: [] }], responses: { 200: { description: Revised terms } } }
 * /applications/{id}/accept-revised:
 *   post: { tags: [Review], summary: "Accept the revised agreement: tick, read to the end, password, fingerprint (FR-54)", security: [{ bearer: [] }], responses: { 200: { description: Pending disbursement } } }
 * /applications/{id}/decline-revised:
 *   post: { tags: [Review], summary: "Decline the revised terms with a reason (FR-38)", security: [{ bearer: [] }], responses: { 200: { description: Declined by applicant } } }
 * /delegations:
 *   get: { tags: [Review], summary: "My delegations, given and received (FR-19)", security: [{ bearer: [] }], responses: { 200: { description: Delegations } } }
 *   post: { tags: [Review], summary: "Set a time-bound delegate (SoD checked)", security: [{ bearer: [] }], responses: { 201: { description: Delegation } } }
 * /delegations/candidates:
 *   get: { tags: [Review], summary: "Colleagues who can be chosen as a delegate", security: [{ bearer: [] }], responses: { 200: { description: People } } }
 * /delegations/{id}/end:
 *   post: { tags: [Review], summary: "End a delegation early", security: [{ bearer: [] }], responses: { 200: { description: Ended } } }
 */
router.get('/queue', validate({ query: Joi.object({ tab: Joi.string().valid('waiting', 'overdue', 'handled').default('waiting') }) }), asyncHandler(ReviewController.queue));
router.get('/review/:id', validate(idParams), asyncHandler(ReviewController.get));
router.post(
  '/review/:id/decision',
  validate({
    ...idParams,
    body: Joi.object({
      action: Joi.string().valid('approve', 'return', 'reject').required(),
      comment: Joi.string().trim().max(2000).allow(''),
      // D-99: the four outcomes; no appraisal or arrears note (earlier ones are kept and shown).
      crb: Joi.object({ outcome: Joi.string().valid(...CRB_OUTCOMES).required(), reportDate: day.required(), fileId: objectId }),
      recommended: Joi.object({ amount: money.required(), tenor: Joi.number().integer().min(1).max(600).required(), reason: Joi.string().trim().max(500).allow('') }),
      suggested: Joi.object({ amount: money.required(), tenor: Joi.number().integer().min(1).max(600).required() }),
      hrChecks: Joi.object({ employment: Joi.boolean(), category: Joi.boolean(), salary: Joi.boolean(), probationReasonVerified: Joi.boolean() }),
    }),
  }),
  asyncHandler(ReviewController.decide)
);
router.post('/review/:id/crb-report', validate(idParams), (req, res, next) => upload.single('file')(req, res, next), asyncHandler(ReviewController.crbReport));

router.get('/applications/:id/revised', requireAll('loan.viewOwn'), validate(idParams), asyncHandler(ReviewController.revised));
router.post(
  '/applications/:id/accept-revised',
  requireAll('loan.viewOwn'),
  validate({ ...idParams, body: Joi.object({ accepted: Joi.boolean().required(), scrolledToEnd: Joi.boolean().required(), password: Joi.string().max(128).required(), textSha256: Joi.string().hex().length(64).required() }) }),
  asyncHandler(ReviewController.acceptRevised)
);
router.post(
  '/applications/:id/decline-revised',
  requireAll('loan.viewOwn'),
  validate({ ...idParams, body: Joi.object({ reason: Joi.string().trim().min(3).max(500).required().messages({ 'any.required': 'Say why you decline the revised terms.', 'string.empty': 'Say why you decline the revised terms.' }) }) }),
  asyncHandler(ReviewController.declineRevised)
);

router.get('/delegations', asyncHandler(ReviewController.delegations));
router.get('/delegations/candidates', requireAll('review.delegate'), validate({ query: Joi.object({ q: Joi.string().max(60).allow('') }) }), asyncHandler(ReviewController.delegationCandidates));
router.post(
  '/delegations',
  requireAll('review.delegate'),
  validate({ body: Joi.object({ delegateUserId: objectId.required(), from: day.required(), until: day.required(), reason: Joi.string().trim().max(300).allow('') }) }),
  asyncHandler(ReviewController.createDelegation)
);
router.post('/delegations/:id/end', requireAll('review.delegate'), validate(idParams), asyncHandler(ReviewController.endDelegation));

module.exports = router;

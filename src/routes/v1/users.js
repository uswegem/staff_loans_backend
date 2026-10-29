'use strict';

// Ported from Ess-Backend/src/routes/users.js (commit 522bdbd), adapted for SLAS:
// permission admin.users instead of role checks; no delete; status, unlock, MFA
// reset, password reset and role assignment routes added.

const express = require('express');
const Joi = require('joi');
const UserController = require('../../controllers/userController');
const { requireAll } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);
const idParams = { params: Joi.object({ id: objectId.required() }) };
const tempPassword = Joi.string().max(128).required();

router.use(requireAll('admin.users'));

/**
 * @openapi
 * /users:
 *   get: { tags: [Users], summary: "List users with roles, MFA and lock status", security: [{ bearer: [] }], responses: { 200: { description: Page of users } } }
 *   post: { tags: [Users], summary: Create a user for an existing staff record with a temporary password, security: [{ bearer: [] }], responses: { 201: { description: Created } } }
 * /users/{id}:
 *   get: { tags: [Users], summary: User detail with effective permissions, security: [{ bearer: [] }], responses: { 200: { description: User } } }
 * /users/{id}/activate:
 *   post: { tags: [Users], summary: Activate, security: [{ bearer: [] }], responses: { 200: { description: OK } } }
 * /users/{id}/deactivate:
 *   post: { tags: [Users], summary: Deactivate and end sessions, security: [{ bearer: [] }], responses: { 200: { description: OK } } }
 * /users/{id}/unlock:
 *   post: { tags: [Users], summary: Unlock after failed attempts (audited), security: [{ bearer: [] }], responses: { 200: { description: OK } } }
 * /users/{id}/reset-mfa:
 *   post: { tags: [Users], summary: Reset MFA; the user enrols again, security: [{ bearer: [] }], responses: { 200: { description: OK } } }
 * /users/{id}/reset-password:
 *   post: { tags: [Users], summary: Issue a temporary password, security: [{ bearer: [] }], responses: { 200: { description: OK } } }
 * /users/{id}/roles:
 *   get: { tags: [Users], summary: Current role assignments, security: [{ bearer: [] }], responses: { 200: { description: Assignments } } }
 *   put: { tags: [Users], summary: "Replace role assignments (SoD checked, FR-46, FR-48)", security: [{ bearer: [] }], responses: { 200: { description: Saved }, 409: { description: Segregation-of-duties conflict } } }
 */
router.get(
  '/',
  validate({
    query: Joi.object({
      q: Joi.string().max(80).allow(''),
      status: Joi.string().valid('active', 'locked', 'deactivated'),
      roleId: objectId,
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(25),
    }),
  }),
  asyncHandler(UserController.list)
);
router.post(
  '/',
  validate({ body: Joi.object({ staffNo: Joi.string().trim().uppercase().pattern(/^LFB\d{4}$/).required(), temporaryPassword: tempPassword }) }),
  asyncHandler(UserController.create)
);
router.get('/:id', validate(idParams), asyncHandler(UserController.get));
router.post('/:id/activate', validate(idParams), asyncHandler(UserController.setStatus));
router.post('/:id/deactivate', validate(idParams), asyncHandler(UserController.setStatus));
router.post('/:id/unlock', validate(idParams), asyncHandler(UserController.unlock));
router.post('/:id/reset-mfa', validate(idParams), asyncHandler(UserController.resetMfa));
router.post('/:id/reset-password', validate({ ...idParams, body: Joi.object({ temporaryPassword: tempPassword }) }), asyncHandler(UserController.resetPassword));
router.get('/:id/roles', validate(idParams), asyncHandler(UserController.getRoles));
router.put(
  '/:id/roles',
  validate({
    ...idParams,
    body: Joi.object({
      assignments: Joi.array()
        .items(Joi.object({ roleId: objectId.required(), endsOn: Joi.date().iso().allow(null) }))
        .min(1)
        .max(20)
        .required(),
    }),
  }),
  asyncHandler(UserController.setRoles)
);

module.exports = router;

'use strict';

const express = require('express');
const Joi = require('joi');
const RoleController = require('../../controllers/roleController');
const { requireAll, requireAny } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { PERMISSION_IDS } = require('../../constants/permissions');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);
const permissions = Joi.array().items(Joi.string().valid(...PERMISSION_IDS)).unique();


/**
 * @openapi
 * /permissions:
 *   get: { tags: [Roles], summary: Permission catalogue and SoD rules (FR-44), security: [{ bearer: [] }], responses: { 200: { description: Catalogue } } }
 * /roles:
 *   get: { tags: [Roles], summary: Roles with holder counts, security: [{ bearer: [] }], responses: { 200: { description: Roles } } }
 *   post: { tags: [Roles], summary: Create a custom role (FR-45), security: [{ bearer: [] }], responses: { 201: { description: Created }, 409: { description: SoD conflict } } }
 * /roles/{id}:
 *   patch: { tags: [Roles], summary: "Rename, deactivate or change permissions (checked against every holder)", security: [{ bearer: [] }], responses: { 200: { description: Saved }, 409: { description: SoD conflict } } }
 *   delete: { tags: [Roles], summary: Delete a custom role nobody holds, security: [{ bearer: [] }], responses: { 200: { description: Deleted } } }
 * /roles/sod-check:
 *   post: { tags: [Roles], summary: Live segregation-of-duties check for the matrix, security: [{ bearer: [] }], responses: { 200: { description: Result } } }
 */
router.get('/permissions', requireAny('admin.roles', 'admin.users'), asyncHandler(RoleController.catalogue));
router.get('/roles', requireAny('admin.roles', 'admin.users'), asyncHandler(RoleController.list));
router.post(
  '/roles',
  requireAll('admin.roles'),
  validate({ body: Joi.object({ name: Joi.string().trim().min(2).max(80).required(), description: Joi.string().trim().max(400).allow(''), permissions: permissions.default([]) }) }),
  asyncHandler(RoleController.create)
);
router.post('/roles/sod-check', requireAll('admin.roles'), validate({ body: Joi.object({ roleId: objectId, permissions: permissions.required() }) }), asyncHandler(RoleController.sodCheck));
router.patch(
  '/roles/:id',
  requireAll('admin.roles'),
  validate({
    params: Joi.object({ id: objectId.required() }),
    body: Joi.object({ name: Joi.string().trim().min(2).max(80), description: Joi.string().trim().max(400).allow(''), active: Joi.boolean(), permissions }).min(1),
  }),
  asyncHandler(RoleController.update)
);
router.delete('/roles/:id', requireAll('admin.roles'), validate({ params: Joi.object({ id: objectId.required() }) }), asyncHandler(RoleController.remove));

module.exports = router;

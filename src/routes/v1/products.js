'use strict';

const express = require('express');
const Joi = require('joi');
const ProductController = require('../../controllers/productController');
const { requireAll, requireAny } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { FIELD_TYPES, CATEGORIES, REPAYMENT_METHODS } = require('../../models/ProductVersion');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Use a date like 2026-11-01.' });
const text = (max) => Joi.string().trim().max(max);
const whole = Joi.number().integer();

const productValues = {
  name: text(80).min(2),
  description: text(400).allow(''),
  minAmount: whole.min(1),
  maxAmount: whole.min(1),
  minTenor: whole.min(1),
  maxTenor: whole.min(1),
  minServiceMonths: whole.min(0),
  maxConcurrent: whole.min(1).max(20),
  topUpAllowed: Joi.boolean(),
  payslipLabel: text(80).allow(''), // D-101
  contractStaffAllowed: Joi.boolean(),
  eligibleCategories: Joi.array().items(Joi.string().valid(...CATEGORIES)).unique(),
  // Salary deduction is the only method; anything else is refused (D-84).
  repaymentMethods: Joi.array().items(Joi.string().valid(...REPAYMENT_METHODS).messages({ 'any.only': 'Salary deduction is the only repayment method.' })).unique(),
  fields: Joi.array()
    .items(
      Joi.object({
        key: Joi.string().pattern(/^[a-z][a-zA-Z0-9]{0,30}$/).required().messages({ 'string.pattern.base': 'Keys start with a lower-case letter and use letters and digits only.' }),
        label: text(120).min(2).required(),
        type: Joi.string().valid(...FIELD_TYPES).required(),
        options: Joi.array().items(text(80).min(1)).max(30).default([]),
        mandatory: Joi.boolean().default(false),
      })
    )
    .max(20),
  reapplyCoolingMonths: whole.min(0).max(60),
  agreementTemplateId: objectId.allow(null),
};
const REQUIRED_ON_CREATE = ['name', 'minAmount', 'maxAmount', 'minTenor', 'maxTenor', 'minServiceMonths', 'maxConcurrent', 'eligibleCategories'];
const createValues = Joi.object(productValues).fork(REQUIRED_ON_CREATE, (s) => s.required());
const partialValues = Joi.object(productValues);

const bps = whole.min(0).max(10000);
const pricingValues = Joi.object({
  interestBps: bps,
  processingFeeBps: bps,
  processingFeeTopUpBps: bps,
  insuranceBps: bps,
  affordabilityBps: bps,
  pensionBps: bps,
  instalmentRounding: whole.valid(1, 10, 100, 1000),
  payeBands: Joi.array().items(Joi.object({ from: whole.min(0).required(), base: whole.min(0).required(), rateBps: bps.required() })).min(1).max(15),
});

const vidParams = { params: Joi.object({ vid: objectId.required() }) };

function versionRoutes(prefix, actions, valuesSchema) {
  router.get(`${prefix}/:vid`, requireAny('products.view', 'products.make', 'products.approveCredit', 'products.approveRisk'), validate(vidParams), asyncHandler(actions.get));
  router.patch(
    `${prefix}/:vid`,
    requireAll('products.make'),
    validate({ ...vidParams, body: Joi.object({ values: valuesSchema, effectiveFrom: day, note: text(1000).allow('') }).min(1) }),
    asyncHandler(actions.update)
  );
  router.post(`${prefix}/:vid/submit`, requireAll('products.make'), validate(vidParams), asyncHandler(actions.submit));
  router.post(`${prefix}/:vid/recall`, requireAll('products.make'), validate(vidParams), asyncHandler(actions.recall));
  router.post(`${prefix}/:vid/discard`, requireAll('products.make'), validate(vidParams), asyncHandler(actions.discard));
  router.post(`${prefix}/:vid/approve`, requireAny('products.approveCredit', 'products.approveRisk'), validate(vidParams), asyncHandler(actions.approve));
  router.post(
    `${prefix}/:vid/reject`,
    requireAny('products.approveCredit', 'products.approveRisk'),
    validate({ ...vidParams, body: Joi.object({ reason: text(1000).min(5).required().messages({ 'string.min': 'Give a reason the maker can act on.', 'any.required': 'Give a reason the maker can act on.', 'string.empty': 'Give a reason the maker can act on.' }) }) }),
    asyncHandler(actions.reject)
  );
}

/**
 * @openapi
 * /products:
 *   get: { tags: [Products], summary: "Live products open for new applications (FR-05, FR-62)", security: [{ bearer: [] }], responses: { 200: { description: Products with their live version values } } }
 * /pricing:
 *   get: { tags: [Products], summary: "Pricing in force (rates in basis points)", security: [{ bearer: [] }], responses: { 200: { description: Pricing } } }
 * /admin/products:
 *   get: { tags: [Products], summary: "Products with live, scheduled and open versions", security: [{ bearer: [] }], responses: { 200: { description: Products } } }
 *   post: { tags: [Products], summary: "Create a product as a draft (maker, FR-58)", security: [{ bearer: [] }], responses: { 201: { description: Draft version with comparison } } }
 * /admin/products/{id}:
 *   get: { tags: [Products], summary: "Product with every version (history)", security: [{ bearer: [] }], responses: { 200: { description: Product } } }
 * /admin/products/{id}/drafts:
 *   post: { tags: [Products], summary: "Propose a change or a deactivation as a draft (maker, FR-58, FR-62)", security: [{ bearer: [] }], responses: { 201: { description: Draft }, 409: { description: Another change is open } } }
 * /admin/product-versions/{vid}:
 *   get: { tags: [Products], summary: "Version with field-by-field comparison to the live version (FR-59)", security: [{ bearer: [] }], responses: { 200: { description: Version } } }
 *   patch: { tags: [Products], summary: "Edit a draft or rejected version; validates every value (FR-58)", security: [{ bearer: [] }], responses: { 200: { description: Saved }, 400: { description: Invalid values } } }
 * /admin/product-versions/{vid}/submit:
 *   post: { tags: [Products], summary: "Submit for approval; checkers are notified (FR-59)", security: [{ bearer: [] }], responses: { 200: { description: Pending approval } } }
 * /admin/product-versions/{vid}/recall:
 *   post: { tags: [Products], summary: "Maker takes a submitted version back to draft", security: [{ bearer: [] }], responses: { 200: { description: Draft } } }
 * /admin/product-versions/{vid}/discard:
 *   post: { tags: [Products], summary: "Discard a draft (kept for the audit trail)", security: [{ bearer: [] }], responses: { 200: { description: Discarded } } }
 * /admin/product-versions/{vid}/approve:
 *   post: { tags: [Products], summary: "Checker approves; refused for anyone who edited it (FR-60)", security: [{ bearer: [] }], responses: { 200: { description: Approved (scheduled) or active }, 403: { description: Self-approval } } }
 * /admin/product-versions/{vid}/reject:
 *   post: { tags: [Products], summary: "Checker rejects with a mandatory reason; returns to the maker (FR-59)", security: [{ bearer: [] }], responses: { 200: { description: Rejected } } }
 * /admin/pricing:
 *   get: { tags: [Products], summary: "Pricing versions, live and open", security: [{ bearer: [] }], responses: { 200: { description: Pricing history } } }
 * /admin/pricing/drafts:
 *   post: { tags: [Products], summary: "Propose a pricing change as a draft (maker-checker, D-06)", security: [{ bearer: [] }], responses: { 201: { description: Draft } } }
 * /admin/pricing-versions/{vid}:
 *   get: { tags: [Products], summary: "Pricing version with comparison; same submit, recall, discard, approve and reject actions as products", security: [{ bearer: [] }], responses: { 200: { description: Version } } }
 */
router.get('/products', asyncHandler(ProductController.listLive));
router.get('/pricing', asyncHandler(ProductController.livePricing));

router.get('/admin/products', requireAny('products.view', 'products.make', 'products.approveCredit', 'products.approveRisk'), asyncHandler(ProductController.adminList));
router.post(
  '/admin/products',
  requireAll('products.make'),
  validate({
    body: Joi.object({
      code: Joi.string().trim().uppercase().pattern(/^[A-Z][A-Z0-9]{1,9}$/).required().messages({ 'string.pattern.base': 'Codes are 2 to 10 capital letters or digits, starting with a letter.' }),
      effectiveFrom: day.required(),
      note: text(1000).allow(''),
      values: createValues.required(),
    }),
  }),
  asyncHandler(ProductController.create)
);
router.get('/admin/products/:id', requireAny('products.view', 'products.make', 'products.approveCredit', 'products.approveRisk'), validate({ params: Joi.object({ id: objectId.required() }) }), asyncHandler(ProductController.adminGet));
router.post(
  '/admin/products/:id/drafts',
  requireAll('products.make'),
  validate({
    params: Joi.object({ id: objectId.required() }),
    body: Joi.object({ changeType: Joi.string().valid('change', 'deactivate').default('change'), effectiveFrom: day.required(), note: text(1000).allow(''), values: partialValues }),
  }),
  asyncHandler(ProductController.createDraft)
);
versionRoutes('/admin/product-versions', ProductController.productVersion, partialValues);

router.get('/admin/pricing', requireAny('products.view', 'products.make', 'products.approveCredit', 'products.approveRisk'), asyncHandler(ProductController.pricingList));
router.post(
  '/admin/pricing/drafts',
  requireAll('products.make'),
  validate({ body: Joi.object({ effectiveFrom: day.required(), note: text(1000).allow(''), values: pricingValues }) }),
  asyncHandler(ProductController.pricingDraft)
);
versionRoutes('/admin/pricing-versions', ProductController.pricingVersion, pricingValues);

module.exports = router;

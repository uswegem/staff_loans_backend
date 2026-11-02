'use strict';

// Products and pricing as maker-checker chains, the version resolver used by the
// application form, and the go-live promotion run by the scheduler (FR-57 to FR-63).
// Nothing here branches on a product code: behaviour comes from version values.

const Product = require('../../models/Product');
const ProductVersion = require('../../models/ProductVersion');
const PricingVersion = require('../../models/PricingVersion');
const mc = require('./makerChecker');
const { PRODUCT_FIELDS, validateProduct } = require('./productRules');
const { PRICING_FIELDS, validatePricing } = require('./pricingRules');
const { notFound } = require('../../utils/errors');

// Optional values a brand-new product starts with (the maker can change any of them).
const PRODUCT_DEFAULTS = {
  description: '',
  topUpAllowed: false,
  contractStaffAllowed: false,
  repaymentMethods: ['payroll'],
  fields: [],
  reapplyCoolingMonths: 6,
  agreementTemplateId: null,
};

const productChain = (product) => ({
  Model: ProductVersion,
  filter: { productId: product._id },
  fields: PRODUCT_FIELDS,
  validate: validateProduct,
  defaults: PRODUCT_DEFAULTS,
  entity: 'ProductVersion',
  audit: 'product',
  describe: (v) => `${v.name || product.code} (${product.code}) version ${v.version}`,
});

const pricingChain = () => ({
  Model: PricingVersion,
  filter: {},
  fields: PRICING_FIELDS,
  validate: validatePricing,
  entity: 'PricingVersion',
  audit: 'pricing',
  describe: (v) => `Pricing version ${v.version}`,
});

/** Brings a product's display status in line with its live version. */
async function refreshProduct(product, { now = new Date(), session } = {}) {
  const live = await mc.promote(productChain(product), { now, session });
  const status = !live ? 'not_live' : live.changeType === 'deactivate' ? 'inactive' : 'active';
  const liveVersionId = live ? live._id : null;
  if (product.status !== status || String(product.liveVersionId) !== String(liveVersionId)) {
    await Product.updateOne({ _id: product._id }, { $set: { status, liveVersionId } }, { session });
  }
  return { live, status };
}

/** Runs promotion for every product and for pricing (scheduler, D-22). */
async function promoteAll({ now = new Date() } = {}) {
  const products = await Product.find();
  for (const p of products) {
    // eslint-disable-next-line no-await-in-loop
    await refreshProduct(p, { now });
  }
  await mc.promote(pricingChain(), { now });
}

/**
 * Products open for new applications at `at`: the live version is not a
 * deactivation (FR-62). Returns [{ product, version }].
 */
async function liveProducts(at = new Date()) {
  const products = await Product.find().sort({ code: 1 });
  const out = [];
  for (const product of products) {
    // eslint-disable-next-line no-await-in-loop
    const version = await mc.liveAt(productChain(product), at);
    if (version && version.changeType !== 'deactivate') out.push({ product, version });
  }
  return out;
}

async function liveProductVersion(productId, at = new Date()) {
  const product = await Product.findById(productId);
  if (!product) throw notFound('Product not found.');
  const version = await mc.liveAt(productChain(product), at);
  return { product, version: version && version.changeType !== 'deactivate' ? version : null };
}

const livePricing = (at = new Date()) => mc.liveAt(pricingChain(), at);

module.exports = { productChain, pricingChain, refreshProduct, promoteAll, liveProducts, liveProductVersion, livePricing };

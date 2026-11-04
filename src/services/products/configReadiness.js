'use strict';

// Read-only readiness assessment. An empty, explicitly saved requiredDocuments
// list is valid; absence of the field means an older version was never configured.
const Product = require('../../models/Product');
const AgreementTemplate = require('../../models/AgreementTemplate');
const mc = require('./makerChecker');
const { productChain } = require('./productService');
const { badRequest } = require('../../utils/errors');

async function assess(version, { now = new Date(), session } = {}) {
  const documentRequirementsConfigured = Array.isArray(version?.requiredDocuments);
  let agreement = null;
  if (version?.agreementTemplateId) {
    agreement = await AgreementTemplate.findById(version.agreementTemplateId)
      .select('version status effectiveFrom sample')
      .session(session || null)
      .lean();
  }
  const agreementReady = !!(agreement && agreement.status === 'approved' && !agreement.sample && (!agreement.effectiveFrom || agreement.effectiveFrom <= now));
  const missing = [];
  if (!documentRequirementsConfigured) missing.push('Document requirements have not been explicitly configured.');
  if (!version?.agreementTemplateId) missing.push('An approved product-specific agreement must be selected.');
  else if (!agreementReady) missing.push('The assigned agreement must be legally approved, effective and not a sample.');
  return {
    ready: missing.length === 0,
    status: missing.length ? 'configuration_incomplete' : 'ready',
    documentRequirementsConfigured,
    documentRequirementCount: (version?.requiredDocuments || []).length,
    agreementTemplateId: version?.agreementTemplateId ? String(version.agreementTemplateId) : null,
    agreementVersion: agreement?.version || null,
    agreementReady,
    missing,
  };
}

async function assertReady(version, options) {
  const result = await assess(version, options);
  if (!result.ready) throw badRequest('This product is not ready to accept new loan applications.', { configuration: result.missing }, 'PRODUCT_CONFIGURATION_INCOMPLETE');
  return result;
}

async function report() {
  const products = await Product.find().sort({ code: 1 }).lean();
  const rows = [];
  for (const product of products) {
    // eslint-disable-next-line no-await-in-loop
    const version = await mc.liveAt(productChain(product));
    if (!version || version.changeType === 'deactivate') continue;
    // eslint-disable-next-line no-await-in-loop
    const assessment = await assess(version);
    rows.push({ productId: String(product._id), code: product.code, name: version.name, version: version.version, versionId: String(version._id), ...assessment });
  }
  return { total: rows.length, ready: rows.filter((p) => p.ready).length, incomplete: rows.filter((p) => !p.ready).length, products: rows };
}

module.exports = { assess, assertReady, report };

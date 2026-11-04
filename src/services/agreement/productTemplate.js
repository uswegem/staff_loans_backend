'use strict';

const AgreementTemplate = require('../../models/AgreementTemplate');
const { badRequest } = require('../../utils/errors');

/** Resolve the explicitly assigned approved and effective template; never fall back globally. */
async function resolve(version, { session } = {}) {
  if (!version?.agreementTemplateId) throw badRequest('Assign an approved loan agreement to this product before submitting.', undefined, 'PRODUCT_AGREEMENT_MISSING');
  const template = await AgreementTemplate.findById(version.agreementTemplateId).session(session || null);
  if (!template || template.status !== 'approved' || (template.effectiveFrom && template.effectiveFrom > new Date())) {
    throw badRequest('The assigned product agreement is not approved and effective.', undefined, 'PRODUCT_AGREEMENT_INVALID');
  }
  return template;
}
module.exports = { resolve };

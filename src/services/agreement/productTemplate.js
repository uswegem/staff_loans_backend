'use strict';

const AgreementTemplate = require('../../models/AgreementTemplate');
const { badRequest } = require('../../utils/errors');

/** Resolve the explicitly assigned approved and effective template; never fall back globally. */
async function resolve(version, { session, enforce = false, historicalTemplateId } = {}) {
  const id = historicalTemplateId || version?.agreementTemplateId;
  if (!id) {
    if (enforce) throw badRequest('Assign an approved loan agreement to this product before submitting.', undefined, 'PRODUCT_AGREEMENT_MISSING');
    const legacyTemplate = await AgreementTemplate.active(session);
    if (!legacyTemplate) throw badRequest('No approved loan agreement is available.', undefined, 'PRODUCT_AGREEMENT_MISSING');
    return legacyTemplate;
  }
  const template = await AgreementTemplate.findById(id).session(session || null);
  if (!template || template.status !== 'approved' || (template.effectiveFrom && template.effectiveFrom > new Date()) || (enforce && template.sample)) {
    throw badRequest('The assigned product agreement is not approved and effective.', undefined, 'PRODUCT_AGREEMENT_INVALID');
  }
  return template;
}
module.exports = { resolve };

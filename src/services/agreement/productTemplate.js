'use strict';

const AgreementTemplate = require('../../models/AgreementTemplate');
const { badRequest } = require('../../utils/errors');

const usable = (t, enforce) => !!t && t.status === 'approved' && !(t.effectiveFrom && t.effectiveFrom > new Date()) && !(enforce && t.sample);

/**
 * Resolve the explicitly assigned approved and effective template; never fall back globally.
 * D-109: a product holds its agreement in each language (agreementTemplateId and
 * agreementTemplateSwId). With `language`, the template in that language is used when it is
 * approved; otherwise the main one (the English one until Legal approves the Swahili).
 */
async function resolve(version, { session, enforce = false, historicalTemplateId, language } = {}) {
  const id = historicalTemplateId || version?.agreementTemplateId;
  if (!id) {
    if (enforce) throw badRequest('Assign an approved loan agreement to this product before submitting.', undefined, 'PRODUCT_AGREEMENT_MISSING');
    const legacyTemplate = await AgreementTemplate.active(session);
    if (!legacyTemplate) throw badRequest('No approved loan agreement is available.', undefined, 'PRODUCT_AGREEMENT_MISSING');
    return legacyTemplate;
  }
  const template = await AgreementTemplate.findById(id).session(session || null);
  if (!usable(template, enforce)) {
    throw badRequest('The assigned product agreement is not approved and effective.', undefined, 'PRODUCT_AGREEMENT_INVALID');
  }
  if (!historicalTemplateId && language && template.language !== language && version?.agreementTemplateSwId) {
    const other = await AgreementTemplate.findById(version.agreementTemplateSwId).session(session || null);
    if (usable(other, enforce) && other.language === language) return other;
  }
  return template;
}

// One line, in the reader's language, when the agreement is not in it (D-109).
const NOTICE = {
  sw: 'Mkataba huu bado haujaidhinishwa kwa Kiswahili; unaonyeshwa kwa Kiingereza.',
  en: 'This agreement is not yet approved in English; it is shown in Swahili.',
};
const languageNotice = (template, language) => (language && template?.language && template.language !== language ? NOTICE[language] || null : null);

module.exports = { resolve, languageNotice };

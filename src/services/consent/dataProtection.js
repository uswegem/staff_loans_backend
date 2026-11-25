'use strict';

// The data protection notice shown with the agreement (D-108). The applicant ticks its own
// box before signing; the version, language and time are kept on the application and
// printed after the agreement in the signed and in-force PDFs.

const LegalNotice = require('../../models/LegalNotice');
const { AppError } = require('../../utils/errors');

/**
 * The notice in the language: { version, language, title, body, checkbox }. Until a
 * Swahili version is approved the English one is shown, with fallbackNotice set.
 */
async function current(language) {
  const lang = language === 'sw' ? 'sw' : 'en';
  let n = await LegalNotice.current('data_protection', lang);
  let fallback = false;
  if (!n && lang === 'sw') {
    n = await LegalNotice.current('data_protection', 'en');
    fallback = !!n;
  }
  if (!n) throw new AppError(503, 'DP_NOTICE_MISSING', 'The data protection notice is not available, so you cannot sign now. Contact the IT Service Desk.');
  return {
    version: n.version,
    language: n.language,
    title: n.title,
    body: n.body,
    checkbox: n.checkbox,
    // In Swahili, said once, when the approved Swahili text is not there yet.
    fallbackNotice: fallback ? 'Tamko hili bado halijaidhinishwa kwa Kiswahili; linaonyeshwa kwa Kiingereza.' : null,
  };
}

/** Heading and lines printed after the agreement in its PDFs. */
function pdfSection(consent) {
  if (!consent?.accepted) return null;
  const sw = consent.language === 'sw';
  return {
    title: consent.title,
    body: consent.body,
    accepted: sw
      ? `Imekubaliwa: ${consent.checkbox} Toleo ${consent.version}, ${new Date(consent.at).toISOString()} (UTC).`
      : `Accepted: ${consent.checkbox} Version ${consent.version}, ${new Date(consent.at).toISOString()} (UTC).`,
  };
}

module.exports = { current, pdfSection };

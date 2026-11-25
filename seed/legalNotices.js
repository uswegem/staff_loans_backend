'use strict';

// The data protection notice DP-2026-1 (D-108), English and Swahili, as approved by Legal
// for the release that added it. Safe to run again: an existing version is left as it is.

const LegalNotice = require('../src/models/LegalNotice');

const VERSION = 'DP-2026-1';

const DATA_PROTECTION = {
  en: {
    title: 'Data protection',
    body: "I consent to Letshego Faidika Bank collecting, using and keeping my personal data, including my identity, contact, employment, salary, bank and next-of-kin details, my payslips and documents I upload, and my credit bureau report, to assess, approve, book, disburse and recover this loan, to deduct repayments from my salary, and to meet legal and regulatory duties. I authorise the Bank to request my credit report from licensed credit reference bureaus and to share information about this loan with them, and with the Bank's regulators, auditors and service providers only where needed for these purposes and under confidentiality. My data will be kept for as long as the law requires and will be protected in line with the Personal Data Protection Act, 2022. I may ask to see or correct my data, and I have confirmed that the next-of-kin details I gave may be used to contact them about this loan.",
    checkbox: 'I have read and accept the data protection notice.',
  },
  sw: {
    title: 'Ulinzi wa taarifa binafsi',
    body: 'Ninaridhia Letshego Faidika Bank kukusanya, kutumia na kuhifadhi taarifa zangu binafsi, zikiwemo taarifa za utambulisho, mawasiliano, ajira, mshahara, akaunti ya benki na ndugu wa karibu, hati za mshahara na nyaraka ninazopakia, pamoja na taarifa zangu za mikopo kutoka kwa taasisi za taarifa za mikopo, kwa ajili ya kutathmini, kuidhinisha, kusajili, kulipa na kurejesha mkopo huu, kukata marejesho kutoka kwenye mshahara wangu, na kutimiza matakwa ya sheria na mamlaka za usimamizi. Ninaiidhinisha Benki kuomba taarifa zangu za mikopo kutoka kwa taasisi za taarifa za mikopo zilizopewa leseni na kuzipa taarifa kuhusu mkopo huu, na kuwapa wasimamizi, wakaguzi na watoa huduma wa Benki pale tu inapohitajika kwa madhumuni haya na kwa usiri. Taarifa zangu zitahifadhiwa kwa muda unaotakiwa kisheria na zitalindwa kwa mujibu wa Sheria ya Ulinzi wa Taarifa Binafsi ya mwaka 2022. Nina haki ya kuomba kuziona au kuzirekebisha, na nimethibitisha kuwa taarifa za ndugu wa karibu nilizotoa zinaweza kutumika kuwasiliana nao kuhusu mkopo huu.',
    checkbox: 'Nimesoma na ninakubali tamko la ulinzi wa taarifa binafsi.',
  },
};

async function seedLegalNotices({ dryRun = false } = {}) {
  const made = [];
  for (const language of ['en', 'sw']) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await LegalNotice.exists({ key: 'data_protection', version: VERSION, language });
    if (exists) continue;
    made.push(`${VERSION} (${language})`);
    if (dryRun) continue;
    // eslint-disable-next-line no-await-in-loop
    await LegalNotice.create({
      key: 'data_protection',
      version: VERSION,
      language,
      ...DATA_PROTECTION[language],
      status: 'approved',
      effectiveFrom: new Date('2026-01-01T00:00:00+03:00'),
      approvedAt: new Date(),
      approvalRef: 'Wording approved by Legal for the December 2026 release',
    });
  }
  return made;
}

module.exports = { seedLegalNotices, DATA_PROTECTION, VERSION };

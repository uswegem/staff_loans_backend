'use strict';

// D-108: the data protection notice is shown with the agreement, with its own unticked box.
// Signing needs it ticked. The version, language and time are kept on the application,
// in the audit log, and printed after the agreement in the signed and in-force PDFs.

const { pathToFileURL } = require('url');
const { api, seedAll, attachPayslip, decide, signIn, CRB, HR_OK } = require('../flows');
const { app: server, authed, request } = require('../helpers');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const AuditLog = require('../../src/models/AuditLog');
const LegalNotice = require('../../src/models/LegalNotice');
const StoredFile = require('../../src/models/StoredFile');
const fileStore = require('../../src/services/files/fileStore');
const { DATA_PROTECTION } = require('../../seed/legalNotices');
const fs = require('fs');
const path = require('path');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const ProductVersion = require('../../src/models/ProductVersion');
const { VERSION: SW_VERSION } = require('../../seed/agreementTemplate');

const PERSONAL = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'data', 'agreements', 'staff-personal-loan.en.md'), 'utf8');

jest.setTimeout(180000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
  // The product's agreement in English, and the seeded Swahili one (D-109).
  const en = await AgreementTemplate.create({ version: '2026.12c', language: 'en', body: PERSONAL, status: 'approved', sample: false, effectiveFrom: new Date('2026-10-01T00:00:00+03:00'), approvedAt: new Date() });
  const sw = await AgreementTemplate.findOne({ version: SW_VERSION });
  await ProductVersion.updateMany({ productId: products.PL._id }, { $set: { agreementTemplateId: en._id, agreementTemplateSwId: sw._id } });
});

const TERMS = { amount: 3000000, tenor: 24, purpose: 'Home repairs' };
const CONSENTS = { truth: true, deduct: true, crb: true, sms: true };
const ticks = (preview) => preview.blocks.filter((b) => b.type === 'declaration').map(() => true);

async function draft(lang = 'en') {
  const neema = await signIn('LFB0412');
  const a = api(neema.token);
  const { id } = (await a.post('/applications', { productId: String(products.PL._id) })).body.data;
  await a.patch(`/applications/${id}`, { repaymentMethod: 'payroll', ...TERMS });
  expect((await attachPayslip(neema, id)).status).toBe(201);
  const get = (url) => request(server()).get(`/api/v1${url}`).set(authed(neema.token)).set('Accept-Language', lang);
  const post = (url, body) => request(server()).post(`/api/v1${url}`).set(authed(neema.token)).set('Accept-Language', lang).send(body);
  return { a, id, get, post, neema };
}

async function pdfText(fileId) {
  const lib = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const data = new Uint8Array(await fileStore.read(await StoredFile.findById(fileId)));
  const task = lib.getDocument({ data, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    pages.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(' '));
  }
  await task.destroy();
  return pages.join('\n').replace(/\s+/g, ' ');
}

describe('data protection notice before signing (D-108)', () => {
  it('the preview carries the notice in the chosen language, with its checkbox text', async () => {
    const en = await draft('en');
    expect((await en.get(`/applications/${en.id}/agreement/preview`)).body.data.dataProtection).toEqual({ version: 'DP-2026-1', language: 'en', title: 'Data protection', body: DATA_PROTECTION.en.body, checkbox: 'I have read and accept the data protection notice.', fallbackNotice: null });
    const sw = (await en.get(`/applications/${en.id}/agreement/preview`).set('Accept-Language', 'sw')).body.data.dataProtection;
    expect(sw).toMatchObject({ version: 'DP-2026-1', language: 'sw', title: 'Ulinzi wa taarifa binafsi', checkbox: 'Nimesoma na ninakubali tamko la ulinzi wa taarifa binafsi.' });
  });

  it('signing is refused until the notice is ticked', async () => {
    const { id, get, post } = await draft();
    const preview = (await get(`/applications/${id}/agreement/preview`)).body.data;
    const base = { consents: CONSENTS, declarations: ticks(preview), accepted: true, scrolledToEnd: true, textSha256: preview.textSha256 };
    for (const dp of [undefined, false]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(`/applications/${id}/sign-and-submit`, { ...base, dataProtection: dp });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DATA_PROTECTION_REQUIRED');
    }
    expect((await post(`/applications/${id}/sign-and-submit`, { ...base, dataProtection: true, dataProtectionVersion: 'DP-2025-9' })).body.code).toBe('DATA_PROTECTION_CHANGED');
    expect((await Application.findById(id)).status).toBe('draft');
  });

  it('acceptance is stored on the application, shown, audited and printed after the agreement', async () => {
    const { id, get, post, a } = await draft();
    const preview = (await get(`/applications/${id}/agreement/preview`)).body.data;
    const res = await post(`/applications/${id}/sign-and-submit`, { consents: CONSENTS, declarations: ticks(preview), accepted: true, scrolledToEnd: true, textSha256: preview.textSha256, dataProtection: true, dataProtectionVersion: 'DP-2026-1' });
    expect(res.status).toBe(200);
    const app = await Application.findById(id).lean();
    expect(app.consents.dataProtection).toMatchObject({ accepted: true, version: 'DP-2026-1', language: 'en' });
    expect(app.consents.dataProtection.at).toBeInstanceOf(Date);
    expect((await a.get(`/applications/${id}`)).body.data.dataProtection).toMatchObject({ accepted: true, version: 'DP-2026-1', language: 'en' });
    const juma = await signIn('LFB0233');
    await decide(juma, id, { action: 'approve', crb: CRB });
    const grace = await signIn('LFB0051');
    expect((await api(grace.token).get(`/review/${id}`)).body.data.dataProtection).toMatchObject({ version: 'DP-2026-1' });
    expect(await AuditLog.exists({ action: 'application.submit', description: /data protection notice DP-2026-1 \(en\) accepted/ })).toBeTruthy();

    const ag = await Agreement.findOne({ applicationId: id }).lean();
    const signed = await pdfText(ag.pdfFileId);
    expect(signed).toMatch(/Signatures and acceptance/);
    expect(signed).not.toMatch(/Ushahidi|Mwajiriwa|ukurasa/);
    expect(signed).toMatch(/Data protection I consent to Letshego Faidika Bank collecting/);
    expect(signed).toMatch(/Accepted: I have read and accept the data protection notice\. Version DP-2026-1, \d{4}-\d{2}-\d{2}T/);
    // The agreement text and its fingerprint are not changed by the notice.
    expect(ag.text).not.toMatch(/I consent to Letshego Faidika Bank/);

    await decide(grace, id, { action: 'approve', hrChecks: HR_OK });
    expect((await decide(await signIn('LFB0002'), id, { action: 'approve' })).body.data.outcome).toBe('approved');
    const inForce = await Agreement.findById(ag._id).lean();
    expect(await pdfText(inForce.inForcePdfFileId)).toMatch(/Accepted: I have read and accept the data protection notice\. Version DP-2026-1/);
  });

  it('in Swahili: the Swahili notice is accepted and printed', async () => {
    const { id, get, post } = await draft('sw');
    const preview = (await get(`/applications/${id}/agreement/preview`)).body.data;
    expect((await post(`/applications/${id}/sign-and-submit`, { consents: CONSENTS, accepted: true, scrolledToEnd: true, textSha256: preview.textSha256, dataProtection: true })).status).toBe(200);
    expect((await Application.findById(id).lean()).consents.dataProtection).toMatchObject({ language: 'sw', version: 'DP-2026-1' });
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    const text = await pdfText(ag.pdfFileId);
    // D-109: the Swahili agreement, signed in Swahili; nothing in English around it.
    expect(preview).toMatchObject({ language: 'sw', languageNotice: null });
    expect(await Application.findById(id).lean()).toMatchObject({ agreementLanguage: 'sw' });
    expect(ag.language).toBe('sw');
    expect(text).toMatch(/Sahihi na ushahidi wa kukubali/);
    expect(text).not.toMatch(/Electronic acceptance|Agreement number|Staff member| page \d/);
    expect(text).toMatch(/Ulinzi wa taarifa binafsi Ninaridhia Letshego Faidika Bank/);
    expect(text).toMatch(/Imekubaliwa: Nimesoma na ninakubali tamko la ulinzi wa taarifa binafsi\. Toleo DP-2026-1/);
  });

  it('until the Swahili agreement is approved, a Swahili applicant gets the English agreement with a one-line Swahili note', async () => {
    await AgreementTemplate.updateOne({ version: SW_VERSION }, { $set: { status: 'pending_legal_approval' } });
    const { id, get, post } = await draft('sw');
    const preview = (await get(`/applications/${id}/agreement/preview`)).body.data;
    expect(preview.language).toBe('en');
    expect(preview.languageNotice).toBe('Mkataba huu bado haujaidhinishwa kwa Kiswahili; unaonyeshwa kwa Kiingereza.');
    // The whole agreement and its notice are English: never mixed.
    expect(preview.dataProtection).toMatchObject({ language: 'en' });
    const signBody = { accepted: true, dataProtection: true, scrolledToEnd: true, textSha256: preview.textSha256, declarations: preview.blocks.filter((b) => b.type === 'declaration').map(() => true) };
    expect((await post(`/applications/${id}/sign-and-submit`, signBody)).status).toBe(200);
    expect(await Application.findById(id).lean()).toMatchObject({ agreementLanguage: 'en', consents: { dataProtection: { language: 'en' } } });
  });

  it('until a Swahili notice is approved, the English notice is shown with a one-line Swahili note', async () => {
    await LegalNotice.updateMany({ language: 'sw' }, { $set: { status: 'pending_legal_approval' } });
    const { id, get } = await draft('sw');
    const dp = (await get(`/applications/${id}/agreement/preview`)).body.data.dataProtection;
    expect(dp).toMatchObject({ language: 'en', checkbox: 'I have read and accept the data protection notice.' });
    expect(dp.fallbackNotice).toMatch(/Kiswahili/);
  });

  it('without an approved notice nobody can sign', async () => {
    await LegalNotice.deleteMany({});
    const { id, get } = await draft();
    const res = await get(`/applications/${id}/agreement/preview`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DP_NOTICE_MISSING');
  });
});

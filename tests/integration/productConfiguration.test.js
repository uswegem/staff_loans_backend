'use strict';

// Product-specific document and agreement regression tests. Configuration activation is
// explicitly opt-in; legacy fixture products remain usable until activation.
const { app, seed, signIn, authed, PASSWORD, request } = require('../helpers');
const { seedProducts } = require('../fixtures/products');
const { seedAgreementTemplate, BODY } = require('../../seed/agreementTemplate');
const { attachPayslip } = require('../flows');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const ProductVersion = require('../../src/models/ProductVersion');
const StoredFile = require('../../src/models/StoredFile');
const Settings = require('../../src/models/Settings');

let products;
const api = (token) => ({
  get: (url) => request(app()).get(`/api/v1${url}`).set(authed(token)),
  post: (url, body = {}) => request(app()).post(`/api/v1${url}`).set(authed(token)).send(body),
  patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(authed(token)).send(body),
});

async function configureAll() {
  const template = await AgreementTemplate.create({
    version: '2026.12', body: BODY, status: 'approved', sample: false,
    effectiveFrom: new Date('2026-10-01T00:00:00+03:00'), approvedAt: new Date(),
    note: 'Approved document for test products',
  });
  await ProductVersion.updateMany({}, { $set: { requiredDocuments: [], agreementTemplateId: template._id } });
  return template;
}

async function activate(admin) {
  return api(admin.token).post('/admin/products/config-enforcement', {
    enabled: true, confirmation: 'ACTIVATE_PRODUCT_CONFIG_ENFORCEMENT',
  });
}

beforeEach(async () => {
  const { users } = await seed();
  products = await seedProducts(users);
  await seedAgreementTemplate(users);
});

describe('product configuration readiness and controlled activation', () => {
  it('reports existing products as incomplete and does not activate by default', async () => {
    const admin = await signIn('LFB0274');
    const report = await api(admin.token).get('/admin/products/config-readiness');
    expect(report.status).toBe(200);
    expect(report.body.data).toMatchObject({ enforcementEnabled: false, total: 4, ready: 0, incomplete: 4 });
    expect(report.body.data.products[0].missing.length).toBeGreaterThan(0);
    expect((await activate(admin)).status).toBe(409);
    expect((await Settings.get()).productConfigEnforcementEnabled).toBe(false);
  });

  it('activates only after explicit confirmation and every live product is configured', async () => {
    await configureAll();
    const admin = await signIn('LFB0274');
    const invalid = await api(admin.token).post('/admin/products/config-enforcement', { enabled: true, confirmation: 'no' });
    expect(invalid.status).toBe(400);
    const res = await activate(admin);
    expect(res.status).toBe(200);
    expect(res.body.data.enforcementEnabled).toBe(true);
    const report = await api(admin.token).get('/admin/products/config-readiness');
    expect(report.body.data).toMatchObject({ enforcementEnabled: true, total: 4, ready: 4, incomplete: 0 });

    // Unexpected loss of one product's approved agreement prevents new applications.
    await ProductVersion.updateOne({ productId: products.PL._id }, { $unset: { agreementTemplateId: '' } });
    const staff = await signIn('LFB0412');
    const available = await api(staff.token).get('/products');
    expect(available.body.data.map((p) => p.code)).not.toContain('PL');
    const created = await api(staff.token).post('/applications', { productId: String(products.PL._id) });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('requires categorized uploads and selects the product agreement before signing', async () => {
    const legalTemplate = await configureAll();
    await ProductVersion.updateOne({ productId: products.PL._id }, { $set: {
      requiredDocuments: [
        { code: 'invoice', name: 'Invoice', mandatory: true, minFiles: 1, maxFiles: 1, allowedTypes: ['pdf'], maxFileMb: 10, displayOrder: 0 },
        { code: 'front', name: 'Front photograph', mandatory: true, minFiles: 1, maxFiles: 1, allowedTypes: ['jpg', 'png'], maxFileMb: 10, displayOrder: 1 },
      ],
    } });
    const admin = await signIn('LFB0274');
    expect((await activate(admin)).status).toBe(200);
    const staff = await signIn('LFB0412');
    const created = await api(staff.token).post('/applications', { productId: String(products.PL._id) });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await api(staff.token).patch(`/applications/${id}`, { amount: 4500000, tenor: 36, purpose: 'Purchase equipment' })).status).toBe(200);
    expect((await attachPayslip(staff, id)).status).toBe(201);

    const previewUrl = `/applications/${id}/agreement/preview`;
    const missing = await api(staff.token).get(previewUrl);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('DOCUMENTS_REQUIRED');

    const wrong = await request(app()).post(`/api/v1/applications/${id}/documents`).set(authed(staff.token))
      .field('documentCode', 'front').attach('file', Buffer.from('%PDF-test'), 'not-a-photograph.pdf');
    expect(wrong.status).toBe(400);

    const invoice = await request(app()).post(`/api/v1/applications/${id}/documents`).set(authed(staff.token))
      .field('documentCode', 'invoice').attach('file', Buffer.from('%PDF-test'), 'invoice.pdf');
    expect(invoice.status).toBe(201);
    expect(invoice.body.data.documentCode).toBe('invoice');
    expect((await StoredFile.findById(invoice.body.data.id)).documentCode).toBe('invoice');
    expect((await api(staff.token).get(previewUrl)).body.code).toBe('DOCUMENTS_REQUIRED');

    const front = await request(app()).post(`/api/v1/applications/${id}/documents`).set(authed(staff.token))
      .field('documentCode', 'front').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'front.jpg');
    expect(front.status).toBe(201);
    const preview = await api(staff.token).get(previewUrl);
    expect(preview.status).toBe(200);
    expect(preview.body.data.template.id).toBe(String(legalTemplate._id));
    const submitted = await api(staff.token).post(`/applications/${id}/sign-and-submit`, {
      consents: { truth: true, deduct: true, crb: true, sms: true },
      accepted: true, scrolledToEnd: true, password: PASSWORD, textSha256: preview.body.data.textSha256,
    });
    expect(submitted.status).toBe(200);

    // Credit Analysts retain a limited review: attachments are visible but payslip
    // and agreement files remain forbidden by the document-specific access exception.
    const credit = await signIn('LFB0233');
    const creditView = await api(credit.token).get(`/review/${id}`);
    expect(creditView.status).toBe(200);
    expect(creditView.body.data.limited).toBe(true);
    expect(creditView.body.data.documents).toHaveLength(2);
    expect(creditView.body.data.documentChecklist).toHaveLength(2);
    expect((await api(credit.token).get(`/files/${front.body.data.id}?preview=1`)).status).toBe(200);
    const payslip = await StoredFile.findOne({ applicationId: id, kind: 'payslip' });
    expect((await api(credit.token).get(`/files/${payslip._id}`)).status).toBe(404);

    const inline = await api(staff.token).get(`/files/${front.body.data.id}?preview=1`);
    expect(inline.status).toBe(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
  });
});

'use strict';

// English agreement templates: the Staff Personal Loan and Staff Car Loan agreements
// (seed/data/agreements), filled in English, with their declarations as the statements
// ticked at signing.

const fs = require('fs');
const path = require('path');
const { seedAll, attachPayslip, signIn, api } = require('../flows');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const ProductVersion = require('../../src/models/ProductVersion');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const templates = require('../../src/services/agreement/templateService');
const en = require('../../src/services/agreement/english');

const DIR = path.join(__dirname, '..', '..', 'seed', 'data', 'agreements');
const PERSONAL = fs.readFileSync(path.join(DIR, 'staff-personal-loan.en.md'), 'utf8');
const CAR = fs.readFileSync(path.join(DIR, 'staff-car-loan.en.md'), 'utf8');
const SWAHILI = /Tshs|Shilingi|Novemba|Desemba|Januari|Mkopeshaji|Awamu|Makato/; // the sample applicant's fictional name is Swahili, so names are not checked
const VEHICLE = { make: 'Toyota RAV4', year: 2019, seller: 'Arusha Motors Ltd', price: 24500000 };

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const english = (version, body) => AgreementTemplate.create({ version, language: 'en', body, status: 'approved', sample: false, effectiveFrom: new Date('2026-10-01T00:00:00+03:00'), approvedAt: new Date() });

async function draft(person, productId, terms) {
  const a = api(person.token);
  const created = await a.post('/applications', { productId: String(productId) });
  const { id } = created.body.data;
  await a.patch(`/applications/${id}`, { repaymentMethod: 'payroll', ...terms });
  expect((await attachPayslip(person, id)).status).toBe(201);
  const preview = await a.get(`/applications/${id}/agreement/preview`);
  expect(preview.status).toBe(200);
  return { a, id, preview: preview.body.data };
}

describe('English agreement templates', () => {
  it('words amounts and dates in English', () => {
    expect(en.amountInWords(4500000)).toBe('Four million five hundred thousand shillings only');
    expect(en.amountInWords(1000050)).toBe('One million and fifty shillings only');
    expect(en.amountInWords(125432)).toBe('One hundred and twenty-five thousand four hundred and thirty-two shillings only');
    expect(en.dateEn('2026-12-25')).toBe('25 December 2026');
  });

  it('both templates pass the template check in English, with their declarations', async () => {
    const personal = await templates.check(PERSONAL, '2026.12', 'en');
    const car = await templates.check(CAR, '2026.12', 'en');
    expect(personal.declarations).toHaveLength(6);
    expect(car.declarations).toHaveLength(8);
    expect(personal.declarations[0]).toMatch(/^I have read this Staff Loan Agreement in full/);
    expect(car.declarations[4]).toMatch(/^I confirm that I have not made, and will not make, any arrangement to inflate the price/);
    const text = (blocks) => JSON.stringify(blocks);
    expect(text(personal.blocks)).not.toMatch(SWAHILI);
    expect(text(car.blocks)).not.toMatch(SWAHILI);
    expect(text(car.blocks)).toMatch(/Make and model: Mfano X; Year: 2020/);
  });

  it('a Swahili template still renders in Swahili', async () => {
    const { BODY } = require('../../seed/agreementTemplate');
    const out = await templates.check(BODY, '2026.12', 'sw');
    expect(JSON.stringify(out.blocks)).toMatch(/Tshs/);
    expect(out.declarations).toEqual([]);
  });

  it('signing a personal loan needs every declaration of the agreement, and records them', async () => {
    const t = await english('2026.12', PERSONAL);
    await ProductVersion.updateMany({ productId: products.PL._id }, { $set: { agreementTemplateId: t._id } });
    const neema = await signIn('LFB0412');
    const { a, id, preview } = await draft(neema, products.PL._id, { amount: 3000000, tenor: 24, purpose: 'Home repairs' });
    const declarations = preview.blocks.filter((b) => b.type === 'declaration');
    expect(declarations).toHaveLength(6);
    expect(JSON.stringify(preview.blocks)).not.toMatch(SWAHILI);
    expect(JSON.stringify(preview.blocks)).toMatch(/Three million shillings only/);

    const base = { accepted: true, scrolledToEnd: true, textSha256: preview.textSha256 };
    // The four standard statements are not enough when the agreement has its own.
    let res = await a.post(`/applications/${id}/sign-and-submit`, { ...base, consents: { truth: true, deduct: true, crb: true, sms: true } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONSENTS_REQUIRED');
    res = await a.post(`/applications/${id}/sign-and-submit`, { ...base, declarations: [true, true, true, true, true, false] });
    expect(res.status).toBe(400);
    res = await a.post(`/applications/${id}/sign-and-submit`, { ...base, declarations: Array(6).fill(true) });
    expect(res.status).toBe(200);

    const saved = await Application.findById(id).lean();
    expect(saved.consents.declarations).toHaveLength(6);
    expect(saved.consents.declarations[2]).toMatch(/^I irrevocably authorise the Bank/);
    const agreement = await Agreement.findOne({ applicationId: id }).lean();
    expect(agreement.text).toMatch(/\n\[ \] I agree to sign this Agreement electronically/);
  });

  it('the car loan agreement shows the vehicle and seller from the application', async () => {
    const t = await english('2026.12', CAR);
    await ProductVersion.updateMany({ productId: products.VL._id }, { $set: { agreementTemplateId: t._id } });
    const juma = await signIn('LFB0233');
    const { a, id, preview } = await draft(juma, products.VL._id, { amount: 18000000, tenor: 48, purpose: 'Family vehicle', productFields: VEHICLE });
    expect(JSON.stringify(preview.blocks)).toMatch(/Make and model: Toyota RAV4; Year of manufacture: 2019; Seller or dealer: Arusha Motors Ltd; Vehicle price \(TZS\): 24,500,000/);
    const res = await a.post(`/applications/${id}/sign-and-submit`, { accepted: true, scrolledToEnd: true, textSha256: preview.textSha256, declarations: Array(8).fill(true) });
    expect(res.status).toBe(200);
  });

  it('a template without declarations keeps the four standard statements', async () => {
    const neema = await signIn('LFB0412');
    const { a, id, preview } = await draft(neema, products.PL._id, { amount: 3000000, tenor: 24, purpose: 'Home repairs' });
    expect(preview.blocks.some((b) => b.type === 'declaration')).toBe(false);
    const res = await a.post(`/applications/${id}/sign-and-submit`, { accepted: true, scrolledToEnd: true, textSha256: preview.textSha256, consents: { truth: true, deduct: true, crb: true, sms: true } });
    expect(res.status).toBe(200);
  });
});

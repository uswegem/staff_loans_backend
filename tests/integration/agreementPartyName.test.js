'use strict';

// The Employee party names the staff member: "(2) NEEMA MUSHI, whose personal details are
// recorded in the System and shown in the Loan Details (the "Employee")." The name comes
// from the staff record, in capitals and bold, the same as in the Loan Details and the
// acceptance evidence; the rest of the agreement keeps the defined term "Employee".
// Agreements signed on an earlier template keep their text and fingerprint.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { seedAll, attachPayslip, signIn, api, decide, CRB, HR_OK } = require('../flows');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const ProductVersion = require('../../src/models/ProductVersion');
const Agreement = require('../../src/models/Agreement');
const StoredFile = require('../../src/models/StoredFile');
const fileStore = require('../../src/services/files/fileStore');
const { pathToFileURL } = require('url');

jest.setTimeout(180000);

const DIR = path.join(__dirname, '..', '..', 'seed', 'data', 'agreements');
const PERSONAL = fs.readFileSync(path.join(DIR, 'staff-personal-loan.en.md'), 'utf8');
const CAR = fs.readFileSync(path.join(DIR, 'staff-car-loan.en.md'), 'utf8');
// The party line as it was before the name was added (template 2026.12a), in the markup of the time.
const OLD_PERSONAL = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'agreements', 'staff-personal-loan-2026.12c.en.md'), 'utf8').replace('(2) {{partyName}}, whose personal details are recorded in the System', '(2) THE EMPLOYEE whose name and personal details are recorded in the System');
const PARTY = /^\(2\) NEEMA MUSHI, whose personal details are recorded in the System and shown in the Loan Details \(the "Employee"\)\.$/m;
const TERMS = { amount: 3000000, tenor: 24, purpose: 'Home repairs' };

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const english = (version, body) => AgreementTemplate.create({ version, language: 'en', body, status: 'approved', sample: false, effectiveFrom: new Date('2026-10-01T00:00:00+03:00'), approvedAt: new Date() });
const useTemplate = (productId, t) => ProductVersion.updateMany({ productId }, { $set: { agreementTemplateId: t._id } });
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function draft(person) {
  const a = api(person.token);
  const { id } = (await a.post('/applications', { productId: String(products.PL._id) })).body.data;
  await a.patch(`/applications/${id}`, { repaymentMethod: 'payroll', ...TERMS });
  expect((await attachPayslip(person, id)).status).toBe(201);
  return { a, id };
}

const signBody = (preview) => ({ accepted: true, dataProtection: true, scrolledToEnd: true, textSha256: preview.textSha256, declarations: preview.blocks.filter((b) => b.type === 'declaration').map(() => true) });
/** Every page's text, items joined with spaces (the payslip reader stops at three pages). */
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

describe('the Employee party names the staff member', () => {
  it('both English templates use the name in party (2) and keep "Employee" elsewhere', () => {
    for (const body of [PERSONAL, CAR]) {
      expect(body).toMatch(/^\(2\) \{\{partyName\}\}, whose personal details are recorded in the System and shown in the Loan Details \(the "Employee"\)\.$/m);
      expect(body).not.toMatch(/THE EMPLOYEE whose/);
      // The defined term stays in the clauses.
      expect((body.match(/\bEmployee\b/g) || []).length).toBeGreaterThan(30);
    }
  });

  it('preview: the name in capitals and bold in the parties, the same name in the Loan Details', async () => {
    await useTemplate(products.PL._id, await english('2026.12c', PERSONAL));
    const neema = await signIn('LFB0412');
    const { a, id } = await draft(neema);
    const preview = (await a.get(`/applications/${id}/agreement/preview`)).body.data;
    const party = preview.blocks.find((b) => b.type === 'p' && b.parts[0]?.text === '(2) ');
    expect(party.parts[1]).toEqual({ text: 'NEEMA MUSHI', fill: true, strong: true });
    expect(party.parts.map((p) => p.text).join('')).toMatch(PARTY);
    const details = preview.blocks.find((b) => b.type === 'details');
    expect(details.rows[0].label.map((p) => p.text).join('')).toBe('Employee');
    expect(details.rows[0].value.find((p) => p.fill).text).toBe('Neema Mushi');
    // Only the parties use the name; the clauses still say "the Employee".
    const text = preview.blocks.filter((b) => ['p', 'clause'].includes(b.type)).map((b) => b.parts.map((p) => p.text).join('')).join('\n');
    expect(text).toMatch(/The Employee shall repay the loan/);
    expect(text.match(/NEEMA MUSHI/g)).toHaveLength(1);
  });

  it('signing: the agreement text, the evidence and both PDFs show the same name', async () => {
    await useTemplate(products.PL._id, await english('2026.12c', PERSONAL));
    const neema = await signIn('LFB0412');
    const { a, id } = await draft(neema);
    const preview = (await a.get(`/applications/${id}/agreement/preview`)).body.data;
    expect((await a.post(`/applications/${id}/sign-and-submit`, signBody(preview))).status).toBe(200);

    const ag = await Agreement.findOne({ applicationId: id }).lean();
    expect(ag.text).toMatch(PARTY);
    expect(ag.text).toMatch(/^\| Employee \| Neema Mushi, staff number LFB0412/m);
    expect(ag.acceptance.fullName).toBe('Neema Mushi');
    expect(ag.textSha256).toBe(sha(ag.text));
    expect(ag.blocks.some((b) => b.type === 'p' && b.parts.some((p) => p.strong && p.text === 'NEEMA MUSHI'))).toBe(true);
    const signedPdf = await pdfText(ag.pdfFileId);
    expect(signedPdf).toMatch(/\(2\)\s+NEEMA MUSHI\s*, whose personal details/);
    expect(signedPdf).toMatch(/Name: Neema Mushi\s+Staff number: LFB0412/);

    // Through approval: the in-force PDF prints the same text and name.
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
    expect((await decide(await signIn('LFB0002'), id, { action: 'approve' })).body.data.outcome).toBe('approved');
    const inForce = await Agreement.findById(ag._id).lean();
    expect(inForce.status).toBe('in_force');
    expect(inForce.text).toBe(ag.text);
    expect(await pdfText(inForce.inForcePdfFileId)).toMatch(/\(2\)\s+NEEMA MUSHI\s*, whose personal details/);
  });

  it('the agreement cannot be prepared or signed without a full name on the staff record', async () => {
    await useTemplate(products.PL._id, await english('2026.12c', PERSONAL));
    const neema = await signIn('LFB0412');
    const { a, id } = await draft(neema);
    await mongoose.connection.db.collection('staffs').updateOne({ staffNo: 'LFB0412' }, { $set: { lastName: ' ' } });
    const preview = await a.get(`/applications/${id}/agreement/preview`);
    expect(preview.status).toBe(400);
    expect(preview.body.code).toBe('NAME_MISSING');
    const sign = await a.post(`/applications/${id}/sign-and-submit`, { accepted: true, scrolledToEnd: true, textSha256: 'f'.repeat(64), declarations: [true] });
    expect(sign.status).toBe(400);
    expect(sign.body.code).toBe('NAME_MISSING');
    expect(await Agreement.countDocuments({ applicationId: id })).toBe(0);
  });

  it('an agreement signed on the earlier template keeps its text, fingerprint and PDF; new ones use the name', async () => {
    const before = await english('2026.12a', OLD_PERSONAL);
    await useTemplate(products.PL._id, before);
    const neema = await signIn('LFB0412');
    const first = await draft(neema);
    const p1 = (await first.a.get(`/applications/${first.id}/agreement/preview`)).body.data;
    expect((await first.a.post(`/applications/${first.id}/sign-and-submit`, signBody(p1))).status).toBe(200);
    const old = await Agreement.findOne({ applicationId: first.id }).lean();
    expect(old.text).toMatch(/^\(2\) THE EMPLOYEE whose name and personal details/m);
    const snapshot = { text: old.text, textSha256: old.textSha256, pdfSha256: old.pdfSha256, templateVersion: old.templateVersion, acceptance: old.acceptance };

    // The new version comes in for new agreements.
    await useTemplate(products.PL._id, await english('2026.12c', PERSONAL));
    const juma = await signIn('LFB0233');
    const second = await draft(juma);
    const p2 = (await second.a.get(`/applications/${second.id}/agreement/preview`)).body.data;
    expect((await second.a.post(`/applications/${second.id}/sign-and-submit`, signBody(p2))).status).toBe(200);
    const fresh = await Agreement.findOne({ applicationId: second.id }).lean();
    expect(fresh.templateVersion).toBe('2026.12c');
    expect(fresh.text).toMatch(/^\(2\) JUMA KASSIM, whose personal details/m);

    // The earlier agreement is untouched, and still matches its fingerprint.
    const again = await Agreement.findById(old._id).lean();
    expect({ text: again.text, textSha256: again.textSha256, pdfSha256: again.pdfSha256, templateVersion: again.templateVersion, acceptance: again.acceptance }).toEqual(snapshot);
    expect(again.textSha256).toBe(sha(again.text));
    expect(again.blocks).toBeTruthy(); // kept since this change, alongside the text
    const oldPdf = await pdfText(again.pdfFileId);
    expect(oldPdf).toMatch(/THE EMPLOYEE whose name and personal details/);
  });

  it('an agreement stored before blocks were kept still prints from its text', async () => {
    await useTemplate(products.PL._id, await english('2026.12c', PERSONAL));
    const neema = await signIn('LFB0412');
    const { a, id } = await draft(neema);
    const preview = (await a.get(`/applications/${id}/agreement/preview`)).body.data;
    await a.post(`/applications/${id}/sign-and-submit`, signBody(preview));
    // As stored before this change: no blocks.
    await mongoose.connection.db.collection('agreements').updateOne({ applicationId: new mongoose.Types.ObjectId(id) }, { $unset: { blocks: '' } });
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
    expect((await decide(await signIn('LFB0002'), id, { action: 'approve' })).body.data.outcome).toBe('approved');
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    expect(await pdfText(ag.inForcePdfFileId)).toMatch(/\(2\)\s+NEEMA MUSHI\s*, whose personal details/);
  });
});

'use strict';

// D-110: the agreement as a properly formatted, numbered contract with the LFB letterhead.
// Numbering and cross-references by label, no repayment schedule in new agreements (it is
// given on request by Operations and Credit), the PDF layout (logo, one-language footer, no
// heading left alone at a page bottom), the signed copy re-rendered identically, and a
// visual comparison of the personal and car samples with their reference pages.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, PDFName } = require('pdf-lib');
const { api, seedAll, applyAndSign, decide, signIn, CRB, HR_OK } = require('../flows');
const { pages, raster, diff } = require('../pdfRaster');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const ProductVersion = require('../../src/models/ProductVersion');
const AuditLog = require('../../src/models/AuditLog');
const StoredFile = require('../../src/models/StoredFile');
const fileStore = require('../../src/services/files/fileStore');
const calc = require('../../src/services/calc/loanCalculator');
const agreementService = require('../../src/services/agreement/agreementService');
const { render, canonicalText } = require('../../src/services/agreement/renderer');
const { agreementPdf, textBlocks } = require('../../src/services/agreement/pdfService');
const { localDay } = require('../../src/utils/dates');
const { PRICING } = require('../fixtures/products');

jest.setTimeout(240000);

const DIR = path.join(__dirname, '..', '..', 'seed', 'data', 'agreements');
const PERSONAL = fs.readFileSync(path.join(DIR, 'staff-personal-loan.en.md'), 'utf8');
const CAR = fs.readFileSync(path.join(DIR, 'staff-car-loan.en.md'), 'utf8');
const OLD_PERSONAL = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'agreements', 'staff-personal-loan-2026.12c.en.md'), 'utf8');
const VISUAL = path.join(__dirname, '..', 'visual');
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const plainOf = (parts) => parts.map((p) => p.text).join('');

/** A fixed, fictional applicant and quote, so the samples render the same every time. */
function sampleInput(product) {
  const quote = calc.quote({ amount: 4500000, tenor: 36, pay: { basic: 1850000, lfbDeductions: 0 }, pricing: PRICING, startDay: '2026-12-01', dueDay: 25 });
  return {
    ref: 'SL-2026-00042',
    kind: 'original',
    staff: { firstName: 'Asha', lastName: 'Mfano', staffNo: 'TST0042', personal: { address: { house: '12', street: 'Mtaa wa Mfano', ward: 'Buguruni', district: 'Ilala', region: 'Dar-Es-Salaam' }, mobile: '+255700000042' } },
    product,
    fields: { make: 'Toyota Mfano', year: 2021, seller: 'Mfano Motors Ltd' },
    quote,
    amount: 4500000,
    tenor: 36,
    repayment: { method: 'payroll' },
    topUp: { on: false },
  };
}
const PRODUCTS = {
  personal: { name: 'Staff Personal Loan', fields: [] },
  car: { name: 'Staff Car Loan', fields: [{ key: 'make', label: 'Make and model' }, { key: 'year', label: 'Year' }, { key: 'seller', label: 'Seller' }] },
};
const ACCEPTED_AT = new Date('2026-12-01T09:30:00Z');

async function samplePdf(kind) {
  const body = kind === 'car' ? CAR : PERSONAL;
  const version = kind === 'car' ? '2026.12f' : '2026.12e';
  const doc = await agreementService.build(sampleInput(PRODUCTS[kind]), { template: { _id: 'sample', version, body, language: 'en', sample: false } });
  const pdf = await agreementPdf({
    blocks: doc.blocks,
    language: 'en',
    agreementNumber: 'MKT-2026-00042',
    ref: 'SL-2026-00042',
    templateVersion: version,
    textSha256: doc.textSha256,
    acceptance: { fullName: 'Asha Mfano', staffNo: 'TST0042', at: ACCEPTED_AT, ip: '10.0.0.42' },
    approvals: [{ name: 'Fictional Approver', title: 'CEO', stage: 'CEO', at: new Date('2026-12-03T08:00:00Z') }],
    inForceAt: new Date('2026-12-03T08:00:00Z'),
  });
  return { doc, pdf };
}

const english = (version, body) => AgreementTemplate.create({ version, language: 'en', body, status: 'approved', sample: false, effectiveFrom: new Date('2026-10-01T00:00:00+03:00'), approvedAt: new Date() });

describe('numbering and cross-references', () => {
  const values = new Proxy({}, { get: (t, k) => (k === 'partyName' ? [{ text: 'JANE DOE', strong: true }] : `<${String(k)}>`) });

  it('sections and clauses are numbered in order; sub-clauses lettered; references resolve', () => {
    const t = `# T
## {#loan} THE LOAN
+ First.
+ {#deduction} Salary deduction: Second, see {{ref:loan}}.
(a) one;
(z) {#two} two.
## AFTER
+ Under {{ref:deduction}} and {{ref:two}}; clauses {{num:deduction}} and {{num:loan}}.
##* SIGNATURES
Unnumbered.`;
    const out = render(t, values, { language: 'en' });
    expect(out.format).toBe(2);
    expect(out.blocks.filter((b) => b.number).map((b) => [b.type, b.number])).toEqual([['h2', '1.'], ['clause', '1.1'], ['clause', '1.2'], ['sub', '(a)'], ['sub', '(b)'], ['h2', '2.'], ['clause', '2.1']]);
    expect(out.text).toContain('1.2 Salary deduction: Second, see clause 1.');
    expect(out.text).toContain('2.1 Under clause 1.2 and clause 1.2(b); clauses 1.2 and 1');
    expect(out.text).toContain('##* SIGNATURES');
    // The run-in heading is bold, presentation only.
    expect(out.blocks.find((b) => b.number === '1.2').parts[0]).toEqual({ text: 'Salary deduction:', strong: true });
    // In Swahili a reference reads "kifungu".
    expect(render(t, values, { language: 'sw' }).text).toContain('see kifungu 1.');
  });

  it('a template with an unknown or repeated label is refused', () => {
    expect(() => render('## A\n+ See {{ref:nowhere}}.', values)).toThrow('The text refers to an unknown label {{ref:nowhere}}.');
    expect(() => render('## {#a} A\n+ {#a} Twice.', values)).toThrow('The text uses the label {#a} twice.');
    expect(() => render('+ Clause before any section.', values)).toThrow(/must follow a numbered heading/);
  });

  it('both English templates and the Swahili sample number every section and resolve every reference', () => {
    for (const [body, language] of [[PERSONAL, 'en'], [CAR, 'en'], [require('../../seed/agreementTemplate').BODY, 'sw']]) {
      const out = render(body, values, { language });
      const sections = out.blocks.filter((b) => b.type === 'h2' && b.number).map((b) => b.number);
      expect(sections).toEqual(sections.map((_, i) => `${i + 1}.`));
      expect(out.text).not.toMatch(/\{\{|\{#/);
      expect(out.text).not.toMatch(/^\d+\.\d+ \d+\.\d+/m); // no typed numbers left
    }
    const car = render(CAR, values, { language: 'en' }).text;
    expect(car).toContain('8.5 Misconduct: Any matter in clause 8.1(d) is also a breach');
    expect(car).toContain('(clauses 5 and 6)');
  });

});

describe('the repayment schedule is not part of the agreement', () => {
  let products;
  beforeEach(async () => {
    ({ products } = await seedAll());
  });

  it('new agreements have no schedule table, on screen or in the PDF; Loan Details keep the terms', async () => {
    await ProductVersion.updateMany({ productId: products.PL._id }, { $set: { agreementTemplateId: (await english('2026.12e', PERSONAL))._id } });
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, { amount: 3000000, tenor: 24, purpose: 'Home repairs' });
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    expect(ag.format).toBe(2);
    expect(ag.blocks.some((b) => b.type === 'table')).toBe(false);
    expect(ag.text).not.toMatch(/REPAYMENT SCHEDULE|\tBalance/);
    const labels = ag.blocks.find((b) => b.type === 'details').rows.map((r) => plainOf(r.label));
    expect(labels).toEqual(expect.arrayContaining(['Loan amount', 'Period', 'Interest rate', 'Monthly instalment', 'Processing fee', 'Insurance premium', 'Total interest', 'Total amount repayable', 'First instalment due', 'Repayment method']));
    expect(ag.text).toMatch(/^\d+\.\d+ Repayment schedule: A repayment schedule showing each instalment and the balance after it is available to the Employee on request from the Bank's Operations or Credit department\.$/m);
    const text = (await pages(await fileStore.read(await StoredFile.findById(ag.pdfFileId)))).map((p) => p.items.map((i) => i.str).join(' ')).join(' ');
    expect(text).not.toMatch(/Principal\s+Interest\s+Balance/);
  });

  it('a template with {{schedule}} or an unknown label is refused at upload', async () => {
    const officer = await signIn('LFB0188'); // Legal Officer
    const up = await api(officer.token).post('/admin/templates', { version: '2027.01', language: 'en', effectiveFrom: localDay(), body: OLD_PERSONAL });
    expect(up.status).toBe(400);
    expect(up.body.code).toBe('SCHEDULE_NOT_ALLOWED');
    const badRef = await api(officer.token).post('/admin/templates', { version: '2027.02', language: 'en', effectiveFrom: localDay(), body: PERSONAL.replace('{{ref:loan-limits}}', '{{ref:no-such-clause}}') });
    expect(badRef.status).toBe(400);
    expect(badRef.body.code).toBe('TEMPLATE_INVALID');
    expect(badRef.body.message).toBe('The text refers to an unknown label {{ref:no-such-clause}}.');
    expect(await AgreementTemplate.countDocuments({ version: { $in: ['2027.01', '2027.02'] } })).toBe(0);
    expect(() => render(`${PERSONAL}\n##* REPAYMENT SCHEDULE\n{{schedule}}`, agreementService.values(sampleInput(PRODUCTS.personal), 'x', 'en'), { language: 'en' })).toThrow(/not part of the agreement/);
  });

  it('an agreement signed earlier keeps its schedule, text and fingerprint', async () => {
    // As signed before D-110: the legacy text with the schedule as tab-separated rows, no blocks.
    const legacy = render(OLD_PERSONAL.replace('{{schedule}}', 'SCHEDULE_LINE'), agreementService.values(sampleInput(PRODUCTS.personal), '2026.12c', 'en'), { language: 'en' });
    const table = agreementService.scheduleTable(sampleInput(PRODUCTS.personal).quote.schedule, 'en');
    const text = legacy.text.replace('SCHEDULE_LINE', [table.head.join('\t'), ...table.rows.map((r) => r.join('\t'))].join('\n'));
    const pdf = await agreementPdf({ blocks: textBlocks(text), language: 'en', agreementNumber: 'MKT-2026-00001', ref: 'SL-2026-00001', templateVersion: '2026.12c', textSha256: sha(text), acceptance: { fullName: 'Asha Mfano', staffNo: 'TST0042', at: ACCEPTED_AT, ip: '10.0.0.1' } });
    const shown = (await pages(pdf)).map((p) => p.items.map((i) => i.str).join(' ')).join(' ');
    expect(shown).toMatch(/No\.\s+Date\s+Payment\s+Principal\s+Interest\s+Balance/);
    expect(shown).toContain(table.rows[35][1]);
    expect(shown).toContain(sha(text));
  });
});

describe('repayment schedule on request (Operations and Credit)', () => {
  let products;
  beforeEach(async () => {
    ({ products } = await seedAll());
  });

  async function approvedLoan() {
    const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' });
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
    expect((await decide(await signIn('LFB0002'), id, { action: 'approve' })).body.data.outcome).toBe('approved');
    return id;
  }
  const download = async (staffNo, id) => api((await signIn(staffNo)).token).get(`/applications/${id}/repayment-schedule.pdf`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  it('OPS and Credit download it for approved and disbursed loans; totals equal the total repayable; audited', async () => {
    const id = await approvedLoan();
    const ops = await download('LFB0318', id);
    expect(ops.status).toBe(200);
    expect(ops.headers['content-type']).toMatch(/application\/pdf/);
    const ps = await pages(ops.body);
    const text = ps.map((p) => p.items.map((i) => i.str).join(' ')).join(' ');
    expect(text).toMatch(/Ukurasa 1 kati ya \d+|Page 1 of \d+/);
    // Totals row: the sum of the instalments equals the agreement's total amount repayable.
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    const app = await Application.findById(id).lean();
    const total = app.schedule.reduce((s, r) => s + r.payment, 0);
    expect(total).toBe(ag.terms.totalRepayable);
    expect(text).toContain(total.toLocaleString('en-US'));
    expect(await AuditLog.countDocuments({ action: 'schedule.download', entityId: id })).toBe(1);

    expect((await download('LFB0233', id)).status).toBe(200); // Credit Analyst
    await api((await signIn('LFB0318')).token).post(`/disbursements/${id}/confirm`, { date: localDay(), transactionRef: 'FT1', comment: 'Paid.' });
    expect((await Application.findById(id)).status).toBe('disbursed');
    expect((await download('LFB0318', id)).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'schedule.download', entityId: id })).toBe(3);
  });

  it('the applicant and other roles get 403; before final approval there is none', async () => {
    const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' });
    expect((await download('LFB0318', id)).status).toBe(409);
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
    await decide(await signIn('LFB0002'), id, { action: 'approve' });
    expect((await download('LFB0412', id)).status).toBe(403); // the applicant
    expect((await download('LFB0067', id)).status).toBe(403); // Head of Risk (D-112: the Head of P&C now holds disb.confirm)
    expect((await download('LFB0002', id)).status).toBe(403); // CEO
    expect(await AuditLog.countDocuments({ action: 'schedule.download' })).toBe(0);
  });
});

describe('the agreement PDF', () => {
  it('page 1 carries the logo; every page has a one-language footer; no heading ends a page', async () => {
    for (const kind of ['personal', 'car']) {
      // eslint-disable-next-line no-await-in-loop
      const { doc, pdf } = await samplePdf(kind);
      // eslint-disable-next-line no-await-in-loop
      const loaded = await PDFDocument.load(pdf);
      const first = loaded.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
      expect(first && first.keys().length).toBeGreaterThan(0);
      // eslint-disable-next-line no-await-in-loop
      const ps = await pages(pdf);
      expect(ps.length).toBeGreaterThan(3);
      ps.forEach((p, i) => {
        const text = p.items.map((it) => it.str).join(' ');
        expect(text).toContain(`Page ${i + 1} of ${ps.length}`);
        expect(text).toContain('Agreement MKT-2026-00042 · Application SL-2026-00042');
        expect(text).not.toMatch(/Ukurasa|kati ya/);
      });
      // The last body line of each page is never a section heading.
      const headings = new Set(doc.blocks.filter((b) => b.type === 'h2').map((b) => plainOf(b.parts)));
      ps.slice(0, -1).forEach((p) => {
        const body = p.items.filter((it) => it.y > 70 && it.y < p.height - 100);
        const lowest = Math.min(...body.map((it) => it.y));
        const lastLine = body.filter((it) => Math.abs(it.y - lowest) < 2).map((it) => it.str).join(' ').trim();
        expect(headings.has(lastLine)).toBe(false);
      });
    }
  });

  it('in Swahili the footer reads "Ukurasa X kati ya Y" and nothing around the agreement is English', async () => {
    const { BODY } = require('../../seed/agreementTemplate');
    const doc = await agreementService.build(sampleInput(PRODUCTS.personal), { template: { _id: 'sample', version: '2026.12g', body: BODY, language: 'sw', sample: true } });
    const pdf = await agreementPdf({ blocks: doc.blocks, language: 'sw', agreementNumber: 'MKT-2026-00043', ref: 'SL-2026-00043', templateVersion: '2026.12g', textSha256: doc.textSha256, acceptance: { fullName: 'Asha Mfano', staffNo: 'TST0042', at: ACCEPTED_AT, ip: '10.0.0.42' } });
    const ps = await pages(pdf);
    ps.forEach((p, i) => expect(p.items.map((it) => it.str).join(' ')).toContain(`Ukurasa ${i + 1} kati ya ${ps.length}`));
    const all = ps.map((p) => p.items.map((it) => it.str).join(' ')).join(' ');
    expect(all).toContain('Sahihi na ushahidi wa kukubali');
    expect(all).not.toMatch(/Page \d|Signatures|Electronic acceptance|Staff number/);
  });

  it('a signed agreement re-rendered later is identical: same fingerprint, same layout', async () => {
    const a = await samplePdf('personal');
    const b = await samplePdf('personal');
    expect(a.doc.textSha256).toBe(b.doc.textSha256);
    expect(canonicalText(a.doc.blocks, 2)).toBe(a.doc.text);
    expect(sha(canonicalText(a.doc.blocks, 2))).toBe(a.doc.textSha256);
    expect(Buffer.compare(a.pdf, b.pdf)).toBe(0);
  });

  it('visual regression: the personal and car samples match their reference pages', async () => {
    for (const kind of ['personal', 'car']) {
      // eslint-disable-next-line no-await-in-loop
      const { pdf } = await samplePdf(kind);
      // eslint-disable-next-line no-await-in-loop
      const pngs = await raster(pdf, 1);
      pngs.forEach((png, i) => {
        const ref = path.join(VISUAL, `${kind}-page-${i + 1}.png`);
        if (process.env.UPDATE_VISUAL === '1' || !fs.existsSync(ref)) {
          if (process.env.CI) throw new Error(`Reference page missing in CI: ${path.basename(ref)}. Run UPDATE_VISUAL=1 npm test locally and commit tests/visual.`);
          fs.writeFileSync(ref, png);
        }
        expect([path.basename(ref), diff(png, fs.readFileSync(ref)) < 0.002]).toEqual([path.basename(ref), true]);
      });
      // No reference pages left over from a longer layout.
      expect(fs.existsSync(path.join(VISUAL, `${kind}-page-${pngs.length + 1}.png`))).toBe(false);
    }
  });
});

describe('the agreement logo (System Administrator)', () => {
  beforeEach(async () => {
    await seedAll();
  });

  it('replaces the logo with a PNG or JPG, uses it on new PDFs, goes back to the default; audited', async () => {
    const admin = api((await signIn('LFB0274')).token);
    const { app: server, authed, request } = require('../helpers');
    const token = (await signIn('LFB0274')).token;
    expect((await admin.get('/admin/settings/agreement-logo')).body.data).toMatchObject({ custom: false });
    const png = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'agreement', 'lfb-logo.png'));
    const bad = await request(server()).put('/api/v1/admin/settings/agreement-logo').set(authed(token)).attach('file', Buffer.from('%PDF-1.4 x'), 'logo.pdf');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('FILE_TYPE');
    const ok = await request(server()).put('/api/v1/admin/settings/agreement-logo').set(authed(token)).attach('file', png, 'new-logo.png');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ custom: true, originalName: 'new-logo.png' });
    expect(await AuditLog.countDocuments({ action: 'settings.agreement_logo' })).toBe(1);
    const { pdf } = await samplePdf('personal');
    expect(pdf.length).toBeGreaterThan(1000);
    const reset = await admin.delete('/admin/settings/agreement-logo');
    expect(reset.body.data).toMatchObject({ custom: false });
    expect(await AuditLog.countDocuments({ action: 'settings.agreement_logo' })).toBe(2);
    // Only administrators may change it.
    const staff = await request(server()).put('/api/v1/admin/settings/agreement-logo').set(authed((await signIn('LFB0412')).token)).attach('file', png, 'x.png');
    expect(staff.status).toBe(403);
  });
});

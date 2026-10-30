'use strict';

// Agreement template versions (FR-40, FR-61; prototype #/admin/templates).

const { api, seedAll, signIn, applyAndSign } = require('../flows');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const Agreement = require('../../src/models/Agreement');
const AuditLog = require('../../src/models/AuditLog');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(120000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const DAY = 24 * 3600 * 1000;
const body = async () => (await AgreementTemplate.findOne({ version: '2026.11' })).body.replace('# MKATABA WA MKOPO WA MWAJIRIWA', '# MKATABA WA MKOPO WA MWAJIRIWA (TOLEO JIPYA)');

describe('agreement templates (FR-40)', () => {
  it('lists versions with their state and agreement counts; only admin.templates', async () => {
    const peter = await signIn('LFB0274');
    const r = await api(peter.token).get('/admin/templates');
    expect(r.body.data.items).toEqual([expect.objectContaining({ version: '2026.11', state: 'current', sample: true, legalApproved: true, agreements: 0 })]);
    expect((await api((await signIn('LFB0051')).token).get('/admin/templates')).status).toBe(403);
  });

  it('checks the text by rendering a sample before loading it', async () => {
    const peter = await signIn('LFB0274');
    const a = api(peter.token);
    const bad = await a.post('/admin/templates/preview', { body: '# Mkataba\n{{amount}} {{madeUp}}' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/unknown value \{\{madeUp\}\}/);
    const incomplete = await a.post('/admin/templates/preview', { body: '# Mkataba\n{{amount}}' });
    expect(incomplete.body.code).toBe('TEMPLATE_INCOMPLETE');
    expect(incomplete.body.message).toMatch(/\{\{ref\}\}.*\{\{schedule\}\}/);
    const ok = await a.post('/admin/templates/preview', { body: await body() });
    expect(ok.status).toBe(200);
    expect(ok.body.data.blocks[0]).toMatchObject({ type: 'h1' });
    expect(ok.body.data.blocks.some((b) => b.type === 'table')).toBe(true);
  });

  it('needs Legal approval and a new version number; loads from a date; new agreements use it', async () => {
    const peter = await signIn('LFB0274');
    const a = api(peter.token);
    const text = await body();
    const today = localDay();
    const tomorrow = localDay(new Date(Date.now() + DAY));
    expect((await a.post('/admin/templates', { version: '2027.01', effectiveFrom: today, body: text, legalApproved: false })).body.code).toBe('LEGAL_APPROVAL_REQUIRED');
    expect((await a.post('/admin/templates', { version: '2026.11', effectiveFrom: today, body: text, legalApproved: true })).body.code).toBe('VERSION_EXISTS');
    expect((await a.post('/admin/templates', { version: 'v2', effectiveFrom: today, body: text, legalApproved: true })).status).toBe(400);

    // Scheduled for tomorrow: today's agreements stay on 2026.11.
    const later = await a.post('/admin/templates', { version: '2027.01', effectiveFrom: tomorrow, body: text, legalApproved: true, legalApprovalRef: 'LEG/2026/114', note: 'New title' });
    expect(later.status).toBe(201);
    let list = (await a.get('/admin/templates')).body.data.items;
    expect(list.map((t) => [t.version, t.state])).toEqual([['2027.01', 'scheduled'], ['2026.11', 'current']]);

    // From today: it becomes current and the next signed agreement uses it.
    const now = await a.post('/admin/templates', { version: '2027.02', effectiveFrom: today, body: text, legalApproved: true });
    expect(now.status).toBe(201);
    list = (await a.get('/admin/templates')).body.data.items;
    expect(list.find((t) => t.version === '2027.02').state).toBe('current');
    expect(list.find((t) => t.version === '2026.11').state).toBe('retired');
    expect(await AuditLog.countDocuments({ action: 'template.load' })).toBe(2);

    const neema = await signIn('LFB0412');
    await applyAndSign(neema, products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture' });
    const ag = await Agreement.findOne();
    expect(ag.templateVersion).toBe('2027.02');
    expect(ag.text).toContain('(TOLEO JIPYA)');
  });
});

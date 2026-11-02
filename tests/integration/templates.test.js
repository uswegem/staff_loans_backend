'use strict';

// Agreement template versions (FR-40, FR-61, D-88; prototype #/admin/templates). The Legal
// Officer (LFB0188) uploads and edits; the Head of Legal (LFB0451) approves or rejects.

const { api, seedAll, signIn, applyAndSign } = require('../flows');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const Agreement = require('../../src/models/Agreement');
const AuditLog = require('../../src/models/AuditLog');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');
const User = require('../../src/models/User');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(120000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const DAY = 24 * 3600 * 1000;
const body = async () => (await AgreementTemplate.findOne({ version: '2026.11' })).body.replace('# MKATABA WA MKOPO WA MWAJIRIWA', '# MKATABA WA MKOPO WA MWAJIRIWA (TOLEO JIPYA)');
const legal = async () => api((await signIn('LFB0188')).token);
const headLegal = async () => api((await signIn('LFB0451')).token);

describe('agreement templates (FR-40, D-88)', () => {
  it('lists versions with their status and agreement counts; Legal only', async () => {
    const r = await (await legal()).get('/admin/templates');
    expect(r.body.data.items).toEqual([expect.objectContaining({ version: '2026.11', status: 'approved', statusLabel: 'Approved', state: 'current', sample: true, agreements: 0 })]);
    expect((await (await headLegal()).get('/admin/templates')).status).toBe(200);
    expect((await api((await signIn('LFB0051')).token).get('/admin/templates')).status).toBe(403);
    // The System Administrator no longer loads templates.
    expect((await api((await signIn('LFB0274')).token).get('/admin/templates')).status).toBe(403);
  });

  it('checks the text by rendering a sample before saving it', async () => {
    const a = await legal();
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

  it('an upload waits as Pending Legal Approval and is not used until the Head of Legal approves it', async () => {
    const a = await legal();
    const text = await body();
    const today = localDay();
    expect((await a.post('/admin/templates', { version: '2026.11', effectiveFrom: today, body: text })).body.code).toBe('VERSION_EXISTS');
    expect((await a.post('/admin/templates', { version: 'v2', effectiveFrom: today, body: text })).status).toBe(400);
    // The Head of Legal cannot upload.
    expect((await (await headLegal()).post('/admin/templates', { version: '2027.01', effectiveFrom: today, body: text })).status).toBe(403);

    const up = await a.post('/admin/templates', { version: '2027.01', effectiveFrom: today, body: text, note: 'New title' });
    expect(up.status).toBe(201);
    expect(up.body.data.status).toBe('pending_legal_approval');
    let list = (await a.get('/admin/templates')).body.data.items;
    expect(list.map((t) => [t.version, t.statusLabel])).toEqual([['2027.01', 'Pending Legal Approval'], ['2026.11', 'Approved']]);
    expect((await AgreementTemplate.active()).version).toBe('2026.11');

    // The Legal Officer cannot approve.
    expect((await a.post(`/admin/templates/${up.body.data.id}/approve`)).status).toBe(403);
    const h = await headLegal();
    expect((await h.post(`/admin/templates/${up.body.data.id}/approve`)).body.data.status).toBe('approved');
    list = (await a.get('/admin/templates')).body.data.items;
    expect(list.find((t) => t.version === '2027.01').state).toBe('current');
    expect(list.find((t) => t.version === '2026.11').state).toBe('retired');
    expect(await AuditLog.countDocuments({ action: 'template.upload' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'template.approve' })).toBe(1);

    const neema = await signIn('LFB0412');
    await applyAndSign(neema, products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture' });
    const ag = await Agreement.findOne();
    expect(ag.templateVersion).toBe('2027.01');
    expect(ag.text).toContain('(TOLEO JIPYA)');
  });

  it('a pending version never generates agreements', async () => {
    const a = await legal();
    await a.post('/admin/templates', { version: '2027.01', effectiveFrom: localDay(), body: await body() });
    const neema = await signIn('LFB0412');
    await applyAndSign(neema, products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture' });
    expect((await Agreement.findOne()).templateVersion).toBe('2026.11');
  });

  it('rejection needs a reason; the Legal Officer edits and it waits for approval again', async () => {
    const a = await legal();
    const h = await headLegal();
    const up = await a.post('/admin/templates', { version: '2027.01', effectiveFrom: localDay(), body: await body() });
    const id = up.body.data.id;
    expect((await h.post(`/admin/templates/${id}/reject`, { reason: ' ' })).body.code).toBe('REASON_REQUIRED');
    expect((await h.post(`/admin/templates/${id}/reject`, { reason: 'Clause 7 cites the old policy.' })).body.data.status).toBe('rejected');
    const row = (await a.get('/admin/templates')).body.data.items.find((t) => t.id === id);
    expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'Clause 7 cites the old policy.' });
    const edited = await a.put(`/admin/templates/${id}`, { body: (await body()).replace('(TOLEO JIPYA)', '(TOLEO JIPYA 2)') });
    expect(edited.body.data.status).toBe('pending_legal_approval');
    expect(await AuditLog.countDocuments({ action: 'template.reject' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'template.edit' })).toBe(1);
  });

  it('editing an approved version creates a new version; the approved one stays in use', async () => {
    const a = await legal();
    const current = await AgreementTemplate.findOne({ version: '2026.11' });
    const text = await body();
    expect((await a.put(`/admin/templates/${current._id}`, { body: text })).body.code).toBe('NEW_VERSION_REQUIRED');
    const next = await a.put(`/admin/templates/${current._id}`, { version: '2027.01', body: text });
    expect(next.body.data).toMatchObject({ version: '2027.01', status: 'pending_legal_approval' });
    expect((await AgreementTemplate.findById(current._id)).body).not.toContain('(TOLEO JIPYA)');
    expect((await AgreementTemplate.active()).version).toBe('2026.11');
  });

  it('nobody approves a version they uploaded or edited', async () => {
    const officer = await User.findOne({ staffNo: 'LFB0188' });
    await RoleAssignment.create({ userId: officer._id, roleId: (await Role.findOne({ code: 'head_legal' }))._id });
    const both = api((await signIn('LFB0188')).token);
    const up = await both.post('/admin/templates', { version: '2027.01', effectiveFrom: localDay(new Date(Date.now() + DAY)), body: await body() });
    const res = await both.post(`/admin/templates/${up.body.data.id}/approve`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_SELF_APPROVAL');
    expect((await (await headLegal()).post(`/admin/templates/${up.body.data.id}/approve`)).status).toBe(200);
  });
});

'use strict';

// D-105: the Credit Analyst attaches one or more credit bureau report files (PDF, JPG, PNG;
// up to 10 MB each; at most ten), sees and removes their own before deciding; approving at
// the credit stage needs the outcome, the report date and at least one file.

const { api, seedAll, applyAndSign, attachCrb, CRB_PDF, decide, signIn, CRB, HR_OK } = require('../flows');
const { app, authed, request } = require('../helpers');
const Application = require('../../src/models/Application');
const StoredFile = require('../../src/models/StoredFile');
const AuditLog = require('../../src/models/AuditLog');

jest.setTimeout(120000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const submitted = async () => applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);

describe('credit bureau reports (D-105)', () => {
  it('approving needs at least one file; returning and rejecting do not', async () => {
    const id = await submitted();
    const juma = await signIn('LFB0233');
    const refused = await decide(juma, id, { action: 'approve', crb: CRB, crbFile: false });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('CRB_FILE_REQUIRED');
    expect((await Application.findById(id)).status).toBe('pending_credit');
    // Return without a file is allowed.
    expect((await decide(juma, id, { action: 'return', comment: 'Correct your purpose.', crbFile: false })).body.data.outcome).toBe('returned');
  });

  it('files are added, not replaced, and every one is listed for later reviewers', async () => {
    const id = await submitted();
    const juma = await signIn('LFB0233');
    const first = await attachCrb(juma, id, 'creditinfo.pdf');
    const second = await attachCrb(juma, id, 'tracecorp.pdf');
    expect([first.status, second.status]).toEqual([201, 201]);
    const a = await Application.findById(id).lean();
    expect(a.crb.fileIds.map(String)).toEqual([first.body.data.id, second.body.data.id]);
    expect((await api(juma.token).get(`/review/${id}`)).body.data.crbReports.map((f) => f.originalName)).toEqual(['creditinfo.pdf', 'tracecorp.pdf']);

    expect((await decide(juma, id, { action: 'approve', crb: CRB })).body.data.outcome).toBe('moved');
    const after = await Application.findById(id).lean();
    expect(after.crb).toMatchObject({ outcome: 'Low Risk' });
    expect(after.crb.fileIds).toHaveLength(2);
    // The People and Culture reviewer sees both files.
    const grace = await signIn('LFB0051');
    expect((await api(grace.token).get(`/review/${id}`)).body.data.crbReports).toHaveLength(2);
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
  });

  it('the Credit Analyst removes their own file before deciding; audited', async () => {
    const id = await submitted();
    const juma = await signIn('LFB0233');
    const keep = await attachCrb(juma, id, 'keep.pdf');
    const drop = await attachCrb(juma, id, 'wrong-person.pdf');
    const del = await api(juma.token).delete(`/review/${id}/crb-report/${drop.body.data.id}`);
    expect(del.status).toBe(204);
    expect((await Application.findById(id).lean()).crb.fileIds.map(String)).toEqual([keep.body.data.id]);
    expect((await StoredFile.findById(drop.body.data.id)).removedAt).toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'review.crb_report_add' })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'review.crb_report_remove' })).toBe(1);
    // After the decision, no more changes at this stage.
    await decide(juma, id, { action: 'approve', crb: CRB });
    expect((await api(juma.token).delete(`/review/${id}/crb-report/${keep.body.data.id}`)).status).toBe(403);
    expect((await attachCrb(juma, id)).status).toBe(403);
  });

  it('only the person who attached a file can remove it', async () => {
    const id = await submitted();
    const juma = await signIn('LFB0233');
    const f = await attachCrb(juma, id);
    const neema = await signIn('LFB0412');
    expect([403, 404]).toContain((await api(neema.token).delete(`/review/${id}/crb-report/${f.body.data.id}`)).status);
    expect((await Application.findById(id).lean()).crb.fileIds).toHaveLength(1);
  });

  it('refuses an eleventh file, a file over 10 MB and other file types', async () => {
    const id = await submitted();
    const juma = await signIn('LFB0233');
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await attachCrb(juma, id, `report-${i}.pdf`)).status).toBe(201);
    }
    const eleventh = await attachCrb(juma, id, 'one-too-many.pdf');
    expect(eleventh.status).toBe(400);
    expect(eleventh.body.code).toBe('CRB_FILE_LIMIT');
    const big = Buffer.concat([CRB_PDF, Buffer.alloc(10 * 1024 * 1024 + 1, 32)]);
    const large = await request(app()).post(`/api/v1/review/${id}/crb-report`).set(authed(juma.token)).attach('file', big, 'big.pdf');
    expect(large.status).toBe(400);
    expect(large.body.code).toBe('FILE_TOO_LARGE');
    const word = await request(app()).post(`/api/v1/review/${id}/crb-report`).set(authed(juma.token)).attach('file', Buffer.from('hello'), 'notes.docx');
    expect(word.status).toBe(400);
  });

  it('an application with the single file kept before D-105 still counts it and can add more', async () => {
    const id = await submitted();
    const juma = await signIn('LFB0233');
    const f = await attachCrb(juma, id, 'old.pdf');
    // As stored before D-105: crb.fileId only.
    await Application.collection.updateOne({ _id: (await Application.findById(id))._id }, { $set: { 'crb.fileId': (await StoredFile.findById(f.body.data.id))._id }, $unset: { 'crb.fileIds': '' } });
    expect((await api(juma.token).get(`/review/${id}`)).body.data.crbReports.map((x) => x.originalName)).toEqual(['old.pdf']);
    const more = await attachCrb(juma, id, 'new.pdf');
    expect(more.status).toBe(201);
    expect((await Application.findById(id).lean()).crb.fileIds).toHaveLength(2);
    expect((await decide(juma, id, { action: 'approve', crb: CRB })).body.data.outcome).toBe('moved');
  });
});

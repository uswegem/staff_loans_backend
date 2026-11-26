'use strict';

// D-113: Credit Underwriting recommends; People and Culture or the CEO decides. The credit
// stage returns, recommends approval or recommends rejection (never approves or rejects);
// the later stages approve, return or reject, and going against the recommendation needs a
// reason. The applicant never sees the recommendation.

const { api, seedAll, applyAndSign, attachCrb, signIn, CRB, HR_OK } = require('../flows');
const Application = require('../../src/models/Application');
const AuditLog = require('../../src/models/AuditLog');
const Decision = require('../../src/models/Decision');
const DobChange = require('../../src/models/DobChange');
const Notification = require('../../src/models/Notification');
const Staff = require('../../src/models/Staff');
const User = require('../../src/models/User');
const calc = require('../../src/services/calc/loanCalculator');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(240000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const REASON = 'Bureau shows recent defaults on another lender.';
const userId = async (staffNo) => String((await User.findOne({ staffNo }))._id);
const post = (person, id, body) => api(person.token).post(`/review/${id}/decision`, body);
const NOT_ALLOWED_CREDIT = 'Credit Underwriting recommends; People and Culture or the CEO decides.';

/** Applies as staffNo and attaches a bureau report as Juma (Credit Analyst). */
async function atCredit(staffNo = 'LFB0412', { file = true } = {}) {
  const id = await applyAndSign(await signIn(staffNo), products.PL._id, TERMS);
  const juma = await signIn('LFB0233');
  if (file) await attachCrb(juma, id);
  return { id, juma };
}

describe('Credit Underwriting recommends (D-113)', () => {
  it('approve and reject are refused at the credit stage; the panel offers the three actions', async () => {
    const { id, juma } = await atCredit();
    expect((await api(juma.token).get(`/review/${id}`)).body.data.panel.actions).toEqual(['return', 'recommend_approval', 'recommend_rejection']);
    for (const action of ['approve', 'reject']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(juma, id, { action, crb: CRB, comment: REASON });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NOT_ALLOWED_AT_STAGE', message: NOT_ALLOWED_CREDIT });
    }
    expect((await Application.findById(id)).status).toBe('pending_credit');
  });

  it('either recommendation needs a bureau report file; rejection needs a reason of 10 to 1000 characters', async () => {
    const { id, juma } = await atCredit('LFB0412', { file: false });
    for (const action of ['recommend_approval', 'recommend_rejection']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(juma, id, { action, crb: CRB, comment: REASON });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CRB_FILE_REQUIRED');
    }
    await attachCrb(juma, id);
    for (const comment of [undefined, 'Too short']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(juma, id, { action: 'recommend_rejection', crb: CRB, comment });
      expect(res.status).toBe(400);
      expect(res.body.details.comment).toEqual(['Give the reason for recommending rejection.']);
    }
    expect((await post(juma, id, { action: 'recommend_rejection', crb: CRB, comment: 'x'.repeat(1001) })).status).toBe(400);
    expect((await post(juma, id, { action: 'recommend_approval', comment: '' })).body.code).toBe('CRB_REQUIRED');
  });

  it('a failed eligibility check blocks recommending approval but not recommending rejection', async () => {
    const { id, juma } = await atCredit();
    // A corrected date of birth, verified: about 12 months are left before the cutoff.
    const staff = await Staff.findOne({ staffNo: 'LFB0412' });
    await api((await signIn('LFB0051')).token).post(`/staff/${staff._id}/date-of-birth`, { dob: calc.addMonthsToDay(localDay(), 12 - 720 + 2) });
    await api((await signIn('LFB0129')).token).post(`/dob-verifications/${(await DobChange.findOne({ status: 'pending' }))._id}/approve`);

    const blocked = await post(juma, id, { action: 'recommend_approval', crb: CRB });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toBe("This application cannot be recommended for approval: the applicant's retirement cutoff no longer allows its terms. Recommend rejection or return it.");
    const ok = await post(juma, id, { action: 'recommend_rejection', crb: CRB, comment: REASON });
    expect(ok.status).toBe(200);
    expect(ok.body.data.outcome).toBe('moved');
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_pc', currentStage: 'pc' });
  });

  it.each([
    ['nonmgmt', 'LFB0412', 'recommend_approval', 'pending_pc', 'pc'],
    ['mgmt', 'LFB0067', 'recommend_rejection', 'pending_pc', 'pc'],
    ['hrhead', 'LFB0051', 'recommend_approval', 'pending_pc', 'pc'],
    ['ceo', 'LFB0002', 'recommend_rejection', 'pending_hr', 'hr'],
  ])('%s route: a recommendation moves the application to the next stage, signed and open', async (route, staffNo, action, status, stage) => {
    const { id, juma } = await atCredit(staffNo);
    const res = await post(juma, id, { action, crb: CRB, comment: action === 'recommend_rejection' ? REASON : '' });
    expect(res.status).toBe(200);
    const a = await Application.findById(id).lean();
    expect(a).toMatchObject({ route, status, currentStage: stage, creditRecommendation: { outcome: action === 'recommend_approval' ? 'approve' : 'reject', crbOutcome: CRB.outcome, cycle: a.cycle } });
    expect(String(a.creditRecommendation.by)).toBe(await userId('LFB0233'));
    const d = await Decision.findOne({ applicationId: id, stage: 'credit' }).lean();
    expect(d).toMatchObject({ action, details: { crb: { outcome: CRB.outcome } } });
    const log = await AuditLog.findOne({ action: 'application.recommended', entityId: String(id) }).lean();
    expect(log.description).toMatch(new RegExp(`recommended for ${action === 'recommend_approval' ? 'approval' : 'rejection'} by Credit Underwriting`));
    if (action === 'recommend_rejection') expect(log.description).toContain(REASON);
  });

  it('return to the applicant still works at the credit stage', async () => {
    const { id, juma } = await atCredit();
    const res = await post(juma, id, { action: 'return', comment: 'Attach a clearer payslip.' });
    expect(res.body.data.outcome).toBe('returned');
    expect((await Application.findById(id)).status).toBe('returned');
  });
});

describe('the deciding stages respect the recommendation (D-113)', () => {
  async function recommended(action) {
    const { id, juma } = await atCredit();
    expect((await post(juma, id, { action, crb: CRB, comment: action === 'recommend_rejection' ? REASON : '' })).status).toBe(200);
    return { id, grace: await signIn('LFB0051'), juma };
  }

  it('recommend_* is refused at the deciding stages; the recommendation box data is shown', async () => {
    const { id, grace } = await recommended('recommend_rejection');
    const res = await post(grace, id, { action: 'recommend_approval', hrChecks: HR_OK });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ALLOWED_AT_STAGE');
    const view = (await api(grace.token).get(`/review/${id}`)).body.data;
    expect(view.panel.actions).toEqual(['approve', 'return', 'reject']);
    expect(view.creditRecommendation).toMatchObject({ outcome: 'reject', reason: REASON, crbOutcome: CRB.outcome, by: 'Juma Kassim' });
    expect(view.history.find((h) => h.stage === 'credit')).toMatchObject({ action: 'recommend_rejection', comment: REASON });
  });

  it('approving against a recommended rejection needs a reason; it is marked and audited', async () => {
    const { id, grace } = await recommended('recommend_rejection');
    const bare = await post(grace, id, { action: 'approve', hrChecks: HR_OK });
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ code: 'COMMENT_REQUIRED_AGAINST_RECOMMENDATION', message: "Give the reason for approving against Credit's recommendation." });
    expect((await post(grace, id, { action: 'approve', hrChecks: HR_OK, comment: 'Short' })).status).toBe(400);
    const ok = await post(grace, id, { action: 'approve', hrChecks: HR_OK, comment: 'Defaults were settled; letters attached.' });
    expect(ok.status).toBe(200);
    expect((await Decision.findOne({ applicationId: id, stage: 'pc' }).lean()).details.againstRecommendation).toBe(true);
    expect(await AuditLog.exists({ action: 'review.approve', entityId: String(id), description: /against Credit's recommendation/ })).toBeTruthy();
  });

  it('rejecting against a recommended approval needs a reason; rejecting a recommended rejection works as before', async () => {
    const first = await recommended('recommend_approval');
    const bare = await post(first.grace, first.id, { action: 'reject', comment: 'No' });
    expect(bare.body.code).toBe('COMMENT_REQUIRED_AGAINST_RECOMMENDATION');
    const ok = await post(first.grace, first.id, { action: 'reject', comment: 'Probation not complete; apply later.' });
    expect(ok.body.data.outcome).toBe('rejected');
    expect((await Decision.findOne({ applicationId: first.id, stage: 'pc' }).lean()).details.againstRecommendation).toBe(true);

    await Application.deleteMany({});
    const second = await recommended('recommend_rejection');
    const res = await post(second.grace, second.id, { action: 'reject', comment: 'As Credit recommended.' });
    expect(res.body.data.outcome).toBe('rejected');
    expect((await Decision.findOne({ applicationId: second.id, stage: 'pc' }).lean()).details.againstRecommendation).toBeUndefined();
  });

  it('a return to Credit, then a new recommendation, replaces the old one', async () => {
    const { id, grace, juma } = await recommended('recommend_rejection');
    expect((await post(grace, id, { action: 'return', returnTo: 'credit', comment: 'Check the bureau report again.' })).body.data.outcome).toBe('returned_to_stage');
    expect((await post(juma, id, { action: 'recommend_approval', crb: CRB })).status).toBe(200);
    expect((await Application.findById(id).lean()).creditRecommendation.outcome).toBe('approve');
    // Approving now follows the recommendation: no reason needed.
    expect((await post(grace, id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
    expect(await Decision.countDocuments({ applicationId: id, action: { $in: ['recommend_approval', 'recommend_rejection'] } })).toBe(2);
  });

  it('an application approved by Credit before D-113 shows no recommendation and needs no reason', async () => {
    const { id, juma } = await atCredit();
    await post(juma, id, { action: 'recommend_approval', crb: CRB });
    await Application.updateOne({ _id: id }, { $unset: { creditRecommendation: 1 } });
    // Old data: written directly (decisions are append-only through the model).
    await Decision.collection.updateOne({ applicationId: id, stage: 'credit' }, { $set: { action: 'approve' } });
    const grace = await signIn('LFB0051');
    expect((await api(grace.token).get(`/review/${id}`)).body.data.creditRecommendation).toBeNull();
    expect((await post(grace, id, { action: 'reject', comment: 'Probation not complete.' })).status).toBe(200);
  });
});

describe('the applicant never sees the recommendation (D-113)', () => {
  it('not in the application, its history or any notification', async () => {
    const { id, juma } = await atCredit();
    await post(juma, id, { action: 'recommend_rejection', crb: CRB, comment: REASON });
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).get(`/applications/${id}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/recommend|Bureau shows recent defaults/i);
    expect(res.body.data.history.find((h) => h.stage === 'credit')).toMatchObject({ action: 'reviewed', comment: null });
    const notes = await Notification.find({ userId: await userId('LFB0412') }).lean();
    expect(notes.map((n) => n.text).join(' ')).not.toMatch(/recommend|rejection|defaults/i);
  });
});

describe('reports and the Loan Summary name the recommendation (D-113)', () => {
  it('the register shows the recommendation and whether the final decision went against it; the summary trail names both', async () => {
    const { id, juma } = await atCredit();
    await post(juma, id, { action: 'recommend_rejection', crb: CRB, comment: REASON });
    await post(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK, comment: 'Defaults were settled; letters attached.' });
    // Each deciding stage that goes against the recommendation gives its reason, the CEO too.
    expect((await post(await signIn('LFB0002'), id, { action: 'approve' })).body.code).toBe('COMMENT_REQUIRED_AGAINST_RECOMMENDATION');
    expect((await post(await signIn('LFB0002'), id, { action: 'approve', comment: 'Agree with People and Culture.' })).body.data.outcome).toBe('approved');

    const report = (await api((await signIn('LFB0051')).token).get('/reports/register')).body.data;
    const labels = report.columns.map((c) => c.label);
    expect(labels.slice(-2)).toEqual(['Credit recommendation', 'Final decision against recommendation']);
    const ref = (await Application.findById(id)).ref;
    expect(report.rows.find((r) => r[0] === ref).slice(-2)).toEqual(['Reject', 'Yes']);

    const { pages } = require('../pdfRaster');
    const pdf = await api((await signIn('LFB0318')).token).get(`/disbursements/${id}/summary.pdf`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    const text = (await pages(pdf.body)).map((p) => p.items.map((i) => i.str).join(' ')).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('Imependekezwa kukataliwa');
    expect(text).toContain('Imeidhinishwa kinyume na pendekezo');
  });
});

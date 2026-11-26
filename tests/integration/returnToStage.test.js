'use strict';

// D-106: a reviewer returns an application to the applicant or to an earlier stage it has
// passed in this cycle. Approvals from that stage on are cancelled (kept, marked superseded)
// and given again; earlier valid approvals stay; the original approvers may act again.

const { api, seedAll, applyAndSign, decide, signIn, CRB, HR_OK } = require('../flows');
const Application = require('../../src/models/Application');
const Decision = require('../../src/models/Decision');
const Notification = require('../../src/models/Notification');
const AuditLog = require('../../src/models/AuditLog');
const User = require('../../src/models/User');

jest.setTimeout(180000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const userId = async (staffNo) => String((await User.findOne({ staffNo }))._id);

/** Neema's application approved by Credit and People and Culture: waiting for the CEO. */
async function atCeo() {
  const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
  const juma = await signIn('LFB0233');
  const grace = await signIn('LFB0051');
  expect((await decide(juma, id, { action: 'approve', crb: CRB })).status).toBe(200);
  expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
  const joseph = await signIn('LFB0002');
  return { id, juma, grace, joseph };
}

describe('return to an earlier stage (D-106)', () => {
  it('the CEO sees where a return may go: People and Culture (default), Credit Analyst, the applicant', async () => {
    const { id, joseph } = await atCeo();
    const panel = (await api(joseph.token).get(`/review/${id}`)).body.data.panel;
    expect(panel.returnTargets).toEqual([
      { key: 'pc', label: 'People and Culture' },
      { key: 'credit', label: 'Credit Underwriting' },
      { key: 'applicant', label: 'Applicant (for correction)' },
    ]);
  });

  it('back to the Credit Analyst: every approval of the cycle is cancelled and given again', async () => {
    const { id, juma, grace, joseph } = await atCeo();
    const res = await decide(joseph, id, { action: 'return', returnTo: 'credit', comment: 'Attach the second bureau report.' });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('returned_to_stage');
    const a = await Application.findById(id);
    expect(a).toMatchObject({ status: 'pending_credit', currentStage: 'credit' });
    expect(a.stageDueAt.getTime()).toBeGreaterThan(Date.now());

    // Notified: the Credit Analyst, and the applicant that it went back.
    expect(await Notification.exists({ userId: await userId('LFB0233'), type: 'application.stage_returned', text: /returned to your Credit Underwriting review by CEO: Attach the second bureau report\./ })).toBeTruthy();
    expect(await Notification.exists({ userId: await userId('LFB0412'), type: 'application.moved', text: /went back to Credit Underwriting review/ })).toBeTruthy();
    // History: the return names its destination; both earlier approvals are marked superseded.
    const history = (await api(joseph.token).get(`/review/${id}`)).body.data.history;
    expect(history.find((h) => h.action === 'return')).toMatchObject({ stage: 'ceo', returnTo: 'credit', returnToLabel: 'Credit Underwriting', comment: 'Attach the second bureau report.' });
    expect(history.filter((h) => ['approve', 'recommend_approval'].includes(h.action)).map((h) => [h.stage, h.superseded])).toEqual([['credit', true], ['pc', true]]);
    expect(await AuditLog.exists({ action: 'review.return', description: /returned by CEO to Credit Underwriting: Attach the second bureau report\./ })).toBeTruthy();

    // The same people approve again, and it reaches the CEO.
    expect((await decide(juma, id, { action: 'approve', crb: CRB })).body.data.outcome).toBe('moved');
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
    expect((await decide(joseph, id, { action: 'approve' })).body.data.outcome).toBe('approved');
    // The in-force agreement lists only the approvals still in force.
    const approvals = await Decision.find({ applicationId: id, action: { $in: ['approve', 'recommend_approval'] } }).lean();
    expect(approvals).toHaveLength(5);
  });

  it('back to People and Culture: the Credit approval stays; the People and Culture approval is given again', async () => {
    const { id, juma, joseph } = await atCeo();
    expect((await decide(joseph, id, { action: 'return', returnTo: 'pc', comment: 'Confirm the employment category.' })).status).toBe(200);
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_pc', currentStage: 'pc' });
    const history = (await api(joseph.token).get(`/review/${id}`)).body.data.history;
    expect(history.filter((h) => ['approve', 'recommend_approval'].includes(h.action)).map((h) => [h.stage, h.superseded])).toEqual([['credit', false], ['pc', true]]);
    // The Credit Analyst's approval still counts, so they cannot act at People and Culture.
    expect([403, 404]).toContain((await decide(juma, id, { action: 'approve', hrChecks: HR_OK })).status);
    // The P&C Manager or Head of P&C decides again.
    const upendo = await signIn('LFB0129');
    expect((await decide(upendo, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_ceo' });
  });

  it('back to the applicant works as before: returned for correction', async () => {
    const { id, joseph } = await atCeo();
    expect((await decide(joseph, id, { action: 'return', returnTo: 'applicant', comment: 'Lower the amount.' })).body.data.outcome).toBe('returned');
    expect(await Application.findById(id)).toMatchObject({ status: 'returned', currentStage: null });
  });

  it('a return without a destination goes to the applicant, as before', async () => {
    const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
    const juma = await signIn('LFB0233');
    expect((await decide(juma, id, { action: 'return', comment: 'Lower the amount.' })).body.data.outcome).toBe('returned');
    expect(await Application.findById(id)).toMatchObject({ status: 'returned', currentStage: null });
  });

  it('refuses a stage not yet passed, a later stage, and a return without a comment', async () => {
    const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
    const juma = await signIn('LFB0233');
    // At the first stage only the applicant is a destination.
    expect((await api(juma.token).get(`/review/${id}`)).body.data.panel.returnTargets.map((t) => t.key)).toEqual(['applicant']);
    const bad = await decide(juma, id, { action: 'return', returnTo: 'pc', comment: 'Wrong' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('RETURN_TARGET_INVALID');
    await decide(juma, id, { action: 'approve', crb: CRB });
    const grace = await signIn('LFB0051');
    expect((await decide(grace, id, { action: 'return', returnTo: 'ceo', comment: 'Wrong' })).body.code).toBe('RETURN_TARGET_INVALID');
    const noComment = await decide(grace, id, { action: 'return', returnTo: 'credit' });
    expect(noComment.status).toBe(400);
    expect(noComment.body.code).toBe('COMMENT_REQUIRED');
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_pc' });
  });

  it('the applicant cannot act on any stage of their own application', async () => {
    const { id } = await atCeo();
    const neema = await signIn('LFB0412');
    const res = await decide(neema, id, { action: 'return', returnTo: 'credit', comment: 'Mine' });
    expect([403, 404]).toContain(res.status);
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_ceo' });
  });
});

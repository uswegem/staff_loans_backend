'use strict';

// D-103: after the Credit Analyst, every application but the CEO's goes to the People and
// Culture stage, which the P&C Manager or the Head of P&C may decide, whoever acts first.
// The CEO's application stays with the Head of P&C. Applications submitted before D-103
// keep the route they were submitted on.

const { api, seedAll, applyAndSign, decide, signIn, CRB, HR_OK } = require('../flows');
const Application = require('../../src/models/Application');
const Decision = require('../../src/models/Decision');
const Notification = require('../../src/models/Notification');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');
const User = require('../../src/models/User');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(120000);

let products;
const PL = () => products.PL._id;
const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const userId = async (staffNo) => (await User.findOne({ staffNo }))._id;
// Refused: 403, or 404 when they may not even open the application (it is not revealed).
const refused = (res) => expect([403, 404]).toContain(res.status);
const queueIds = async (person) => (await api(person.token).get('/queue')).body.data.items.map((i) => i.id);

beforeEach(async () => {
  ({ products } = await seedAll());
});

/** Applies as staffNo and gets the Credit Analyst's approval; returns { id, grace, upendo }. */
async function atPeopleAndCulture(staffNo) {
  const id = await applyAndSign(await signIn(staffNo), PL(), TERMS);
  expect((await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB })).status).toBe(200);
  return { id, grace: await signIn('LFB0051'), upendo: await signIn('LFB0129') };
}

describe('People and Culture stage (D-103)', () => {
  it('non-management: the P&C Manager may decide; the Head of P&C then cannot', async () => {
    const { id, grace, upendo } = await atPeopleAndCulture('LFB0412');
    const app = await Application.findById(id);
    expect(app).toMatchObject({ route: 'nonmgmt', status: 'pending_pc', currentStage: 'pc' });
    expect(app.stages).toEqual(['credit', 'pc', 'ceo']);
    // Both see it and were told.
    expect(await queueIds(grace)).toContain(String(id));
    expect(await queueIds(upendo)).toContain(String(id));
    for (const who of ['LFB0051', 'LFB0129']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await Notification.exists({ userId: await userId(who), type: 'application.stage', text: /waiting for your People and Culture review/ })).toBeTruthy();
    }
    const view = await api(upendo.token).get(`/review/${id}`);
    expect(view.body.data).toMatchObject({ limited: false, panel: { stage: 'pc', needsHrChecks: true, nextStageLabel: 'CEO' } });

    expect((await decide(upendo, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
    expect((await Application.findById(id)).status).toBe('pending_ceo');
    const late = await decide(grace, id, { action: 'approve', hrChecks: HR_OK });
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('NOT_YOUR_STAGE');
    expect(await queueIds(grace)).not.toContain(String(id));

    // The decision records which role acted, and the history names it.
    const d = await Decision.findOne({ applicationId: id, stage: 'pc' }).lean();
    expect(d.details.permission).toBe('review.pcm');
    const h = (await api(grace.token).get(`/review/${id}`)).body.data.history.find((x) => x.stage === 'pc');
    expect(h).toMatchObject({ stageLabel: 'People and Culture (P&C Manager)', by: 'Upendo Massawe' });
  });

  it('management: the Head of P&C may decide; the P&C Manager then cannot', async () => {
    const { id, grace, upendo } = await atPeopleAndCulture('LFB0067');
    expect(await Application.findById(id)).toMatchObject({ route: 'mgmt', status: 'pending_pc' });
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
    refused(await decide(upendo, id, { action: 'approve', hrChecks: HR_OK }));
    expect(await Decision.countDocuments({ applicationId: id, stage: 'pc' })).toBe(1);
    expect((await Decision.findOne({ applicationId: id, stage: 'pc' }).lean()).details.permission).toBe('review.hr');
  });

  it('only one of two simultaneous decisions goes through', async () => {
    const { id, grace, upendo } = await atPeopleAndCulture('LFB0412');
    const results = await Promise.all([decide(grace, id, { action: 'approve', hrChecks: HR_OK }), decide(upendo, id, { action: 'approve', hrChecks: HR_OK })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, expect.any(Number)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await Decision.countDocuments({ applicationId: id, stage: 'pc' })).toBe(1);
  });

  it("the Head of P&C's own application: only the P&C Manager can act", async () => {
    const { id, grace, upendo } = await atPeopleAndCulture('LFB0051');
    expect(await Application.findById(id)).toMatchObject({ route: 'hrhead', status: 'pending_pc' });
    expect(await queueIds(grace)).not.toContain(String(id));
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.code).toBe('SELF_REVIEW');
    expect((await decide(upendo, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
  });

  it("the P&C Manager's own application: only the Head of P&C can act", async () => {
    const { id, grace, upendo } = await atPeopleAndCulture('LFB0129');
    expect(await Application.findById(id)).toMatchObject({ route: 'nonmgmt', status: 'pending_pc' });
    expect(await queueIds(upendo)).not.toContain(String(id));
    expect((await decide(upendo, id, { action: 'approve', hrChecks: HR_OK })).body.code).toBe('SELF_REVIEW');
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
  });

  it("the CEO's application still goes to the Head of P&C only, for final approval", async () => {
    const { id, grace, upendo } = await atPeopleAndCulture('LFB0002');
    const app = await Application.findById(id);
    expect(app).toMatchObject({ route: 'ceo', status: 'pending_hr', currentStage: 'hr' });
    expect(app.stages).toEqual(['credit', 'hr']);
    expect(await queueIds(upendo)).not.toContain(String(id));
    refused(await decide(upendo, id, { action: 'approve', hrChecks: HR_OK }));
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('approved');
  });

  it('someone who approved at Credit cannot approve the People and Culture stage', async () => {
    // The Credit Analyst also holds the P&C Manager role.
    const pcm = await Role.findOne({ code: 'pc_manager' });
    await RoleAssignment.create({ userId: await userId('LFB0233'), roleId: pcm._id });
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), TERMS);
    const juma = await signIn('LFB0233');
    expect((await decide(juma, id, { action: 'approve', crb: CRB })).status).toBe(200);
    expect(await queueIds(juma)).not.toContain(String(id));
    const again = await decide(juma, id, { action: 'approve', hrChecks: HR_OK });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('SEPARATE_STAGES');
    expect((await decide(await signIn('LFB0129'), id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
  });

  it.each([
    ['LFB0129', 'the P&C Manager', 'LFB0051'],
    ['LFB0051', 'the Head of P&C', 'LFB0129'],
  ])('%s (%s) can delegate the stage; the delegate acts on their behalf', async (holder, label, other) => {
    const { id } = await atPeopleAndCulture('LFB0412');
    const salma = await User.findOne({ staffNo: 'LFB0377' });
    const d = await api((await signIn(holder)).token).post('/delegations', { delegateUserId: String(salma._id), from: localDay(), until: localDay(), reason: 'On leave' });
    expect(d.status).toBe(201);
    const delegate = await signIn('LFB0377');
    const item = (await api(delegate.token).get('/queue')).body.data.items.find((i) => i.id === String(id));
    expect(item).toBeTruthy();
    expect((await decide(delegate, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
    const dec = await Decision.findOne({ applicationId: id, stage: 'pc' }).lean();
    expect(String(dec.actorId)).toBe(String(salma._id));
    expect(String(dec.onBehalfOfId)).toBe(String(await userId(holder)));
    // The other role holder can no longer act.
    refused(await decide(await signIn(other), id, { action: 'approve', hrChecks: HR_OK }));
    expect(await Decision.countDocuments({ applicationId: id, stage: 'pc' })).toBe(1);
  });

  it('an application submitted before D-103 keeps its route: waiting for the Head of P&C only', async () => {
    const { id, grace, upendo } = await atPeopleAndCulture('LFB0412');
    // As it was stored before the change: the old non-management route, at the Head of HR stage.
    await Application.updateOne({ _id: id }, { $set: { stages: ['credit', 'hr', 'ceo'], status: 'pending_hr', currentStage: 'hr' } });
    expect(await queueIds(upendo)).not.toContain(String(id));
    expect(await queueIds(grace)).toContain(String(id));
    refused(await decide(upendo, id, { action: 'approve', hrChecks: HR_OK }));
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('moved');
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_ceo', currentStage: 'ceo' });
    expect((await Decision.findOne({ applicationId: id, stage: 'hr' }).lean()).details.permission).toBe('review.hr');
  });
});

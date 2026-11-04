'use strict';

// Review (BRD 7; FR-13 to FR-19, FR-36, FR-38, FR-39, FR-42, FR-47, FR-54 to FR-56;
// prompt 4.1, 4.2, 4.3). The limited-details tests call the API as the Credit Analyst
// and assert the hidden fields are absent.

const { api, seedAll, applyAndSign, sign, decide, signIn, runningLoan, CRB, HR_OK } = require('../flows');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');
const Decision = require('../../src/models/Decision');
const Notification = require('../../src/models/Notification');
const Staff = require('../../src/models/Staff');
const User = require('../../src/models/User');
const StoredFile = require('../../src/models/StoredFile');
const AuditLog = require('../../src/models/AuditLog');
const { localDay } = require('../../src/utils/dates');

// Whole-route flows sign in four people; allow for a loaded machine.
jest.setTimeout(120000);

let products;
const PL = () => products.PL._id;
const userId = async (staffNo) => (await User.findOne({ staffNo }))._id;
const notesFor = async (staffNo, type) => Notification.find({ userId: await userId(staffNo), ...(type ? { type } : {}) }).lean();

const NEEMA = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const DANIEL = { amount: 5000000, tenor: 24, purpose: 'Roof repairs at Mbweni' };

beforeEach(async () => {
  ({ products } = await seedAll());
});

/** Every key and string value anywhere in a JSON body. */
function walk(value, keys = new Set(), strings = []) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, keys, strings));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      keys.add(k);
      walk(v, keys, strings);
    });
  } else if (value !== null && value !== undefined) strings.push(String(value));
  return { keys, strings };
}

const HIDDEN_KEYS = ['amount', 'tenor', 'purpose', 'product', 'productFields', 'salary', 'salaryAtSubmission', 'calcAtSubmission', 'quote', 'payInputs', 'checks', 'documents', 'agreements', 'history', 'recommended', 'approved', 'repayment', 'topUp', 'otherLoans', 'existingLfbLoans', 'nextOfKin', 'title', 'category', 'department', 'route', 'fullName', 'payslip', 'combined', 'existingLoans'];

function assertLimited(body, { amount, purpose, productName }) {
  const { keys, strings } = walk(body);
  HIDDEN_KEYS.forEach((k) => expect([k, keys.has(k)]).toEqual([k, false]));
  const all = strings.join(' | ');
  expect(all).not.toContain(String(amount));
  expect(all).not.toContain(amount.toLocaleString('en-US'));
  expect(all).not.toContain(purpose);
  expect(all).not.toContain(productName);
}

describe('non-management route: Credit Analyst, Head of HR, CEO (BRD 7.1)', () => {
  it('runs end to end and puts the signed agreement in force at CEO approval', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);

    const juma = await signIn('LFB0233');
    const q = await api(juma.token).get('/queue');
    expect(q.body.data.items).toHaveLength(1);
    // D-86: the Credit Analyst sees identity only, on every route.
    expect(q.body.data.items[0]).toMatchObject({ ref: expect.stringMatching(/^SL-/), limited: true, applicant: { firstName: 'Neema', lastName: 'Mushi' }, stageLabel: 'Credit Analyst' });
    assertLimited(q.body, { ...NEEMA, productName: 'Personal Loan' });
    expect(q.body.data.items[0].due.targetHours).toBe(8);

    const view = await api(juma.token).get(`/review/${id}`);
    expect(view.body.data).toMatchObject({ limited: true, panel: { stage: 'credit', needsCrb: true, canRecommend: false, isFinal: false } });
    assertLimited(view.body, { ...NEEMA, productName: 'Personal Loan' });

    // FR-42: the bureau outcome is required to approve; comments to return or reject (FR-15).
    expect((await decide(juma, id, { action: 'approve' })).body.message).toBe('Record the credit bureau outcome before approving.');
    expect((await decide(juma, id, { action: 'return' })).body.message).toBe('Add a comment so the applicant knows what to do.');
    expect((await decide(juma, id, { action: 'reject', comment: '  ' })).body.code).toBe('COMMENT_REQUIRED');
    const c = await decide(juma, id, { action: 'approve', crb: CRB, comment: 'Affordable, bureau clear.' });
    expect(c.body.data.outcome).toBe('moved');
    expect((await Application.findById(id)).status).toBe('pending_hr');
    expect((await notesFor('LFB0051', 'application.stage'))[0].text).toMatch(/waiting for your Head of HR review/);

    // FR-17: the Head of HR confirms the staff record, with the full application.
    const grace = await signIn('LFB0051');
    const hrView = await api(grace.token).get(`/review/${id}`);
    expect(hrView.body.data).toMatchObject({ limited: false, amount: 4500000 });
    expect(hrView.body.data.calcAtSubmission).toMatchObject({ instalment: 136900, maxInstalment: 668750 });
    expect((await decide(grace, id, { action: 'approve' })).body.message).toBe('Confirm all three staff record checks before approving.');
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK, comment: 'Employment and salary confirmed.' })).body.data.outcome).toBe('moved');
    expect((await Application.findById(id)).status).toBe('pending_ceo');

    const joseph = await signIn('LFB0002');
    const ceoView = await api(joseph.token).get(`/review/${id}`);
    expect(ceoView.body.data.panel.isFinal).toBe(true);
    expect(ceoView.body.data.history.map((h) => h.by)).toEqual(['Neema Mushi', 'Neema Mushi', 'Juma Kassim', 'Grace Mollel']);
    const final = await decide(joseph, id, { action: 'approve', comment: 'Approved.' });
    expect(final.body.data.outcome).toBe('approved');

    const a = await Application.findById(id);
    expect(a).toMatchObject({ status: 'pending_disbursement', scheduleBasis: 'final_approval', approved: { amount: 4500000, tenor: 36, instalment: 136900 } });
    expect(a.schedule).toHaveLength(36);
    const ag = await Agreement.findById(a.currentAgreementId);
    expect(ag.status).toBe('in_force');
    expect(ag.effectiveAt).toBeInstanceOf(Date);
    expect(ag.approvals.map((x) => x.name)).toEqual(['Juma Kassim', 'Grace Mollel', 'Joseph Mwakalinga']); // FR-36
    expect((await StoredFile.findById(ag.inForcePdfFileId)).mime).toBe('application/pdf');
    expect((await Staff.findOne({ staffNo: 'LFB0412' })).loanHistory).toHaveLength(1); // NS-02
    expect(await notesFor('LFB0318', 'application.ready_to_disburse')).toHaveLength(1); // OPS
    expect((await notesFor('LFB0412', 'application.approved'))[0].text).toMatch(/now in force/);
    expect(await Decision.countDocuments({ applicationId: id, action: 'approve' })).toBe(3);
  });

  it('only the current stage acts; others and staff cannot', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    const grace = await signIn('LFB0051');
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.code).toBe('NOT_YOUR_STAGE');
    const aisha = await signIn('LFB0451');
    expect((await api(aisha.token).get(`/review/${id}`)).status).toBe(404);
    expect((await api(aisha.token).get('/queue')).body.data.items).toEqual([]);
  });

  it('a rejection closes the application and voids the agreement', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    const juma = await signIn('LFB0233');
    await decide(juma, id, { action: 'reject', comment: 'Adverse bureau record.' });
    const a = await Application.findById(id);
    expect(a.status).toBe('rejected');
    expect(a.closedAtStage).toBe('credit');
    expect(await Agreement.findById(a.currentAgreementId)).toMatchObject({ status: 'void', voidReason: 'Application rejected' });
    expect((await notesFor('LFB0412', 'application.rejected'))[0].text).toMatch(/Adverse bureau record/);
  });

  it('a return goes back to the applicant; resubmission restarts at the first stage with a new agreement', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    const juma = await signIn('LFB0233');
    await decide(juma, id, { action: 'approve', crb: CRB });
    const grace = await signIn('LFB0051');
    await decide(grace, id, { action: 'return', comment: 'Add the CRDB deduction to your profile.', suggested: { amount: 4000000, tenor: 36 } });
    let a = await Application.findById(id);
    expect(a.status).toBe('returned');
    expect((await notesFor('LFB0412', 'application.returned'))[0].text).toMatch(/Add the CRDB deduction to your profile\. Suggested terms: TZS 4,000,000 over 36 months\./);
    const first = a.currentAgreementId;
    await sign(neema, id);
    a = await Application.findById(id);
    expect(a).toMatchObject({ status: 'pending_credit', currentStage: 'credit', cycle: 2 });
    expect((await Agreement.findById(first)).status).toBe('void');
    const view = await api(grace.token).get(`/review/${id}`);
    expect(view.body.data.history.map((h) => h.action)).toEqual(['create', 'submit', 'approve', 'return', 'resubmit']);
  });

  it('Credit records one of the four outcomes, with no appraisal or arrears note (D-99)', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    const juma = await signIn('LFB0233');
    const panel = (await api(juma.token).get(`/review/${id}`)).body.data.panel;
    expect(panel.crbOutcomes).toEqual(['Low Risk', 'Average Risk', 'High Risk', 'No Record Found']);
    // An outcome from before D-99 is no longer accepted.
    const old = await decide(juma, id, { action: 'approve', crb: { ...CRB, outcome: 'Clear' } });
    expect(old.status).toBe(400);
    expect(Object.keys(old.body.details)).toEqual(['crb.outcome']);
    // Notes sent by an older screen are dropped, not stored.
    expect((await decide(juma, id, { action: 'approve', crb: { ...CRB, outcome: 'High Risk' }, appraisalNote: 'x', arrearsNote: 'y' })).status).toBe(200);
    const app = await Application.findById(id).lean();
    expect(app.crb.outcome).toBe('High Risk');
    expect(app.appraisalNote).toBeUndefined();
    expect(app.arrearsNote).toBeUndefined();
    // Nothing for later approvers to comment on: HR approves without a comment.
    expect((await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
  });

  it('an application with an arrears note from before D-99 still needs a comment from later approvers (BR-10)', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    // Stored before the field was removed: kept, shown and still acted on.
    await Application.updateOne({ _id: id }, { $set: { arrearsNote: 'One month in arrears on the 2024 loan, now cleared.', appraisalNote: 'Stable history.', 'crb.outcome': 'Adverse: minor' } });
    const grace = await signIn('LFB0051');
    const view = (await api(grace.token).get(`/review/${id}`)).body.data;
    expect(view).toMatchObject({ arrearsNote: 'One month in arrears on the 2024 loan, now cleared.', appraisalNote: 'Stable history.', crb: { outcome: 'Adverse: minor' } });
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.code).toBe('COMMENT_REQUIRED');
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK, comment: 'Arrears cleared; confirmed.' })).status).toBe(200);
  });
});

describe('combined cap re-checked at every approval (D-87)', () => {
  it('refuses approval when another loan approved meanwhile leaves too little', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
    // Meanwhile a Vehicle Loan of 600,000 a month is approved: 668,750 − 600,000 = 68,750 left.
    await runningLoan('LFB0412', products.VL._id, 600000, 'pending_disbursement');
    const res = await decide(await signIn('LFB0002'), id, { action: 'approve', comment: 'Approved.' });
    expect(res.body.code).toBe('AFFORDABILITY_EXCEEDED');
    expect(res.body.message).toBe("This application cannot be approved now. The instalment of TZS 136,900 no longer fits the combined limit: 50% of Net Pay is TZS 668,750, and the applicant's other loans in Staff Loans now take TZS 600,000, leaving TZS 68,750. Return or reject it.");
    expect((await Application.findById(id)).status).toBe('pending_ceo');
  });

  it('the Credit Analyst is told only that the limit is exceeded, without figures', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    await runningLoan('LFB0412', products.VL._id, 600000);
    const res = await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    expect(res.body.code).toBe('AFFORDABILITY_EXCEEDED');
    expect(res.body.message).not.toMatch(/TZS/);
  });
});

describe('identity-only details for the Credit Analyst (FR-55, D-86)', () => {
  let id;
  let juma;
  beforeEach(async () => {
    const daniel = await signIn('LFB0067'); // Head of Risk: management
    id = await applyAndSign(daniel, PL(), DANIEL);
    juma = await signIn('LFB0233');
  });

  it('the queue shows only the first name and surname', async () => {
    const q = await api(juma.token).get('/queue');
    const row = q.body.data.items[0];
    expect(row).toMatchObject({ limited: true, applicant: { firstName: 'Daniel', lastName: 'Mrema' } });
    expect(row.route).toBeUndefined();
    assertLimited(q.body, { ...DANIEL, productName: 'Personal Loan' });
  });

  it('the review screen returns only first name, surname, NIDA number and mobile', async () => {
    const res = await api(juma.token).get(`/review/${id}`);
    expect(res.body.data).toMatchObject({ limited: true, applicant: { firstName: 'Daniel', lastName: 'Mrema', mobile: '+255754067390', nida: expect.stringMatching(/^\d{8}-\d{5}-\d{5}-\d{2}$/) }, panel: { canRecommend: false, needsCrb: true } });
    expect(Object.keys(res.body.data.applicant).sort()).toEqual(['firstName', 'lastName', 'mobile', 'nida']);
    assertLimited(res.body, { ...DANIEL, productName: 'Personal Loan' });
    expect((await AuditLog.findOne({ action: 'review.view' })).limited).toBe(true);
  });

  it('the documents and the agreement are not available', async () => {
    const a = await Application.findById(id);
    const ag = await Agreement.findById(a.currentAgreementId);
    expect((await api(juma.token).get(`/agreements/${ag._id}`)).status).toBe(404);
    expect((await api(juma.token).get(`/agreements/${ag._id}/pdf`)).status).toBe(404);
    expect((await api(juma.token).get(`/files/${ag.pdfFileId}`)).status).toBe(404);
  });

  it('the notification carries no terms', async () => {
    const [n] = await notesFor('LFB0233', 'application.stage');
    expect(n.text).toMatch(/from Daniel Mrema is waiting for your Credit Analyst review \(limited details\)$/);
    expect(n.text).not.toMatch(/5,000,000|Personal Loan/);
  });

  it('records the bureau result only; terms cannot be changed', async () => {
    const r = await decide(juma, id, { action: 'approve', crb: CRB, recommended: { amount: 4000000, tenor: 24 } });
    expect(r.body.code).toBe('RECOMMENDATION_NOT_ALLOWED');
    const ok = await decide(juma, id, { action: 'approve', crb: CRB, comment: 'Bureau clear on name, mobile and NIDA.' });
    expect(ok.body.data.outcome).toBe('moved');
    assertLimited(ok.body, { ...DANIEL, productName: 'Personal Loan' });
  });

  it('stays limited afterwards, and other reviewers comments are hidden', async () => {
    await decide(juma, id, { action: 'approve', crb: CRB, comment: 'Bureau clear.' });
    const grace = await signIn('LFB0051');
    const full = await api(grace.token).get(`/review/${id}`);
    expect(full.body.data).toMatchObject({ limited: false, amount: 5000000, crb: { outcome: 'Low Risk' } });
    expect(full.body.data.history.find((h) => h.stage === 'credit').comment).toBe('Bureau clear.');
    await decide(grace, id, { action: 'return', comment: 'Confirm the Mbweni plot title.' });
    const again = await api(juma.token).get(`/review/${id}`);
    expect(again.body.data.myDecisions.map((d) => d.comment)).toEqual(['Bureau clear.']);
    expect(JSON.stringify(again.body)).not.toContain('Mbweni');
    const handled = await api(juma.token).get('/queue?tab=handled');
    assertLimited(handled.body, { ...DANIEL, productName: 'Personal Loan' });
  });
});

describe('CEO and Head of People and Culture routes (BRD 7.2.1, decision 31, FR-56)', () => {
  it('CEO: Credit (limited), then Head of P&C gives final approval; the CEO never sees it in a queue', async () => {
    const joseph = await signIn('LFB0002');
    const id = await applyAndSign(joseph, PL(), { amount: 20000000, tenor: 36, purpose: 'Family farm investment' });
    expect((await api(joseph.token).get('/queue')).body.data.items).toEqual([]);
    expect((await api(joseph.token).get(`/review/${id}`)).body.code).toBe('SELF_REVIEW');
    const juma = await signIn('LFB0233');
    expect((await api(juma.token).get(`/review/${id}`)).body.data.limited).toBe(true);
    await decide(juma, id, { action: 'approve', crb: CRB });
    const grace = await signIn('LFB0051');
    const v = await api(grace.token).get(`/review/${id}`);
    expect(v.body.data.panel).toMatchObject({ stage: 'hr', isFinal: true });
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.data.outcome).toBe('approved');
    expect((await Application.findById(id)).status).toBe('pending_disbursement');
  });

  it('Head of P&C: Credit (limited), P&C Manager, then CEO', async () => {
    const grace = await signIn('LFB0051');
    const id = await applyAndSign(grace, PL(), { amount: 10000000, tenor: 36, purpose: 'Vehicle repairs' });
    expect((await api(grace.token).get('/queue')).body.data.items).toEqual([]);
    const juma = await signIn('LFB0233');
    expect((await api(juma.token).get(`/review/${id}`)).body.data.limited).toBe(true);
    await decide(juma, id, { action: 'approve', crb: CRB });
    const upendo = await signIn('LFB0129');
    const v = await api(upendo.token).get(`/review/${id}`);
    expect(v.body.data).toMatchObject({ limited: false, panel: { stage: 'pcm', needsHrChecks: true, nextStageLabel: 'CEO' } });
    expect((await decide(upendo, id, { action: 'approve' })).body.code).toBe('HR_CHECKS_REQUIRED');
    await decide(upendo, id, { action: 'approve', hrChecks: HR_OK });
    const joseph = await signIn('LFB0002');
    expect((await decide(joseph, id, { action: 'approve' })).body.data.outcome).toBe('approved');
  });
});

describe('probation verification (NS-01)', () => {
  it('People and Culture must verify the probation reason', async () => {
    const joined = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    await Staff.updateOne(
      { staffNo: 'LFB0596' },
      { $set: { dateJoined: joined, 'personal.maritalStatus': 'Single', 'personal.dob': new Date('1998-05-20'), dateOfBirth: { value: '1998-05-20', verifiedAt: new Date() }, 'personal.nida': '19980520-41108-00031-26', 'personal.address': { region: 'Dodoma', district: 'Dodoma', ward: 'Ipagala', street: 'Area D' }, 'bank.accountNo': '4010 3341 0596', nextOfKin: [{ firstName: 'Mwanaidi', lastName: 'Ally', relationship: 'Parent', phone: '+255715660214', address: 'Dodoma' }], payDeclaredAt: new Date() } }
    );
    const rehema = await signIn('LFB0596');
    const id = await applyAndSign(rehema, PL(), { amount: 1000000, tenor: 12, purpose: 'Rent deposit', probationReason: 'Relocated for this job.' });
    const juma = await signIn('LFB0233');
    await decide(juma, id, { action: 'approve', crb: CRB });
    const grace = await signIn('LFB0051');
    const v = await api(grace.token).get(`/review/${id}`);
    expect(v.body.data).toMatchObject({ probation: { onProbation: true, reason: 'Relocated for this job.' }, panel: { needsProbationCheck: true } });
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).body.message).toBe('Verify the probation reason before approving.');
    await decide(grace, id, { action: 'approve', hrChecks: { ...HR_OK, probationReasonVerified: true } });
    const a = await Application.findById(id);
    expect(a.probation.verifiedAt).toBeInstanceOf(Date);
  });
});

describe('delegation (FR-19)', () => {
  const today = () => localDay();

  it('a delegate acts on behalf of the CEO; both names are recorded', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
    await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });

    const joseph = await signIn('LFB0002');
    const upendo = await User.findOne({ staffNo: 'LFB0129' });
    const d = await api(joseph.token).post('/delegations', { delegateUserId: String(upendo._id), from: today(), until: today(), reason: 'Board meeting abroad' });
    expect(d.status).toBe(201);
    expect(d.body.data.status).toBe('active');
    expect((await notesFor('LFB0129', 'delegation.set'))).toHaveLength(1);
    expect((await api(joseph.token).get('/queue')).body.data.items).toEqual([]);

    const upendoSession = await signIn('LFB0129'); // a delegate signs in with MFA
    expect(upendoSession.body.data.permissions).not.toContain('review.ceo');
    const q = await api(upendoSession.token).get('/queue');
    expect(q.body.data.items[0]).toMatchObject({ onBehalfOf: 'Joseph Mwakalinga', limited: false });
    expect(q.body.data.covering[0].name).toBe('Joseph Mwakalinga');
    await decide(upendoSession, id, { action: 'approve', comment: 'Approved on behalf of the CEO.' });
    const dec = await Decision.findOne({ applicationId: id, stage: 'ceo' });
    expect(String(dec.actorId)).toBe(String(upendo._id));
    expect(String(dec.onBehalfOfId)).toBe(String(await userId('LFB0002')));
    const grace = await signIn('LFB0051');
    const h = (await api(grace.token).get(`/review/${id}`)).body.data.history.find((x) => x.stage === 'ceo');
    expect(h).toMatchObject({ by: 'Upendo Massawe', onBehalfOf: 'Joseph Mwakalinga' });
  });

  it('refuses a delegate that would break segregation of duties, and oneself', async () => {
    const grace = await signIn('LFB0051');
    const halima = await User.findOne({ staffNo: 'LFB0318' }); // OPS: disbursement
    const r = await api(grace.token).post('/delegations', { delegateUserId: String(halima._id), from: today(), until: today() });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/approving is kept apart from confirming disbursement/);
    const self = await api(grace.token).post('/delegations', { delegateUserId: String(await userId('LFB0051')), from: today(), until: today() });
    expect(self.status).toBe(400);
  });

  it('staff without review permissions cannot delegate', async () => {
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).post('/delegations', { delegateUserId: String(await userId('LFB0451')), from: today(), until: today() })).status).toBe(403);
  });

  it('a delegate whose session was opened without MFA must sign in again to decide', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, PL(), NEEMA);
    const salmaBefore = await signIn('LFB0377'); // no MFA needed yet
    const juma = await signIn('LFB0233');
    await api(juma.token).post('/delegations', { delegateUserId: String(await userId('LFB0377')), from: today(), until: today() });
    const r = await decide(salmaBefore, id, { action: 'approve', crb: CRB });
    expect(r.body.code).toBe('MFA_STEP_UP');
    const salma = await signIn('LFB0377');
    expect(salma.body.data.accessToken).toBeTruthy();
    expect((await decide(salma, id, { action: 'approve', crb: CRB })).status).toBe(200);
  });
});

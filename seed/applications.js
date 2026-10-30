'use strict';

// The prototype's sample applications (all fictional), so queues, the four routes,
// returns, revised terms and the OPS queue can be shown straight after seeding.
// Only seeded into a system with no applications. The disbursed sample
// (SL-2026-00015) arrives with milestone 6.

const Application = require('../src/models/Application');
const Agreement = require('../src/models/Agreement');
const Decision = require('../src/models/Decision');
const Counter = require('../src/models/Counter');
const Staff = require('../src/models/Staff');
const Salary = require('../src/models/Salary');
const Settings = require('../src/models/Settings');
const Notification = require('../src/models/Notification');
const products = require('../src/services/products/productService');
const calc = require('../src/services/calc/loanCalculator');
const rules = require('../src/services/applications/rules');
const agreementService = require('../src/services/agreement/agreementService');
const { agreementPdf, textBlocks } = require('../src/services/agreement/pdfService');
const fileStore = require('../src/services/files/fileStore');
const calendar = require('../src/services/calendar/calendarService');
const wt = require('../src/services/calendar/workingTime');
const { STAGES, routeFor } = require('../src/services/workflow/routes');
const { localDay } = require('../src/utils/dates');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const fullName = (s) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

// a: applicant, p: product code, at: submitted (working hours or days ago), steps: decisions after submit
const SAMPLES = [
  { ref: 'SL-2026-00031', a: 'LFB0451', p: 'PL', amount: 4500000, tenor: 24, purpose: 'Family medical expenses', submittedWh: 2.25, status: 'pending_credit' },
  { ref: 'SL-2026-00030', a: 'LFB0377', p: 'SA', amount: 600000, tenor: 3, purpose: 'School fees top-up for my daughter', submittedWh: 9.5, status: 'pending_credit' },
  {
    ref: 'SL-2026-00029', a: 'LFB0188', p: 'VL', amount: 18000000, tenor: 48, purpose: 'Family vehicle', fields: { make: 'Toyota RAV4', year: 2019, seller: 'Arusha Motors Ltd', price: 24500000 }, submittedWh: 14, status: 'pending_hr',
    crb: 'Clear', appraisal: 'Stable repayment history on previous salary advance. Deposit of TZS 6.5m confirmed.',
    steps: [{ by: 'LFB0233', stage: 'credit', wh: 3, comment: 'Affordable at 48 months. CRB clear.' }],
  },
  { ref: 'SL-2026-00028', a: 'LFB0067', p: 'HE', amount: 35000000, tenor: 96, purpose: 'Construction of family home', fields: { kind: 'Construction', place: 'Mbweni, Kinondoni' }, submittedWh: 1.2, status: 'pending_credit' },
  {
    ref: 'SL-2026-00025', a: 'LFB0002', p: 'PL', amount: 20000000, tenor: 36, purpose: 'Family farm investment', submittedDays: 2, status: 'pending_hr', crb: 'Clear', appraisal: 'Bureau check on name, mobile and NIDA only: clear.',
    steps: [{ by: 'LFB0233', stage: 'credit', wh: 4, comment: 'Credit bureau clear.' }],
  },
  {
    ref: 'SL-2026-00024', a: 'LFB0051', p: 'VL', amount: 30000000, tenor: 60, purpose: 'Replacement family vehicle', fields: { make: 'Toyota Prado', year: 2020, seller: 'CFAO Motors', price: 42000000 }, submittedDays: 3, status: 'pending_pcm', crb: 'Clear',
    steps: [{ by: 'LFB0233', stage: 'credit', wh: 5, comment: 'Credit bureau clear.' }],
  },
  {
    ref: 'SL-2026-00026', a: 'LFB0377', p: 'HE', amount: 6000000, tenor: 24, purpose: 'Diploma tuition', fields: { kind: 'Tuition: self', place: 'Institute of Finance Management' }, submittedDays: 4, status: 'pending_ceo', crb: 'Clear',
    steps: [
      { by: 'LFB0233', stage: 'credit', wh: 30, comment: 'Within limits.' },
      { by: 'LFB0051', stage: 'hr', wh: 20, comment: 'Employment and salary confirmed.' },
    ],
  },
  {
    ref: 'SL-2026-00027', a: 'LFB0412', p: 'HE', amount: 3200000, tenor: 12, purpose: 'Tuition for 2027 intake', fields: { kind: 'Tuition: dependant', place: 'St. Augustine University' }, submittedDays: 3, status: 'returned',
    steps: [{ by: 'LFB0233', stage: 'credit', wh: 5, action: 'return', comment: 'Your payslip shows a CRDB deduction of TZS 150,000 that is not in your profile. Add it under other loans, and attach the admission letter if you have it.' }],
  },
  {
    ref: 'SL-2026-00022', a: 'LFB0412', p: 'PL', amount: 5000000, tenor: 36, purpose: 'Home furniture and appliances', submittedDays: 9, status: 'pending_reaccept', crb: 'Clear',
    appraisal: 'Affordable, but recommended at TZS 4.5m to keep headroom for the running CRDB loan.', recommended: { amount: 4500000, tenor: 36, reason: 'To keep headroom for the running CRDB loan.' },
    steps: [
      { by: 'LFB0233', stage: 'credit', days: 8, comment: 'Within limits at a recommended TZS 4,500,000 over 36 months, to keep headroom for the CRDB loan. CRB clear.' },
      { by: 'LFB0051', stage: 'hr', days: 6, comment: 'Employment confirmed.' },
      { by: 'LFB0002', stage: 'ceo', wh: 2, comment: 'Approved at the recommended TZS 4,500,000.' },
    ],
  },
  {
    ref: 'SL-2026-00019', a: 'LFB0188', p: 'SA', amount: 800000, tenor: 3, purpose: 'Medical bill', submittedDays: 12, status: 'pending_disbursement', repayment: 'account', crb: 'Clear',
    steps: [
      { by: 'LFB0233', stage: 'credit', days: 11 },
      { by: 'LFB0051', stage: 'hr', days: 10 },
      { by: 'LFB0002', stage: 'ceo', days: 8 },
    ],
  },
  {
    ref: 'SL-2026-00012', a: 'LFB0451', p: 'VL', amount: 25000000, tenor: 60, purpose: 'Vehicle purchase', fields: { make: 'Nissan X-Trail', year: 2015, seller: 'Private seller', price: 27000000 }, submittedDays: 30, status: 'rejected', crb: 'Clear',
    steps: [
      { by: 'LFB0233', stage: 'credit', days: 29 },
      { by: 'LFB0051', stage: 'hr', days: 28 },
      { by: 'LFB0002', stage: 'ceo', days: 26, action: 'reject', comment: 'Vehicle is over 10 years old at the end of the loan. Reapply for a newer vehicle.' },
    ],
  },
];

async function seedSampleApplications({ users, products: byCode }) {
  if (await Application.exists({})) return 0;
  const now = new Date();
  const year = now.getFullYear();
  const cal = await calendar.load();
  const settings = await Settings.get();
  const pricing = await products.livePricing();
  await Counter.updateOne({ _id: `MKT-${year}` }, { $max: { seq: 14 } }, { upsert: true });
  await Counter.updateOne({ _id: `SL-${year}` }, { $max: { seq: 31 } }, { upsert: true });
  const ago = (s) => (s.wh != null ? wt.subtractWorkingHours(cal, now, s.wh) : new Date(now.getTime() - (s.days ?? s.submittedDays) * DAY));
  const id = (staffNo) => users[staffNo]._id;
  const ip = (staffNo) => `10.20.4.${30 + (Number(staffNo.slice(-3)) % 200)}`;

  for (const s of SAMPLES) {
    /* eslint-disable no-await-in-loop */
    const staff = await Staff.findOne({ staffNo: s.a });
    const salary = await Salary.inForce(staff._id);
    const { product, version } = await products.liveProductVersion(byCode[s.p]._id);
    const submittedAt = s.submittedWh != null ? wt.subtractWorkingHours(cal, now, s.submittedWh) : new Date(now.getTime() - s.submittedDays * DAY);
    const pay = rules.payInputs({ staff, salary, apps: [], today: localDay(submittedAt) });
    const q = calc.quote({ amount: s.amount, tenor: s.tenor, pay, pricing, startDay: localDay(submittedAt), dueDay: settings.firstDueDay });
    const repayment = s.repayment === 'account' ? { method: 'account', bank: staff.bank.bank, branch: staff.bank.branch, accountName: staff.bank.accountName, accountNo: staff.bank.accountNo } : { method: 'payroll' };
    const permissions = s.a === 'LFB0002' ? ['review.ceo'] : s.a === 'LFB0051' ? ['review.hr'] : [];
    const route = routeFor(permissions, staff);

    const app = new Application({
      ref: s.ref,
      applicantUserId: id(s.a),
      applicantStaffId: staff._id,
      productId: product._id,
      productVersionId: version._id,
      pricingVersionId: pricing._id,
      route: route.key,
      stages: route.stages,
      cycle: 1,
      submittedAt,
      lastSubmittedAt: submittedAt,
      amount: s.amount,
      tenor: s.tenor,
      purpose: s.purpose,
      productFields: s.fields || {},
      repayment,
      consents: { truth: true, deduct: true, crb: true, sms: true, at: submittedAt },
      calcSnapshot: q,
      applicantSnapshot: { staffNo: staff.staffNo, fullName: fullName(staff), category: staff.category, employmentType: staff.employmentType, salary: { basic: salary.basic, allowances: salary.allowances, effectiveFrom: salary.effectiveFrom }, pay },
      probation: { onProbation: false },
      ...(s.crb ? { crb: { outcome: s.crb, reportDate: new Date(submittedAt.getTime() + DAY) } } : {}),
      ...(s.appraisal ? { appraisalNote: s.appraisal } : {}),
    });

    const doc = await agreementService.build({ ref: s.ref, kind: 'original', staff, product: version, quote: q, amount: s.amount, tenor: s.tenor, repayment, topUp: { on: false } });
    const number = `MKT-${year}-${String(await Counter.next(`MKT-${year}`)).padStart(5, '0')}`;
    const evidence = [['Namba ya mkataba / Agreement number', number], ['Maombi / Application', s.ref], ['Mwajiriwa / Staff member', `${fullName(staff)} (${staff.staffNo})`], ['Tarehe na saa / Accepted at', submittedAt.toISOString()], ['Alama ya maandishi (SHA-256) / Text fingerprint', doc.textSha256]];
    const pdf = await fileStore.store(await agreementPdf({ blocks: doc.blocks, title: `Mkataba ${number} (${s.ref})`, evidence }), { kind: 'agreement_pdf', originalName: `${number}.pdf`, applicationId: app._id, ownerUserId: id(s.a), uploadedBy: id(s.a) });
    const agreement = await Agreement.create({
      number,
      applicationId: app._id,
      kind: 'original',
      templateId: doc.template.id,
      templateVersion: doc.template.version,
      terms: { amount: s.amount, tenor: s.tenor, instalment: q.instalment, interestBps: q.rates.interestBps, processingFee: q.processingFee, insuranceFee: q.insuranceFee, totalInterest: q.totalInterest, totalRepayable: q.totalRepayable, firstDueDate: q.firstDueDate, repaymentMethod: repayment.method },
      schedule: q.schedule,
      text: doc.text,
      textSha256: doc.textSha256,
      pdfFileId: pdf._id,
      pdfSha256: pdf.sha256,
      acceptance: { userId: id(s.a), staffNo: staff.staffNo, fullName: fullName(staff), at: submittedAt, ip: ip(s.a) },
    });
    app.currentAgreementId = agreement._id;

    await Decision.create({ applicationId: app._id, cycle: 0, action: 'create', actorId: id(s.a), at: new Date(submittedAt.getTime() - HOUR) });
    await Decision.create({ applicationId: app._id, cycle: 1, action: 'submit', actorId: id(s.a), comment: `${s.amount.toLocaleString('en-US')} over ${s.tenor} months, agreement ${number}`, at: submittedAt, ip: ip(s.a) });
    let enteredAt = submittedAt;
    const approvals = [];
    for (const step of s.steps || []) {
      const at = ago(step);
      const action = step.action || 'approve';
      await Decision.create({ applicationId: app._id, cycle: 1, stage: step.stage, action, actorId: id(step.by), comment: step.comment, at, ip: ip(step.by), details: step.stage === 'credit' && s.crb ? { crb: { outcome: s.crb } } : undefined });
      if (action === 'approve') approvals.push({ name: fullName(await Staff.findById(users[step.by].staffId)), title: (await Staff.findById(users[step.by].staffId)).title, stage: STAGES[step.stage].short || STAGES[step.stage].label, at });
      enteredAt = at;
    }
    if (s.recommended) app.recommended = { ...s.recommended, by: id('LFB0233') };

    app.status = s.status;
    app.stageEnteredAt = enteredAt;
    if (STAGES[route.stages.find((k) => STAGES[k].status === s.status)]) {
      app.currentStage = route.stages.find((k) => STAGES[k].status === s.status);
      app.stageDueAt = wt.addWorkingHours(cal, enteredAt, STAGES[app.currentStage].target === 'ceo' ? cal.ceoTargetHours : cal.stageTargetHours);
    }
    if (s.status === 'rejected') {
      Object.assign(app, { closedAtStage: 'ceo', closedReason: s.steps.at(-1).comment, closedAt: enteredAt });
      Object.assign(agreement, { status: 'void', voidAt: enteredAt, voidReason: 'Application rejected' });
    }
    if (s.status === 'pending_reaccept') {
      const inst = calc.instalment(s.recommended.amount, s.recommended.tenor, pricing.interestBps, pricing.instalmentRounding);
      Object.assign(app, { approved: { amount: s.recommended.amount, tenor: s.recommended.tenor, instalment: inst }, finalApprovedAt: enteredAt, revisedExpiresAt: new Date(enteredAt.getTime() + settings.revisedTermsExpiryDays * DAY) });
    }
    if (s.status === 'pending_disbursement') {
      const rows = calc.schedule(s.amount, s.tenor, pricing.interestBps, pricing.instalmentRounding, calc.firstDueDate(localDay(enteredAt), settings.firstDueDay));
      Object.assign(app, { approved: { amount: s.amount, tenor: s.tenor, instalment: q.instalment }, finalApprovedAt: enteredAt, schedule: rows, scheduleBasis: 'final_approval' });
      const inForce = await fileStore.store(await agreementPdf({ blocks: textBlocks(doc.text), title: `Mkataba ${number} (${s.ref}) - unatumika`, evidence: [...evidence, ...approvals.map((x, i) => [`Kwa niaba ya Mwajiri ${i + 1}`, `${x.name}, ${x.title}, ${x.stage}, ${x.at.toISOString()}`])] }), { kind: 'agreement_pdf', originalName: `${number}-in-force.pdf`, applicationId: app._id, ownerUserId: id(s.a), uploadedBy: id('LFB0002') });
      Object.assign(agreement, { status: 'in_force', effectiveAt: enteredAt, inForcePdfFileId: inForce._id, approvals });
      await Staff.updateOne({ _id: staff._id }, { $push: { loanHistory: { productId: product._id, applicationId: app._id, ref: s.ref, appliedAt: submittedAt, approvedAt: enteredAt } } });
    }
    await agreement.save();
    await app.save();
    /* eslint-enable no-await-in-loop */
  }

  // The prototype's opening notifications for the people a demo starts with.
  const byRef = async (ref) => String((await Application.findOne({ ref }))._id);
  await Notification.insertMany([
    { userId: id('LFB0412'), type: 'application.revised_terms', text: 'SL-2026-00022 is approved at revised terms: TZS 4,500,000 over 36 months. Read and accept the revised agreement so OPS can disburse.', href: `/accept/${await byRef('SL-2026-00022')}` },
    { userId: id('LFB0412'), type: 'application.returned', text: 'SL-2026-00027 was returned for correction by the Credit Analyst.', href: `/applications/${await byRef('SL-2026-00027')}` },
    { userId: id('LFB0233'), type: 'application.stage', text: 'SL-2026-00031 from Aisha Kombo is waiting for your Credit Analyst review', href: `/review/${await byRef('SL-2026-00031')}` },
    { userId: id('LFB0233'), type: 'application.stage', text: 'SL-2026-00028 from Daniel Mrema is waiting for your Credit Analyst review (limited details)', href: `/review/${await byRef('SL-2026-00028')}` },
    { userId: id('LFB0051'), type: 'application.stage', text: 'SL-2026-00025 from Joseph Mwakalinga is waiting for your Head of HR review. You give final approval on this route.', href: `/review/${await byRef('SL-2026-00025')}` },
    { userId: id('LFB0129'), type: 'application.stage', text: 'SL-2026-00024 from Grace Mollel is waiting for your People and Culture Manager review', href: `/review/${await byRef('SL-2026-00024')}` },
    { userId: id('LFB0002'), type: 'application.stage', text: 'SL-2026-00026 from Salma Hamisi is waiting for your CEO approval', href: `/review/${await byRef('SL-2026-00026')}` },
    { userId: id('LFB0318'), type: 'application.ready_to_disburse', text: 'SL-2026-00019 has final approval. Ready to disburse.', href: '/disburse' },
  ]);
  return SAMPLES.length;
}

module.exports = { seedSampleApplications, SAMPLES };

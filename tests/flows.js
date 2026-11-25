'use strict';

// Shared steps for workflow tests: seed everything, apply, sign, decide.

const { app, seed, signIn, authed, PASSWORD, request } = require('./helpers');
const { seedProducts } = require('./fixtures/products');
const { seedAgreementTemplate } = require('../seed/agreementTemplate');
const { seedLegalNotices } = require('../seed/legalNotices');
const { samplePayslip } = require('../seed/samplePayslip');
const { PRICING } = require('./fixtures/products');
const Staff = require('../src/models/Staff');
const { PEOPLE } = require('../seed/data/people');
const { localDay } = require('../src/utils/dates');

const CONSENTS = { truth: true, deduct: true, crb: true, sms: true };

const api = (token) => ({
  get: (url) => request(app()).get(`/api/v1${url}`).set(authed(token)),
  post: (url, body = {}) => request(app()).post(`/api/v1${url}`).set(authed(token)).send(body),
  patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(authed(token)).send(body),
  put: (url, body) => request(app()).put(`/api/v1${url}`).set(authed(token)).send(body),
  delete: (url) => request(app()).delete(`/api/v1${url}`).set(authed(token)),
});

async function seedAll() {
  const { users } = await seed();
  const products = await seedProducts(users);
  await seedAgreementTemplate(users);
  await seedLegalNotices();
  return { users, products };
}

/**
 * The applicant's payslip (D-79), with the fictional person's pay unless overridden:
 * opts { basic, lfbLines, payDate }. Returns the upload response.
 */
async function attachPayslip(person, id, opts = {}) {
  const staffNo = person.body.data.user.staffNo;
  const staff = await Staff.findOne({ staffNo }).lean();
  const salary = PEOPLE.find((p) => p.staffNo === staffNo)?.pay || { basic: 1000000, allowances: 0 };
  const pdf = await samplePayslip({
    staff: { fullName: [staff.firstName, staff.middleName, staff.lastName].filter(Boolean).join(' '), staffNo, title: staff.title, department: staff.department },
    basic: opts.basic ?? salary.basic,
    allowances: salary.allowances || 0,
    payDate: opts.payDate || localDay(new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    lfbLines: opts.lfbLines || [],
    pricing: PRICING,
  });
  return request(app()).post(`/api/v1/applications/${id}/payslip`).set(authed(person.token)).attach('file', pdf, opts.name || 'payslip.pdf');
}

/** Applies, attaches the payslip and signs; returns the application id. */
async function applyAndSign(person, productId, terms) {
  const a = api(person.token);
  const created = await a.post('/applications', { productId: String(productId) });
  if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.body)}`);
  const id = created.body.data.id;
  await a.patch(`/applications/${id}`, { repaymentMethod: 'payroll', ...terms });
  const slip = await attachPayslip(person, id);
  if (slip.status !== 201) throw new Error(`payslip: ${JSON.stringify(slip.body)}`);
  await sign(person, id);
  return id;
}

async function sign(person, id) {
  const a = api(person.token);
  const preview = await a.get(`/applications/${id}/agreement/preview`);
  if (preview.status !== 200) throw new Error(`preview: ${JSON.stringify(preview.body)}`);
  const res = await a.post(`/applications/${id}/sign-and-submit`, { consents: CONSENTS, declarations: preview.body.data.blocks.filter((b) => b.type === 'declaration').map(() => true), accepted: true, scrolledToEnd: true, textSha256: preview.body.data.textSha256, dataProtection: true });
  if (res.status !== 200) throw new Error(`sign: ${JSON.stringify(res.body)}`);
  return res;
}

/** A small PDF, as a credit bureau report (D-105). */
const CRB_PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

/** Attaches a bureau report file at the credit stage; returns the upload response. */
const attachCrb = (person, id, name = 'crb-report.pdf') => request(app()).post(`/api/v1/review/${id}/crb-report`).set(authed(person.token)).attach('file', CRB_PDF, name);

/**
 * Decides at the current stage. Approving with a bureau outcome first attaches a report file
 * (D-105) unless one is already attached or body.crbFile is false.
 */
async function decide(person, id, body) {
  const { crbFile, ...rest } = body;
  if (rest.action === 'approve' && rest.crb && crbFile !== false) {
    const Application = require('../src/models/Application');
    const a = await Application.findById(id).lean();
    if (a?.currentStage === 'credit' && !(a.crb?.fileIds?.length || a.crb?.fileId)) await attachCrb(person, id);
  }
  return api(person.token).post(`/review/${id}/decision`, rest);
}

/** D-107: People and Culture book a finally approved loan (default the P&C Manager). */
async function bookLoan(id, { staffNo = 'LFB0129', loanAccountNumber = 'LN2026000123', date, note } = {}) {
  const { localDay: today } = require('../src/utils/dates');
  const person = await signIn(staffNo);
  return api(person.token).post(`/disbursements/${id}/book`, { loanAccountNumber, date: date || today(), ...(note ? { note } : {}) });
}

const CRB = { outcome: 'Low Risk', reportDate: '2026-10-28' };
const HR_OK = { employment: true, category: true, salary: true };

/**
 * Another running Staff Loans loan (D-87): approved, instalments still due. opts.firstDue: its
 * first instalment (default far ahead, so no payslip shows it yet; D-101).
 */
let refNo = 80000;
async function runningLoan(staffNo, productId, instalment, status = 'disbursed', { firstDue } = {}) {
  const Application = require('../src/models/Application');
  const ProductVersion = require('../src/models/ProductVersion');
  const User = require('../src/models/User');
  const [user, staff, version] = await Promise.all([User.findOne({ staffNo }), Staff.findOne({ staffNo }), ProductVersion.findOne({ productId, state: 'active' })]);
  refNo += 1;
  return Application.create({
    ref: `SL-2025-${refNo}`,
    applicantUserId: user._id,
    applicantStaffId: staff._id,
    productId,
    productVersionId: version._id,
    status,
    repayment: { method: 'payroll' },
    approved: { amount: 3000000, tenor: 24, instalment },
    finalApprovedAt: new Date(),
    schedule: [
      { n: 1, due: firstDue || localDay(new Date(Date.now() + 400 * 24 * 3600 * 1000)), instalment },
      { n: 2, due: localDay(new Date(Date.now() + 430 * 24 * 3600 * 1000)), instalment },
    ],
  });
}

module.exports = { api, seedAll, applyAndSign, attachPayslip, attachCrb, CRB_PDF, sign, decide, signIn, runningLoan, bookLoan, CRB, HR_OK, PASSWORD };

'use strict';

// Shared steps for workflow tests: seed everything, apply, sign, decide.

const { app, seed, signIn, authed, PASSWORD, request } = require('./helpers');
const { seedProducts } = require('../seed/products');
const { seedAgreementTemplate } = require('../seed/agreementTemplate');
const { samplePayslip } = require('../seed/samplePayslip');
const { PRICING } = require('../seed/products');
const Staff = require('../src/models/Staff');
const Salary = require('../src/models/Salary');
const { localDay } = require('../src/utils/dates');

const CONSENTS = { truth: true, deduct: true, crb: true, sms: true };

const api = (token) => ({
  get: (url) => request(app()).get(`/api/v1${url}`).set(authed(token)),
  post: (url, body = {}) => request(app()).post(`/api/v1${url}`).set(authed(token)).send(body),
  patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(authed(token)).send(body),
});

async function seedAll() {
  const { users } = await seed();
  const products = await seedProducts(users);
  await seedAgreementTemplate(users);
  return { users, products };
}

/**
 * The applicant's payslip (D-79), from their salary record unless overridden:
 * opts { basic, lfbLines, payDate }. Returns the upload response.
 */
async function attachPayslip(person, id, opts = {}) {
  const staffNo = person.body.data.user.staffNo;
  const staff = await Staff.findOne({ staffNo }).lean();
  const salary = await Salary.inForce(staff._id);
  const pdf = await samplePayslip({
    staff: { fullName: [staff.firstName, staff.middleName, staff.lastName].filter(Boolean).join(' '), staffNo, title: staff.title, department: staff.department },
    basic: opts.basic ?? salary.basic,
    allowances: salary.allowances,
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
  const res = await a.post(`/applications/${id}/sign-and-submit`, { consents: CONSENTS, accepted: true, scrolledToEnd: true, password: PASSWORD, textSha256: preview.body.data.textSha256 });
  if (res.status !== 200) throw new Error(`sign: ${JSON.stringify(res.body)}`);
  return res;
}

const decide = (person, id, body) => api(person.token).post(`/review/${id}/decision`, body);

const CRB = { outcome: 'Clear', reportDate: '2026-10-28' };
const HR_OK = { employment: true, category: true, salary: true };

module.exports = { api, seedAll, applyAndSign, attachPayslip, sign, decide, signIn, CRB, HR_OK, PASSWORD };

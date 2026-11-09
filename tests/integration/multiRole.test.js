'use strict';

// One person, several system roles (FR-46): job title stays the HR record's, permissions
// are the union of active roles, roles change one at a time, MFA follows any privileged
// role, and two review roles never let one person decide two stages of one application.

const XLSX = require('xlsx');
const { app, signIn, authed, request, PASSWORD } = require('../helpers');
const { api, seedAll, applyAndSign, decide, CRB, HR_OK } = require('../flows');
const Role = require('../../src/models/Role');
const User = require('../../src/models/User');
const Staff = require('../../src/models/Staff');
const RoleAssignment = require('../../src/models/RoleAssignment');
const AuditLog = require('../../src/models/AuditLog');
const Decision = require('../../src/models/Decision');
const Application = require('../../src/models/Application');

let products;
let admin;
const roleId = async (code) => String((await Role.findOne({ code }))._id);
const userOf = (staffNo) => User.findOne({ staffNo });
const put = async (staffNo, codes) =>
  request(app())
    .put(`/api/v1/users/${(await userOf(staffNo))._id}/roles`)
    .set(authed(admin.token))
    .send({ assignments: await Promise.all(codes.map(async (c) => ({ roleId: await roleId(c) }))) });
const codesOf = async (staffNo) => {
  const rows = await RoleAssignment.find({ userId: (await userOf(staffNo))._id, revokedAt: null }).populate('roleId').lean();
  return rows.map((r) => r.roleId.code).sort();
};

beforeEach(async () => {
  ({ products } = await seedAll());
  admin = await signIn('LFB0274'); // System Administrator
});

describe('job title and system roles are separate', () => {
  it('the profile carries the HR job title, whatever roles are held', async () => {
    // Asha Mfinanga: job title "Head of Operations", role Head of Credit.
    const asha = await signIn('LFB0010');
    expect(asha.body.data.user.title).toBe('Head of Operations');
    expect(asha.body.data.roles.map((r) => r.name)).toContain('Head of Credit');
    expect(asha.body.data.roles.map((r) => r.name)).not.toContain('Head of Operations');
  });

  it('changing roles leaves the job title; changing the job title leaves the roles', async () => {
    expect((await put('LFB0412', ['staff', 'ops', 'risk_audit_viewer'])).status).toBe(200);
    expect((await Staff.findOne({ staffNo: 'LFB0412' })).title).toBe('Customer Service Officer');

    const hr = await signIn('LFB0051');
    const staff = await Staff.findOne({ staffNo: 'LFB0412' });
    const res = await request(app()).patch(`/api/v1/staff/${staff._id}`).set(authed(hr.token)).send({ title: 'Senior Loan Officer' });
    expect(res.status).toBe(200);
    expect(await codesOf('LFB0412')).toEqual(['ops', 'risk_audit_viewer', 'staff']);
  });
});

describe('several roles at once', () => {
  it('holds three roles and gets every permission from all of them', async () => {
    const res = await put('LFB0412', ['staff', 'ops', 'risk_audit_viewer']);
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual(expect.arrayContaining(['loan.apply', 'disb.confirm', 'audit.view']));
    expect(await codesOf('LFB0412')).toEqual(['ops', 'risk_audit_viewer', 'staff']);
  });

  it('adding one role keeps the others, and the audit entry names what was added', async () => {
    await put('LFB0412', ['staff', 'risk_audit_viewer']);
    const keep = await RoleAssignment.findOne({ userId: (await userOf('LFB0412'))._id, roleId: await roleId('risk_audit_viewer'), revokedAt: null });
    await put('LFB0412', ['staff', 'risk_audit_viewer', 'ops']);
    expect(await codesOf('LFB0412')).toEqual(['ops', 'risk_audit_viewer', 'staff']);
    // The existing assignment is kept as it was, not re-created.
    expect(await RoleAssignment.exists({ _id: keep._id, revokedAt: null })).toBeTruthy();
    const entry = await AuditLog.findOne({ action: 'user.roles_change' }).sort({ _id: -1 });
    expect(entry.description).toMatch(/added OPS/);
    expect(entry.description).not.toMatch(/removed/);
  });

  it('removing one role keeps the others and revokes only its permissions', async () => {
    await put('LFB0412', ['staff', 'ops', 'risk_audit_viewer']);
    const res = await put('LFB0412', ['staff', 'risk_audit_viewer']);
    expect(res.body.data.permissions).not.toContain('disb.confirm');
    expect(res.body.data.permissions).toContain('audit.view');
    expect(await codesOf('LFB0412')).toEqual(['risk_audit_viewer', 'staff']);
    const entry = await AuditLog.findOne({ action: 'user.roles_change' }).sort({ _id: -1 });
    expect(entry.description).toMatch(/removed OPS/);
  });

  it('refuses the same role twice', async () => {
    const res = await put('LFB0412', ['staff', 'ops', 'ops']);
    expect(res.status).toBe(400);
  });

  it('MFA is required as soon as any one of the roles requires it', async () => {
    const login = () => request(app()).post('/api/v1/auth/login').send({ userName: 'lfb0412', password: PASSWORD });
    expect((await login()).body.data.accessToken).toBeTruthy(); // Staff only: password alone
    await put('LFB0412', ['staff', 'ops']);
    const res = await login();
    expect(res.body.data.enrolRequired || res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it('a staff upload does not add, remove or change system roles', async () => {
    await put('LFB0412', ['staff', 'ops']);
    const hr = await signIn('LFB0051');
    const ws = XLSX.utils.json_to_sheet([{ 'Staff Number/Code': 'LFB0412', 'First name': 'Neema', Surname: 'Mushi', Username: 'lfb0412', Title: 'Chief Executive Officer', Category: 'Non-management' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Staff');
    const file = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const up = await request(app()).post('/api/v1/staff/import').set(authed(hr.token)).attach('file', file, 'staff.xlsx');
    expect(up.status).toBe(201);
    expect((await request(app()).post(`/api/v1/staff/import/${up.body.data.id}/commit`).set(authed(hr.token))).status).toBe(200);
    expect((await Staff.findOne({ staffNo: 'LFB0412' })).title).toBe('Chief Executive Officer');
    expect(await codesOf('LFB0412')).toEqual(['ops', 'staff']);
  });
});

describe('two review roles never decide two stages of one application', () => {
  async function grantCeoToCreditAnalyst() {
    const juma = await userOf('LFB0233');
    await RoleAssignment.create({ userId: juma._id, roleId: await roleId('ceo'), assignedBy: juma._id });
  }

  it('a Credit Analyst who also holds the CEO role cannot give the CEO approval after approving at Credit', async () => {
    await grantCeoToCreditAnalyst();
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture' });

    const juma = await signIn('LFB0233');
    expect((await decide(juma, id, { action: 'approve', crb: CRB })).status).toBe(200);
    const grace = await signIn('LFB0051');
    expect((await decide(grace, id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
    expect((await Application.findById(id)).status).toBe('pending_ceo');

    const again = await decide(juma, id, { action: 'approve' });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('SEPARATE_STAGES');
    // It is not in their queue either; the CEO still decides.
    expect((await api(juma.token).get('/queue')).body.data.items.map((i) => i.id)).not.toContain(String(id));
    const joseph = await signIn('LFB0002');
    expect((await decide(joseph, id, { action: 'approve' })).status).toBe(200);

    const rows = await Decision.find({ applicationId: id, action: 'approve' }).sort({ at: 1 }).lean();
    expect(rows.map((r) => r.stage)).toEqual(['credit', 'hr', 'ceo']);
    expect(new Set(rows.map((r) => String(r.actorId))).size).toBe(3);
  });

  it('holding both roles still lets them decide a stage someone else did not leave to them', async () => {
    await grantCeoToCreditAnalyst();
    const salma = await userOf('LFB0377');
    await RoleAssignment.create({ userId: salma._id, roleId: await roleId('credit_analyst'), assignedBy: salma._id });
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture' });
    expect((await decide(await signIn('LFB0377'), id, { action: 'approve', crb: CRB })).status).toBe(200);
    expect((await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK })).status).toBe(200);
    // Juma (Credit Analyst and CEO) did not touch this application, so the CEO approval is theirs to give.
    expect((await decide(await signIn('LFB0233'), id, { action: 'approve' })).status).toBe(200);
    expect((await Application.findById(id)).status).toBe('pending_disbursement');
  });

  it('nobody reviews their own application, whatever roles they hold', async () => {
    const neema = await signIn('LFB0412');
    const id = await applyAndSign(neema, products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture' });
    const neemaUser = await userOf('LFB0412');
    await RoleAssignment.create({ userId: neemaUser._id, roleId: await roleId('credit_analyst'), assignedBy: neemaUser._id });
    const self = await signIn('LFB0412');
    const res = await decide(self, id, { action: 'approve', crb: CRB });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_REVIEW');
  });
});

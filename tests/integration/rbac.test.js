'use strict';

// Roles, permissions and segregation of duties (BRD 9.5: FR-43 to FR-52).

const { app, seed, signIn, authed, request } = require('../helpers');
const Role = require('../../src/models/Role');
const User = require('../../src/models/User');
const RoleAssignment = require('../../src/models/RoleAssignment');
const AuditLog = require('../../src/models/AuditLog');

let admin;
const roleId = async (code) => String((await Role.findOne({ code }))._id);
const userId = async (staffNo) => String((await User.findOne({ staffNo }))._id);
const put = (token, id, assignments) => request(app()).put(`/api/v1/users/${id}/roles`).set(authed(token)).send({ assignments });

beforeEach(async () => {
  await seed();
  admin = await signIn('LFB0274'); // Peter Lyimo, System Administrator
});

describe('role catalogue (FR-43, FR-44)', () => {
  it('ships the system roles, including the D-88 to D-90 roles', async () => {
    const res = await request(app()).get('/api/v1/roles').set(authed(admin.token));
    expect(res.status).toBe(200);
    const system = res.body.data.filter((r) => r.system).map((r) => r.name).sort();
    expect(system).toEqual(['Auditor', 'CEO', 'Credit Analyst', 'Head of Credit', 'Head of Legal', 'Head of People and Culture', 'Head of Risk and Compliance', 'Legal Officer', 'OPS', 'People and Culture Manager', 'Staff', 'System Administrator']);
    expect(res.body.data.find((r) => r.code === 'staff').holders).toBe(13);
  });

  it('lists the permission catalogue grouped by area', async () => {
    const res = await request(app()).get('/api/v1/permissions').set(authed(admin.token));
    const groups = new Set(res.body.data.permissions.map((p) => p.group));
    expect([...groups]).toEqual(['My loans', 'Reviews', 'Operations', 'Staff records', 'Reports', 'Administration']);
  });

  it('a staff member cannot read or change roles', async () => {
    const neema = await signIn('LFB0412');
    expect((await request(app()).get('/api/v1/roles').set(authed(neema.token))).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: 'security.permission_denied' })).toBe(1);
  });
});

describe('custom roles and the matrix (FR-45)', () => {
  it('creates, renames and deletes a custom role, with before/after in the audit log (FR-50)', async () => {
    const created = await request(app()).post('/api/v1/roles').set(authed(admin.token)).send({ name: 'Finance Viewer', permissions: ['reports.view'] });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const renamed = await request(app()).patch(`/api/v1/roles/${id}`).set(authed(admin.token)).send({ name: 'Finance Reports', permissions: ['reports.view', 'reports.export'] });
    expect(renamed.body.data.name).toBe('Finance Reports');
    const entry = await AuditLog.findOne({ action: 'role.update' });
    expect(entry.before.permissions).toEqual(['reports.view']);
    expect(entry.after.permissions).toEqual(['reports.view', 'reports.export']);
    expect((await request(app()).delete(`/api/v1/roles/${id}`).set(authed(admin.token))).status).toBe(200);
  });

  it('refuses a role that combines administration and approval', async () => {
    const res = await request(app()).post('/api/v1/roles').set(authed(admin.token)).send({ name: 'Bad', permissions: ['admin.users', 'review.ceo'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOD_CONFLICT');
    expect(res.body.message).toMatch(/administration is kept apart from approving and disbursing/);
  });

  it('refuses a role change that would breach SoD for a holder', async () => {
    // Juma holds Credit Analyst; adding disbursement to OPS is fine, but adding approval to OPS breaches sod2 for Halima.
    const ops = await roleId('ops');
    const res = await request(app()).patch(`/api/v1/roles/${ops}`).set(authed(admin.token)).send({ permissions: ['disb.confirm', 'review.credit'] });
    expect(res.status).toBe(409);
  });

  it('system roles cannot be deleted', async () => {
    const res = await request(app()).delete(`/api/v1/roles/${await roleId('ceo')}`).set(authed(admin.token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SYSTEM_ROLE');
  });

  it('a custom role in use cannot be deleted', async () => {
    const res = await request(app()).delete(`/api/v1/roles/${await roleId('risk_audit_viewer')}`).set(authed(admin.token));
    expect(res.status).toBe(409);
  });

  it('the Staff role keeps its locked permissions', async () => {
    const res = await request(app()).patch(`/api/v1/roles/${await roleId('staff')}`).set(authed(admin.token)).send({ permissions: ['loan.viewOwn'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOCKED_PERMISSION');
  });

  it('live SoD check reports conflicts without saving', async () => {
    const res = await request(app()).post('/api/v1/roles/sod-check').set(authed(admin.token)).send({ permissions: ['review.hr', 'disb.confirm'] });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.conflicts[0].rule).toBe('sod2');
  });
});

describe('assigning roles to users (FR-46, FR-48)', () => {
  it('assigns several roles with an end date', async () => {
    const res = await put(admin.token, await userId('LFB0412'), [
      { roleId: await roleId('staff') },
      { roleId: await roleId('risk_audit_viewer'), endsOn: '2027-03-31' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toContain('audit.view');
    const entry = await AuditLog.findOne({ action: 'user.roles_change' });
    expect(entry.before).toEqual([{ code: 'staff', endsOn: null }]);
    expect(entry.after[1]).toMatchObject({ code: 'risk_audit_viewer' });
  });

  it('refuses a combination that breaches SoD, with the reason', async () => {
    const res = await put(admin.token, await userId('LFB0233'), [{ roleId: await roleId('staff') }, { roleId: await roleId('credit_analyst') }, { roleId: await roleId('ops') }]);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/approving is kept apart from confirming disbursement/);
    expect(await AuditLog.countDocuments({ action: 'user.roles_refused' })).toBe(1);
  });

  it('refuses giving one user both product approval stages (D-89)', async () => {
    const res = await put(admin.token, await userId('LFB0010'), [{ roleId: await roleId('staff') }, { roleId: await roleId('head_credit') }, { roleId: await roleId('head_risk') }]);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/two product approvals are held by different people/);
  });

  it('every staff member keeps the Staff role, without an end date', async () => {
    const id = await userId('LFB0412');
    expect((await put(admin.token, id, [{ roleId: await roleId('risk_audit_viewer') }])).body.code).toBe('STAFF_ROLE_REQUIRED');
    expect((await put(admin.token, id, [{ roleId: await roleId('staff'), endsOn: '2027-01-01' }])).body.code).toBe('STAFF_ROLE_REQUIRED');
  });

  it('an administrator cannot change their own roles', async () => {
    const res = await put(admin.token, await userId('LFB0274'), [{ roleId: await roleId('staff') }, { roleId: await roleId('sys_admin') }, { roleId: await roleId('risk_audit_viewer') }]);
    expect(res.status).toBe(403);
  });

  it('a role past its end date no longer grants permissions', async () => {
    const neemaId = await userId('LFB0412');
    await RoleAssignment.create({ userId: neemaId, roleId: await roleId('risk_audit_viewer'), endsOn: new Date('2020-01-31T00:00:00Z') });
    const neema = await signIn('LFB0412');
    expect(neema.body.data.permissions).not.toContain('audit.view');
  });
});

describe('permission changes apply at once (FR-51)', () => {
  it('a signed-in user loses access on the next request with the same token', async () => {
    const daniel = await signIn('LFB0067'); // Risk and Audit Viewer
    expect((await request(app()).get('/api/v1/audit').set(authed(daniel.token))).status).toBe(200);
    await put(admin.token, await userId('LFB0067'), [{ roleId: await roleId('staff') }]);
    expect((await request(app()).get('/api/v1/audit').set(authed(daniel.token))).status).toBe(403);
  });

  it('a signed-in user gains access on the next request with the same token', async () => {
    const neema = await signIn('LFB0412');
    expect((await request(app()).get('/api/v1/audit').set(authed(neema.token))).status).toBe(403);
    await put(admin.token, await userId('LFB0412'), [{ roleId: await roleId('staff') }, { roleId: await roleId('risk_audit_viewer') }]);
    expect((await request(app()).get('/api/v1/audit').set(authed(neema.token))).status).toBe(200);
  });

  it('a privileged permission granted mid-session needs a fresh MFA sign-in', async () => {
    const neema = await signIn('LFB0412'); // this session was opened without MFA
    const created = await request(app()).post('/api/v1/roles').set(authed(admin.token)).send({ name: 'Calendar Keeper', permissions: ['admin.workflow'] });
    await put(admin.token, await userId('LFB0412'), [{ roleId: await roleId('staff') }, { roleId: created.body.data.id }]);
    const me = await request(app()).get('/api/v1/auth/me').set(authed(neema.token));
    expect(me.body.data.permissions).toContain('admin.workflow');
    expect(me.body.data.mfaRequired).toBe(true);
    const settings = await request(app()).get('/api/v1/admin/settings').set(authed(neema.token));
    expect(settings.status).toBe(403);
    expect(settings.body.code).toBe('MFA_STEP_UP');
    // After signing in again with enrolment and a code, it works.
    const fresh = await signIn('LFB0412');
    expect((await request(app()).get('/api/v1/admin/settings').set(authed(fresh.token))).status).toBe(200);
  });

  it('deactivating a role removes its permissions from holders', async () => {
    const daniel = await signIn('LFB0067');
    await request(app()).patch(`/api/v1/roles/${await roleId('risk_audit_viewer')}`).set(authed(admin.token)).send({ active: false });
    expect((await request(app()).get('/api/v1/audit').set(authed(daniel.token))).status).toBe(403);
  });
});

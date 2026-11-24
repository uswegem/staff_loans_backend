'use strict';

// The fictional test staff (seed/data/testStaff.js, scripts/test-staff.js): complete
// records, roles for the CEO and Head of People and Culture, and payslips that the
// payslip reader accepts for their own staff number only.

const fs = require('fs');
const path = require('path');
const { seed } = require('../helpers');
const Staff = require('../../src/models/Staff');
const User = require('../../src/models/User');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');
const Salary = require('../../src/models/Salary');
const reader = require('../../src/services/payslip/payslipReader');
const { completeness } = require('../../src/services/staff/profileService');
const { applyBlockers } = require('../../src/services/staff/eligibilityService');
const testStaff = require('../../scripts/test-staff');
const { TEST_STAFF, PAY_DATE } = require('../../seed/data/testStaff');

jest.setTimeout(120000);

describe('test staff', () => {
  beforeEach(async () => {
    await seed();
    process.env.RESET_TEMP_PASSWORD = 'Karibu#SLAS-2026x';
  });
  afterEach(() => {
    delete process.env.RESET_TEMP_PASSWORD;
  });

  it('are ten fictional people with TST staff numbers, one CEO and one Head of People and Culture', () => {
    expect(TEST_STAFF).toHaveLength(10);
    expect(new Set(TEST_STAFF.map((p) => p.staffNo)).size).toBe(10);
    TEST_STAFF.forEach((p) => expect(p.staffNo).toMatch(/^TST\d{3}$/));
    expect(TEST_STAFF.filter((p) => p.roles.includes('ceo')).map((p) => p.title)).toEqual(['Chief Executive Officer']);
    expect(TEST_STAFF.filter((p) => p.roles.includes('head_pc')).map((p) => p.title)).toEqual(['Head of People and Culture']);
  });

  it('a dry run changes nothing', async () => {
    const before = await Staff.countDocuments();
    const out = await testStaff.load({ dryRun: true, ownConnection: false });
    expect(out.plan).toHaveLength(10);
    expect(await Staff.countDocuments()).toBe(before);
  });

  it('loads complete records, accounts, roles and salaries, and is safe to run again', async () => {
    const first = await testStaff.load({ ownConnection: false });
    expect(first.loaded).toMatchObject({ created: 10, updated: 0, usersCreated: 10, salaries: 10 });

    for (const p of TEST_STAFF) {
      /* eslint-disable no-await-in-loop */
      const staff = await Staff.findOne({ staffNo: p.staffNo });
      expect(await completeness(staff)).toMatchObject({ complete: true, missing: [] });
      expect(applyBlockers(staff)).toEqual([]);
      const user = await User.findOne({ staffNo: p.staffNo });
      expect(user.mustChangePassword).toBe(true);
      const codes = (await RoleAssignment.find({ userId: user._id, revokedAt: null }).populate('roleId').lean()).map((a) => a.roleId.code).sort();
      expect(codes).toEqual(['staff', ...p.roles].sort());
      const salary = await Salary.inForce(staff._id, new Date(`${PAY_DATE}T12:00:00+03:00`));
      expect(salary).toMatchObject({ basic: p.pay.basic, allowances: p.pay.allowances || 0 });
      /* eslint-enable no-await-in-loop */
    }

    const again = await testStaff.load({ ownConnection: false });
    expect(again.loaded).toMatchObject({ created: 0, updated: 10, usersCreated: 0, salaries: 0 });
    expect(await User.countDocuments({ staffNo: /^TST/ })).toBe(10);
    const ceoRole = await Role.findOne({ code: 'ceo' });
    expect(await RoleAssignment.countDocuments({ roleId: ceoRole._id, revokedAt: null, userId: (await User.findOne({ staffNo: 'TST101' }))._id })).toBe(1);
  });

  it('never overwrites a staff number held by someone else', async () => {
    await Staff.create({ staffNo: 'TST105', firstName: 'Someone', lastName: 'Else', category: 'Non-management' });
    await expect(testStaff.load({ ownConnection: false })).rejects.toThrow('TST105 (Someone Else)');
    expect(await Staff.countDocuments({ staffNo: /^TST/ })).toBe(1);
  });

  it('each committed payslip matches the dataset and reads only for its own staff number', async () => {
    const files = fs.readdirSync(testStaff.PAYSLIP_DIR);
    expect(files).toHaveLength(10);
    for (const p of TEST_STAFF) {
      /* eslint-disable no-await-in-loop */
      const file = files.find((f) => f.startsWith(p.staffNo.toLowerCase()));
      const pdf = fs.readFileSync(path.join(testStaff.PAYSLIP_DIR, file));
      const out = await reader.read(pdf, { staff: { staffNo: p.staffNo } });
      expect(out).toEqual({
        basic: p.pay.basic,
        payDate: '2026-11-30',
        lfbLines: p.lfbLines.map((l) => ({ label: l.label, amount: l.amount })),
        lfbDeductions: p.lfbLines.reduce((s, l) => s + l.amount, 0),
      });
      expect((await reader.read(pdf, { staff: { staffNo: 'AT637' } })).problem.code).toBe('PAYSLIP_NOT_YOURS');
      /* eslint-enable no-await-in-loop */
    }
  });
});

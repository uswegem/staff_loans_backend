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
const { TEST_STAFF, PAY_DATE, CAR_LOAN_LABEL } = require('../../seed/data/testStaff');

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

  it('the staff sheet has the agreed columns, in order, filled for everyone', () => {
    const [head, ...rows] = testStaff.sheetRows();
    expect(head).toEqual([
      'SN', 'Staff Number', 'Full Name', 'First Name', 'Middle Name', 'Last Name', 'Gender', 'Department', 'Job Title', 'Category',
      'Employment Type', 'Date Joined', 'Probation End Date', 'Contract End Date',
      'Email', 'Username', 'Marital Status', 'Date of Birth', 'NIDA Number', 'Nationality', 'Mobile Phone', 'Work Phone',
      'Region', 'District', 'Ward', 'Street', 'House Number', 'Branch', 'Bank Name', 'Bank Branch', 'Bank Account Name', 'Bank Account Number',
      'Next of Kin First Name', 'Next of Kin Surname', 'Next of Kin Relationship', 'Next of Kin Phone', 'Next of Kin Address',
    ]);
    expect(rows).toHaveLength(10);
    // Probation and contract end dates apply only to those on probation or contract.
    const optional = new Set(['Probation End Date', 'Contract End Date'].map((h) => head.indexOf(h)));
    rows.forEach((r) => r.forEach((v, c) => optional.has(c) || expect(String(v)).not.toBe('')));
    expect(rows.find((r) => r[1] === 'TST108')[head.indexOf('Probation End Date')]).toBe('2026-12-01');
    expect(rows.find((r) => r[1] === 'TST109')[head.indexOf('Contract End Date')]).toBe('2027-12-31');
    expect(rows[0].slice(0, 6)).toEqual([1, 'TST101', 'Bahati Grace Mfano', 'Bahati', 'Grace', 'Mfano']);
    expect(new Set(rows.map((r) => r[head.indexOf('Username')])).size).toBe(10);
  });

  it('never takes a username used by another staff number', async () => {
    await Staff.create({ staffNo: 'AT9100', userName: 'juma.mfano', firstName: 'Juma', lastName: 'Other', category: 'Non-management' });
    await expect(testStaff.load({ ownConnection: false })).rejects.toThrow('juma.mfano (AT9100)');
    expect(await Staff.countDocuments({ staffNo: /^TST/ })).toBe(0);
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
      expect(staff).toMatchObject({ middleName: p.middleName, userName: p.userName });
      const user = await User.findOne({ staffNo: p.staffNo });
      expect(user).toMatchObject({ userName: p.userName, mustChangePassword: true });
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

  it('mixes payslips with a staff loan, a car loan, both, and no loan deduction', () => {
    const labels = (p) => p.lfbLines.map((l) => l.label).sort().join('+');
    const kinds = new Set(TEST_STAFF.map(labels));
    expect([...kinds].sort()).toEqual(['', 'CAR LOAN', 'CAR LOAN+STAFF LOAN', 'STAFF LOAN']);
  });

  it('each committed payslip matches the dataset and reads only for its own staff number', async () => {
    // CAR LOAN is read as a product's payslip deduction label (D-101).
    const rules = { ...reader.DEFAULT_RULES, productLabels: [CAR_LOAN_LABEL] };
    const files = fs.readdirSync(testStaff.PAYSLIP_DIR);
    expect(files).toHaveLength(10);
    for (const p of TEST_STAFF) {
      /* eslint-disable no-await-in-loop */
      const file = files.find((f) => f.startsWith(p.staffNo.toLowerCase()));
      const pdf = fs.readFileSync(path.join(testStaff.PAYSLIP_DIR, file));
      const out = await reader.read(pdf, { staff: { staffNo: p.staffNo }, rules });
      expect(out).toEqual({
        basic: p.pay.basic,
        payDate: '2026-11-30',
        lfbLines: p.lfbLines.map((l) => ({ label: l.label, amount: l.amount })),
        lfbDeductions: p.lfbLines.reduce((s, l) => s + l.amount, 0),
      });
      expect((await reader.read(pdf, { staff: { staffNo: 'AT637' }, rules })).problem.code).toBe('PAYSLIP_NOT_YOURS');
      /* eslint-enable no-await-in-loop */
    }
  });
});

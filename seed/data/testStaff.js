'use strict';

// Ten FICTIONAL staff for testing the full journey on a non-production system, with
// complete records (profile, bank, next of kin, verified date of birth, salary) and a
// matching November 2026 payslip each (scripts/test-staff.js).
//
// Staff numbers use the TST prefix so they can never be a real payroll employee code
// (real codes look like AT637): a test payslip therefore only passes the employee code
// check for a test account. Names use the surname Mfano ("example"), as in
// seed/data/lfb-staff.example.csv. Phone numbers, NIDA and account numbers are made up.
//
// roles: beyond Staff. TST101 is the CEO and TST102 the Head of People and Culture (HR),
// to test their review journeys; everyone else is Staff only.
// payslip.lfbLines: the staff loan lines printed on the payslip; each is also declared
// as an existing LFB loan on the profile, as the staff member would.

const TEST_STAFF_PREFIX = 'TST';
const PAY_DATE = '2026-11-25';

const TEST_STAFF = [
  {
    staffNo: 'TST101', firstName: 'Bahati', lastName: 'Mfano', gender: 'Female', roles: ['ceo'],
    title: 'Chief Executive Officer', department: 'Executive Office', station: 'Head Office, Dar es Salaam', category: 'Management',
    employmentType: 'Permanent', dateJoined: '2015-03-02', dob: '1974-05-14', maritalStatus: 'Married',
    mobile: '+255 700 101 001', workPhone: '+255 22 000 0101',
    address: { region: 'Dar-Es-Salaam', district: 'Ilala', ward: 'Buguruni', street: 'Mtaa wa Uhuru', house: 'Plot 1' },
    bankBranch: 'Head Office', accountNo: '4010 9999 0101',
    nextOfKin: [{ firstName: 'Baraka', lastName: 'Mfano', relationship: 'Spouse', phone: '+255 700 201 001', address: 'Buguruni, Dar es Salaam', employer: 'Self-employed' }],
    pay: { basic: 18000000 },
    lfbLines: [],
  },
  {
    staffNo: 'TST102', firstName: 'Halima', lastName: 'Mfano', gender: 'Female', roles: ['head_pc'],
    title: 'Head of People and Culture', department: 'People and Culture', station: 'Head Office, Dar es Salaam', category: 'Management',
    employmentType: 'Permanent', dateJoined: '2017-08-14', dob: '1980-11-03', maritalStatus: 'Married',
    mobile: '+255 700 101 002', workPhone: '+255 22 000 0102',
    address: { region: 'Dar-Es-Salaam', district: 'Ilala', ward: 'Buguruni', street: 'Mtaa wa Amani', house: 'Plot 22' },
    bankBranch: 'Head Office', accountNo: '4010 9999 0102',
    nextOfKin: [{ firstName: 'Hamisi', lastName: 'Mfano', relationship: 'Spouse', phone: '+255 700 201 002', address: 'Buguruni, Dar es Salaam', employer: 'Ministry of Health' }],
    pay: { basic: 9500000 },
    lfbLines: [{ label: 'STAFF LOAN', amount: 650000, outstanding: 9100000, description: 'Personal loan (2025)' }],
  },
  {
    staffNo: 'TST103', firstName: 'Amani', lastName: 'Mfano', gender: 'Male', roles: [],
    title: 'Relationship Officer', department: 'Business', station: 'Arusha Branch', category: 'Non-management',
    stationHead: { name: 'Branch Manager (test)', phone: '+255 700 301 003' },
    employmentType: 'Permanent', dateJoined: '2020-02-03', dob: '1991-02-19', maritalStatus: 'Single',
    mobile: '+255 700 101 003', workPhone: '+255 27 000 0103',
    address: { region: 'Arusha', district: 'Arusha', ward: 'Bangata', street: 'Mtaa wa Sokoine', house: 'House 7' },
    bankBranch: 'Arusha', accountNo: '4010 9999 0103',
    nextOfKin: [{ firstName: 'Mariam', lastName: 'Mfano', relationship: 'Parent', phone: '+255 700 201 003', address: 'Bangata, Arusha', employer: '' }],
    pay: { basic: 2400000, allowances: 250000 },
    lfbLines: [],
  },
  {
    staffNo: 'TST104', firstName: 'Rehema', lastName: 'Mfano', gender: 'Female', roles: [],
    title: 'Teller', department: 'Branch Network', station: 'Dodoma Branch', category: 'Non-management',
    stationHead: { name: 'Branch Manager (test)', phone: '+255 700 301 004' },
    employmentType: 'Permanent', dateJoined: '2022-05-09', dob: '1996-08-27', maritalStatus: 'Single',
    mobile: '+255 700 101 004', workPhone: '+255 26 000 0104',
    address: { region: 'Dodoma', district: 'Chamwino', ward: 'Chamwino', street: 'Mtaa wa Kati', house: 'House 12' },
    bankBranch: 'Dodoma', accountNo: '4010 9999 0104',
    nextOfKin: [{ firstName: 'Saidi', lastName: 'Mfano', relationship: 'Sibling', phone: '+255 700 201 004', address: 'Chamwino, Dodoma', employer: 'TANESCO' }],
    pay: { basic: 1200000, allowances: 120000 },
    lfbLines: [{ label: 'STAFF LOAN', amount: 150000, outstanding: 1350000, description: 'Salary advance top-up (2026)' }],
  },
  {
    staffNo: 'TST105', firstName: 'Juma', lastName: 'Mfano', gender: 'Male', roles: [],
    title: 'Credit Officer', department: 'Credit', station: 'Head Office, Dar es Salaam', category: 'Non-management',
    employmentType: 'Permanent', dateJoined: '2018-10-01', dob: '1988-04-06', maritalStatus: 'Married',
    mobile: '+255 700 101 005', workPhone: '+255 22 000 0105',
    address: { region: 'Dar-Es-Salaam', district: 'Ilala Cbd', ward: 'Gerezani', street: 'Mtaa wa Lumumba', house: 'Flat 3B' },
    bankBranch: 'Head Office', accountNo: '4010 9999 0105',
    nextOfKin: [{ firstName: 'Asha', lastName: 'Mfano', relationship: 'Spouse', phone: '+255 700 201 005', address: 'Gerezani, Dar es Salaam', employer: 'CRDB Bank' }],
    pay: { basic: 3200000 },
    lfbLines: [{ label: 'STAFF LOAN', amount: 420000, outstanding: 5040000, description: 'Home improvement loan (2025)' }],
  },
  {
    staffNo: 'TST106', firstName: 'Neema', lastName: 'Mfano', gender: 'Female', roles: [],
    title: 'Operations Officer', department: 'Central Operations', station: 'Head Office, Dar es Salaam', category: 'Non-management',
    employmentType: 'Permanent', dateJoined: '2019-01-14', dob: '1990-12-09', maritalStatus: 'Married',
    mobile: '+255 700 101 006', workPhone: '+255 22 000 0106',
    address: { region: 'Dar-Es-Salaam', district: 'Ilala', ward: 'Bonyokwa', street: 'Mtaa wa Bonyokwa', house: 'House 40' },
    bankBranch: 'Head Office', accountNo: '4010 9999 0106',
    nextOfKin: [{ firstName: 'Petro', lastName: 'Mfano', relationship: 'Spouse', phone: '+255 700 201 006', address: 'Bonyokwa, Dar es Salaam', employer: 'Self-employed' }],
    pay: { basic: 2600000 },
    // Two staff loan lines, to test a payslip with several LFB deductions.
    lfbLines: [
      { label: 'STAFF LOAN', amount: 300000, outstanding: 3000000, description: 'Personal loan (2025)' },
      { label: 'LFB LOAN', amount: 100000, outstanding: 600000, description: 'School fees loan (2026)' },
    ],
  },
  {
    staffNo: 'TST107', firstName: 'Daudi', lastName: 'Mfano', gender: 'Male', roles: [],
    title: 'Branch Manager', department: 'Branch Network', station: 'Mwanza Branch', category: 'Non-management',
    stationHead: { name: 'Regional Manager (test)', phone: '+255 700 301 007' },
    employmentType: 'Permanent', dateJoined: '2016-07-04', dob: '1984-09-22', maritalStatus: 'Married',
    mobile: '+255 700 101 007', workPhone: '+255 28 000 0107',
    address: { region: 'Mwanza', district: 'Ilemela', ward: 'Buswelu', street: 'Mtaa wa Ziwa', house: 'Plot 9' },
    bankBranch: 'Mwanza', accountNo: '4010 9999 0107',
    nextOfKin: [{ firstName: 'Esther', lastName: 'Mfano', relationship: 'Spouse', phone: '+255 700 201 007', address: 'Buswelu, Mwanza', employer: 'Bugando Hospital' }],
    pay: { basic: 5000000 },
    lfbLines: [{ label: 'STAFF LOAN', amount: 800000, outstanding: 14400000, description: 'Vehicle loan (2025)' }],
  },
  {
    staffNo: 'TST108', firstName: 'Zawadi', lastName: 'Mfano', gender: 'Female', roles: [],
    title: 'Customer Service Officer', department: 'Branch Network', station: 'Mbeya Branch', category: 'Non-management',
    stationHead: { name: 'Branch Manager (test)', phone: '+255 700 301 008' },
    // On probation: tests the eligibility rules for new staff.
    employmentType: 'Probation', dateJoined: '2026-06-01', probationEndDate: '2026-12-01', dob: '1999-03-30', maritalStatus: 'Single',
    mobile: '+255 700 101 008', workPhone: '+255 25 000 0108',
    address: { region: 'Mbeya', district: 'Kyela', ward: 'Bondeni', street: 'Mtaa wa Soko', house: 'House 5' },
    bankBranch: 'Mbeya', accountNo: '4010 9999 0108',
    nextOfKin: [{ firstName: 'Yusuph', lastName: 'Mfano', relationship: 'Parent', phone: '+255 700 201 008', address: 'Kyela, Mbeya', employer: '' }],
    pay: { basic: 1500000, allowances: 100000 },
    lfbLines: [],
  },
  {
    staffNo: 'TST109', firstName: 'Faraji', lastName: 'Mfano', gender: 'Male', roles: [],
    title: 'IT Support Officer', department: 'IT and Cybersecurity', station: 'Head Office, Dar es Salaam', category: 'Non-management',
    // On a fixed-term contract: tests contract-end limits on the tenor.
    employmentType: 'Contract', dateJoined: '2025-01-06', contractEndDate: '2027-12-31', dob: '1993-06-15', maritalStatus: 'Single',
    mobile: '+255 700 101 009', workPhone: '+255 22 000 0109',
    address: { region: 'Dar-Es-Salaam', district: 'Ilala Cbd', ward: 'Jangwani', street: 'Mtaa wa Msimbazi', house: 'Flat 10' },
    bankBranch: 'Head Office', accountNo: '4010 9999 0109',
    nextOfKin: [{ firstName: 'Tumaini', lastName: 'Mfano', relationship: 'Sibling', phone: '+255 700 201 009', address: 'Jangwani, Dar es Salaam', employer: 'Vodacom' }],
    pay: { basic: 3800000 },
    lfbLines: [],
  },
  {
    staffNo: 'TST110', firstName: 'Upendo', lastName: 'Mfano', gender: 'Female', roles: [],
    title: 'Senior Accountant', department: 'Finance', station: 'Head Office, Dar es Salaam', category: 'Non-management',
    employmentType: 'Permanent', dateJoined: '2014-09-15', dob: '1978-01-25', maritalStatus: 'Widowed',
    mobile: '+255 700 101 010', workPhone: '+255 22 000 0110',
    address: { region: 'Dar-Es-Salaam', district: 'Ilala', ward: 'Buguruni', street: 'Mtaa wa Rozana', house: 'Plot 31' },
    bankBranch: 'Head Office', accountNo: '4010 9999 0110',
    nextOfKin: [{ firstName: 'Grace', lastName: 'Mfano', relationship: 'Child', phone: '+255 700 201 010', address: 'Buguruni, Dar es Salaam', employer: 'University of Dar es Salaam' }],
    // A large existing deduction, close to the affordability limit.
    pay: { basic: 4100000 },
    lfbLines: [{ label: 'STAFF LOAN', amount: 1200000, outstanding: 21600000, description: 'Mortgage top-up (2024)' }],
  },
];

const day = (s) => (s ? new Date(`${s}T00:00:00+03:00`) : undefined);
const fullName = (p) => `${p.firstName} ${p.lastName}`;

/** The Staff document for a test person: a complete profile, ready to apply. */
function toStaffDoc(p) {
  return {
    staffNo: p.staffNo,
    userName: p.staffNo.toLowerCase(),
    firstName: p.firstName,
    lastName: p.lastName,
    gender: p.gender,
    title: p.title,
    department: p.department,
    station: p.station,
    stationHead: p.stationHead,
    category: p.category,
    employmentType: p.employmentType,
    dateJoined: day(p.dateJoined),
    probationEndDate: day(p.probationEndDate),
    contractEndDate: day(p.contractEndDate),
    incomeClass: 'fixed',
    email: `${p.staffNo.toLowerCase()}@example.com`,
    lfbAccountNo: p.accountNo,
    workPhone: p.workPhone,
    status: 'active',
    // Fictional birthdates start verified so the test staff can apply (D-82).
    dateOfBirth: { value: p.dob, verifiedAt: new Date() },
    personal: {
      maritalStatus: p.maritalStatus,
      dob: day(p.dob),
      nida: `${p.dob.replace(/-/g, '')}99${p.staffNo.slice(-3)}00000${p.staffNo.slice(-2)}`, // 20 digits, fictional
      nationality: 'Tanzania',
      mobile: p.mobile,
      address: p.address,
    },
    bank: { bank: 'Letshego Faidika Bank', branch: p.bankBranch, accountName: fullName(p), accountNo: p.accountNo },
    nextOfKin: p.nextOfKin,
    deductions: { medical: 0, other: 0 },
    otherLoans: [],
    existingLfbLoans: p.lfbLines.map((l) => ({ description: l.description, instalment: l.amount, outstanding: l.outstanding })),
    payDeclaredAt: new Date(),
  };
}

module.exports = { TEST_STAFF, TEST_STAFF_PREFIX, PAY_DATE, toStaffDoc, fullName };

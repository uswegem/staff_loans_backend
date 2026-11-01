'use strict';

// Sample people from the prototype seed (all fictional), plus a fictional Head of
// Operations who holds the Product Checker role (DECISIONS Q4).
// NIDA numbers follow the prototype's pattern; Rehema Ally starts with an
// incomplete profile for the guided journey.

const defaultsFor = (p) => {
  const last4 = p.staffNo.slice(-4);
  const last = p.staffNo.slice(-1);
  const dob = p.dob || '1985-01-01';
  return {
    personal: {
      maritalStatus: 'Married',
      dob,
      nida: `${dob.replace(/-/g, '')}1${last4}0000${last}2${last}`,
      nationality: 'Tanzanian',
      mobile: p.mobile || '+255 700 000 000',
      poBox: 'P.O. Box 34459, Dar es Salaam',
      residence: 'Dar es Salaam',
    },
    bank: { bank: 'Letshego Faidika Bank', branch: 'Head Office', accountName: p.name, accountNo: `4010 0000 ${last4}` },
    nextOfKin: [{ name: 'Next of kin', relationship: 'Sibling', phone: '+255 700 111 222', address: 'Dar es Salaam', employer: '' }],
    payDeclaredAt: new Date('2026-10-01T09:00:00+03:00'),
  };
};

const HO = 'Head Office, Dar es Salaam';

const PEOPLE = [
  {
    name: 'Neema Mushi', staffNo: 'LFB0412', roles: ['staff'], title: 'Customer Service Officer', department: 'Branch Network', station: 'Mwanza Branch',
    stationHead: { name: 'Ally Kitwana', phone: '+255 754 210 118' }, category: 'Non-management', joined: '2019-03-04', retirement: '2049-07-12',
    pay: { basic: 1850000, allowances: 220000 },
    profile: {
      personal: { maritalStatus: 'Married', dob: '1989-07-12', nida: '19890712141120000421', nationality: 'Tanzanian', mobile: '+255 713 448 902', homePhone: '', poBox: 'P.O. Box 1187, Mwanza', residence: 'Isamilo, Nyamagana' },
      workPhone: '+255 28 250 1190',
      bank: { bank: 'Letshego Faidika Bank', branch: 'Mwanza', accountName: 'Neema J. Mushi', accountNo: '4010 2283 1170' },
      nextOfKin: [{ name: 'Joseph Mushi', relationship: 'Spouse', phone: '+255 765 300 411', address: 'Isamilo, Mwanza', employer: 'TANESCO' }],
    },
  },
  { name: 'Juma Kassim', staffNo: 'LFB0233', roles: ['staff', 'credit_analyst'], title: 'Credit Analyst', department: 'Credit', station: HO, category: 'Non-management', joined: '2017-01-09', retirement: '2046-02-01', pay: { basic: 2900000, allowances: 300000 }, mobile: '+255 715 230 418' },
  { name: 'Grace Mollel', staffNo: 'LFB0051', roles: ['staff', 'head_pc'], title: 'Head of People and Culture', department: 'People and Culture', station: HO, category: 'Management', joined: '2014-05-12', retirement: '2041-09-30', pay: { basic: 7800000 }, mobile: '+255 754 051 220', dob: '1981-09-30' },
  { name: 'Upendo Massawe', staffNo: 'LFB0129', roles: ['staff', 'pc_manager'], title: 'People and Culture Manager', department: 'People and Culture', station: HO, category: 'Non-management', joined: '2016-02-15', retirement: '2047-05-09', pay: { basic: 4600000 }, mobile: '+255 754 129 330' },
  { name: 'Joseph Mwakalinga', staffNo: 'LFB0002', roles: ['staff', 'ceo'], title: 'Chief Executive Officer', department: 'Executive Office', station: HO, category: 'Management', joined: '2012-02-01', retirement: '2036-04-18', pay: { basic: 18500000 }, mobile: '+255 784 000 210', dob: '1976-04-18' },
  { name: 'Halima Said', staffNo: 'LFB0318', roles: ['staff', 'ops'], title: 'Operations Officer', department: 'Central Operations', station: HO, category: 'Non-management', joined: '2018-08-20', retirement: '2051-01-15', pay: { basic: 2300000 }, mobile: '+255 713 318 640' },
  { name: 'Peter Lyimo', staffNo: 'LFB0274', roles: ['staff', 'sys_admin'], title: 'Systems Administrator', department: 'IT and Cybersecurity', station: HO, category: 'Non-management', joined: '2017-11-01', retirement: '2050-06-03', pay: { basic: 3100000 }, mobile: '+255 767 274 115' },
  { name: 'Daniel Mrema', staffNo: 'LFB0067', roles: ['staff', 'risk_audit_viewer'], title: 'Head of Risk', department: 'Risk', station: HO, category: 'Management', joined: '2015-10-05', retirement: '2040-12-11', pay: { basic: 8200000 }, mobile: '+255 754 067 390', dob: '1980-12-11' },
  {
    name: 'Rehema Ally', staffNo: 'LFB0596', roles: ['staff'], title: 'Teller', department: 'Branch Network', station: 'Dodoma Branch', stationHead: { name: 'Faraji Nyoni', phone: '+255 787 021 554' },
    category: 'Non-management', joined: '2026-02-02', retirement: '2061-05-20', pay: { basic: 1100000, allowances: 120000 },
    profile: {
      personal: { nationality: 'Tanzanian', mobile: '+255 744 812 035' },
      bank: { bank: 'Letshego Faidika Bank', branch: 'Dodoma', accountName: 'Rehema Ally', accountNo: '' },
      nextOfKin: [],
      payDeclaredAt: null,
    },
  },
  { name: 'Faraji Nyoni', staffNo: 'LFB0188', roles: ['staff'], title: 'Branch Manager', department: 'Branch Network', station: 'Dodoma Branch', category: 'Non-management', joined: '2016-04-11', retirement: '2044-03-02', pay: { basic: 4200000 }, mobile: '+255 787 188 402' },
  { name: 'Aisha Kombo', staffNo: 'LFB0451', roles: ['staff'], title: 'Loan Officer', department: 'Business', station: 'Arusha Branch', category: 'Non-management', joined: '2020-06-15', retirement: '2055-10-09', pay: { basic: 1650000 }, mobile: '+255 744 451 009' },
  { name: 'Salma Hamisi', staffNo: 'LFB0377', roles: ['staff'], title: 'Senior Teller', department: 'Branch Network', station: 'Kariakoo Branch', category: 'Non-management', joined: '2019-09-02', retirement: '2052-08-21', pay: { basic: 1400000 }, mobile: '+255 713 377 562' },
  { name: 'Asha Mfinanga', staffNo: 'LFB0010', roles: ['staff', 'product_checker'], title: 'Head of Operations', department: 'Operations', station: HO, category: 'Management', joined: '2013-07-01', retirement: '2042-03-14', pay: { basic: 8000000 }, mobile: '+255 754 010 551', dob: '1982-03-14' },
];

function toStaffDoc(p) {
  const [firstName, ...rest] = p.name.split(' ');
  const base = defaultsFor(p);
  const profile = p.profile || {};
  // A person with their own profile keeps exactly that (Rehema Ally stays incomplete).
  const personal = { ...(profile.personal || base.personal) };
  const dob = personal.dob;
  personal.dob = dob ? new Date(`${dob}T00:00:00+03:00`) : undefined;
  return {
    staffNo: p.staffNo,
    firstName,
    lastName: rest.pop(),
    middleName: rest.join(' ') || undefined,
    title: p.title,
    department: p.department,
    station: p.station,
    stationHead: p.stationHead,
    category: p.category,
    employmentType: 'Permanent',
    dateJoined: new Date(`${p.joined}T00:00:00+03:00`),
    retirementDate: new Date(`${p.retirement}T00:00:00+03:00`),
    status: 'active',
    workPhone: profile.workPhone,
    personal,
    // Seeded birthdates (fictional) start verified so the samples can apply; real ones
    // go through People and Culture verification (D-82). Rehema Ally has none.
    dateOfBirth: dob ? { value: dob, verifiedAt: new Date() } : undefined,
    bank: profile.bank || base.bank,
    lfbAccountNo: (profile.bank || base.bank).accountNo || `4010 0000 ${p.staffNo.slice(-4)}`,
    nextOfKin: profile.nextOfKin || base.nextOfKin,
    deductions: { medical: 0, other: 0 },
    otherLoans: [],
    existingLfbLoans: [],
    payDeclaredAt: profile.payDeclaredAt === undefined ? base.payDeclaredAt : profile.payDeclaredAt,
  };
}

module.exports = { PEOPLE, toStaffDoc };

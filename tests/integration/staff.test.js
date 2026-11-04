'use strict';

// Staff records (FR-01 to FR-04) and Excel bulk upload (FR-02, D-100).

const XLSX = require('xlsx');
const { app, seed, signIn, authed, PASSWORD, request } = require('../helpers');
const Staff = require('../../src/models/Staff');
const Salary = require('../../src/models/Salary');
const AuditLog = require('../../src/models/AuditLog');
const DobChange = require('../../src/models/DobChange');
const User = require('../../src/models/User');
const RoleAssignment = require('../../src/models/RoleAssignment');
const { HEADERS } = require('../../src/services/staff/staffImportService');
const { applyBlockers } = require('../../src/services/staff/eligibilityService');
const { localDay } = require('../../src/utils/dates');

let grace;
const api = (token) => ({
  get: (url) => request(app()).get(`/api/v1${url}`).set(authed(token)),
  post: (url, body = {}) => request(app()).post(`/api/v1${url}`).set(authed(token)).send(body),
  patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(authed(token)).send(body),
});
const idOf = async (staffNo) => String((await Staff.findOne({ staffNo }))._id);

const newStaff = {
  staffNo: 'LFB0700',
  firstName: 'Baraka',
  lastName: 'Mwakyusa',
  title: 'Teller',
  department: 'Branch Network',
  station: 'Mbeya Branch',
  category: 'Non-management',
  employmentType: 'Permanent',
  dateJoined: '2026-03-02',
  lineManagerStaffNo: 'LFB0188',
  lfbAccountNo: '4010 3341 0700',
};

beforeEach(async () => {
  await seed();
  grace = await signIn('LFB0051'); // Head of People and Culture: staff.manage
});

describe('staff records (FR-01)', () => {
  it('lists staff with profile completeness and no salary (D-100)', async () => {
    const res = await api(grace.token).get('/staff?q=rehema');
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ staffNo: 'LFB0596', profile: { complete: false }, signIn: 'active' });
    expect(res.body.data.items[0]).not.toHaveProperty('basic');
  });

  it('opening a record is audited (NFR-05)', async () => {
    await api(grace.token).get(`/staff/${await idOf('LFB0412')}`);
    expect(await AuditLog.countDocuments({ action: 'staff.view' })).toBe(1);
  });

  it('shows the probation end and the retirement date worked out, never entered (D-100)', async () => {
    const neema = (await api(grace.token).get(`/staff/${await idOf('LFB0412')}`)).body.data;
    // Date joined 2019-03-04 + 6 months; verified date of birth 1989-07-12 + 60 years.
    expect(neema.probation).toEqual({ onProbation: false, endsOn: '2019-09-04', months: 6 });
    expect(neema.retirement).toEqual({ date: '2049-07-12', age: 60 });
    expect(neema).not.toHaveProperty('probationEndDate');
    expect(neema).not.toHaveProperty('salary');
    expect(neema).not.toHaveProperty('salaries');
    // No verified date of birth: no retirement date.
    expect((await api(grace.token).get(`/staff/${await idOf('LFB0596')}`)).body.data.retirement).toEqual({ date: null, age: 60 });
  });

  it('a probation end date sent, or stored earlier, changes nothing and is kept (D-100)', async () => {
    const id = await idOf('LFB0596');
    await Staff.collection.updateOne({ staffNo: 'LFB0596' }, { $set: { probationEndDate: new Date('2099-01-01T00:00:00+03:00') } });
    const before = (await api(grace.token).get(`/staff/${id}`)).body.data.probation;
    expect(before.endsOn).not.toBe('2099-01-01');
    const res = await api(grace.token).patch(`/staff/${id}`, { probationEndDate: '2030-01-01', title: 'Senior Teller' });
    expect(res.status).toBe(200);
    expect(res.body.data.probation).toEqual(before);
    expect(localDay((await Staff.findById(id).lean()).probationEndDate)).toBe('2099-01-01');
  });

  it('adds a staff member with no salary and a pre-filled LFB account', async () => {
    const res = await api(grace.token).post('/staff', { ...newStaff, salary: { basic: 1150000, effectiveFrom: '2026-03-02' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ staffNo: 'LFB0700', lineManager: { staffNo: 'LFB0188' }, signIn: null });
    expect(res.body.data).not.toHaveProperty('salary');
    expect(res.body.data.profile.bank.accountNo).toBe('4010 3341 0700');
    expect(await Salary.countDocuments({ staffId: res.body.data.id })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'staff.create' })).toBe(1);
  });

  it('checks dates and contract rules', async () => {
    // D-98: the retirement date is not entered; one sent anyway is ignored.
    const r1 = await api(grace.token).post('/staff', { ...newStaff, staffNo: 'LFB0701', retirementDate: '2025-01-01' });
    expect(r1.status).toBe(201);
    expect(r1.body.data).not.toHaveProperty('retirementDate');
    expect((await Staff.findOne({ staffNo: 'LFB0701' }).lean()).retirementDate).toBeUndefined();
    const r2 = await api(grace.token).post('/staff', { ...newStaff, employmentType: 'Contract' });
    expect(r2.body.details.contractEndDate).toBeDefined();
    const r3 = await api(grace.token).post('/staff', { ...newStaff, staffNo: 'LFB0412' });
    expect(r3.status).toBe(409);
  });

  it('records the category change with before and after', async () => {
    const id = await idOf('LFB0188');
    await api(grace.token).patch(`/staff/${id}`, { category: 'Management', title: 'Head of Business' });
    const entry = await AuditLog.findOne({ action: 'staff.update' });
    expect(entry.before.category).toBe('Non-management');
    expect(entry.after.category).toBe('Management');
  });

  it('records no salaries any more, and keeps the earlier ones as history (D-100)', async () => {
    const id = await idOf('LFB0412');
    await Salary.create({ staffId: id, basic: 1850000, allowances: 220000, effectiveFrom: new Date('2026-01-01T00:00:00+03:00'), source: 'manual' });
    expect((await api(grace.token).post(`/staff/${id}/salaries`, { basic: 1950000, effectiveFrom: '2026-12-01' })).status).toBe(404);
    await api(grace.token).patch(`/staff/${id}`, { title: 'Senior Customer Service Officer' });
    expect((await Salary.find({ staffId: id })).map((x) => x.basic)).toEqual([1850000]);
  });

  it('an exited staff member is signed out and cannot sign in (FR-04)', async () => {
    const neema = await signIn('LFB0412');
    const id = await idOf('LFB0412');
    const res = await api(grace.token).post(`/staff/${id}/status`, { status: 'exited', exitDate: '2026-10-29', reason: 'Resigned' });
    expect(res.body.data.status).toBe('exited');
    expect((await api(neema.token).get('/auth/me')).status).toBe(401);
    expect((await request(app()).post('/api/v1/auth/login').send({ staffNo: 'LFB0412', password: PASSWORD })).status).toBe(403);
    // The record stays visible to People and Culture.
    expect((await api(grace.token).get(`/staff/${id}`)).body.data.status).toBe('exited');
  });

  it('the People and Culture Manager can view but not change', async () => {
    const upendo = await signIn('LFB0129');
    expect((await api(upendo.token).get('/staff')).status).toBe(200);
    expect((await api(upendo.token).post('/staff', newStaff)).status).toBe(403);
  });

  it('staff cannot open staff records', async () => {
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).get('/staff')).status).toBe(403);
  });
});

describe('Excel bulk upload (FR-02, D-100)', () => {
  const sheet = (rows, headers = HEADERS) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Staff records');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const row = (o) => HEADERS.map((h) => o[h] ?? '');
  const upload = (buffer, name = 'Staff_records_Nov_2026.xlsx') => request(app()).post('/api/v1/staff/import').set(authed(grace.token)).attach('file', buffer, name);
  const commit = (id) => api(grace.token).post(`/staff/import/${id}/commit`);
  const BARAKA = { 'Staff Number/Code': 'LFB0612', 'First name': 'Baraka', Surname: 'Mwakyusa', NIDA: '19900514123450000123', Title: 'Teller', 'Date of Birth': '14/05/1990', 'Date Joined': '03/09/2026', Category: 'Non-management' };

  const sample = () =>
    sheet([
      // Only the title: every blank cell keeps what is on file.
      row({ 'Staff Number/Code': 'LFB0412', Title: 'Senior Customer Service Officer' }),
      row(BARAKA),
      row({ 'Staff Number/Code': 'LFB0188', Title: 'Branch Manager', Category: 'Non-management' }),
      row({ 'Staff Number/Code': '06-LFB2', 'First name': 'Zawadi', Surname: 'Said', NIDA: '123', Title: 'Loan Officer', 'Date of Birth': '01/01/1995', 'Date Joined': '01/12/2025', Category: 'Officer' }),
      row({ 'Staff Number/Code': 'LFB0613', 'First name': 'Imani', Surname: 'Komba', Title: 'Head of Finance', 'Date Joined': '17/08/2026', Category: 'Management' }),
    ]);

  it('downloads the template with the eight columns and an Instructions sheet', async () => {
    const res = await api(grace.token).get('/staff/import/template').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    expect(wb.SheetNames).toContain('Instructions');
    expect(XLSX.utils.sheet_to_json(wb.Sheets['Staff records'], { header: 1 })[0]).toEqual(['First name', 'Surname', 'NIDA', 'Title', 'Staff Number/Code', 'Date of Birth', 'Date Joined', 'Category']);
  });

  it('checks every row and shows new, updated, unchanged and error rows', async () => {
    const res = await upload(sample());
    expect(res.status).toBe(201);
    expect(res.body.data.summary).toEqual({ new: 1, update: 1, unchanged: 1, error: 2 });
    const byNo = Object.fromEntries(res.body.data.rows.map((r) => [r.staffNo, r]));
    expect(byNo.LFB0412).toMatchObject({ outcome: 'update', changes: ['title'] });
    expect(byNo.LFB0612.changes.join()).toMatch(/date of birth 1990-05-14 sent for verification/);
    expect(byNo.LFB0188.outcome).toBe('unchanged');
    expect(byNo['06-LFB2'].problems).toEqual(
      expect.arrayContaining([
        'Staff Number/Code must be the employee code on the payslip, for example AT637',
        'Category must be Management or Non-management',
        'NIDA: Enter the 20-digit NIDA number, for example 19800630-13140-00004-20.',
      ])
    );
    expect(byNo.LFB0613.problems).toEqual(['NIDA is required', 'Date of Birth is required']);
    // Nothing has changed yet.
    expect(await Staff.exists({ staffNo: 'LFB0612' })).toBeNull();
  });

  it('checks the date of birth and the NIDA number', async () => {
    const neemaNida = (await Staff.findOne({ staffNo: 'LFB0412' }).lean()).personal.nida;
    const res = await upload(
      sheet([
        row({ ...BARAKA, 'Date of Birth': '31/02/1990' }),
        row({ ...BARAKA, 'Staff Number/Code': 'LFB0614', 'Date of Birth': '01/01/2020', NIDA: '19800630131400000420' }),
        row({ ...BARAKA, 'Staff Number/Code': 'LFB0615', NIDA: neemaNida }),
        row({ 'Staff Number/Code': 'LFB0412', 'Date of Birth': '12/07/1989' }), // the verified date: no change
        row({ 'Staff Number/Code': 'LFB0188', 'Date of Birth': '01/02/1975' }),
      ])
    );
    const [bad, young, taken, same, changed] = res.body.data.rows;
    expect(bad.problems).toContain('Date of Birth is not a date');
    expect(young.problems.join()).toMatch(/^Date of Birth: This date of birth gives an age of \d+\. It must be between 18 and/);
    expect(taken.problems).toContain(`NIDA ${neemaNida} is already on file for LFB0412`);
    expect(same.outcome).toBe('unchanged');
    expect(changed).toMatchObject({ outcome: 'update', changes: ['date of birth 1975-02-01 sent for verification'] });
  });

  it('downloads the error rows as Excel in the template columns, to fix and upload again', async () => {
    const up = await upload(sample());
    const res = await api(grace.token).get(`/staff/import/${up.body.data.id}/errors.xlsx`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const rows = XLSX.utils.sheet_to_json(XLSX.read(res.body, { type: 'buffer' }).Sheets['Staff records'], { header: 1, defval: '' });
    expect(rows[0]).toEqual([...HEADERS, 'Errors', 'Row in your file']);
    expect(rows).toHaveLength(3);
    const at = (h) => HEADERS.indexOf(h);
    expect(rows[1][at('Staff Number/Code')]).toBe('06-LFB2');
    // Fix Imani's row and upload the error file again.
    const fixed = rows.slice(1).filter((r) => r[at('Staff Number/Code')] === 'LFB0613').map((r) => r.slice(0, HEADERS.length));
    fixed[0][at('NIDA')] = '19850301-22222-00003-23';
    fixed[0][at('Date of Birth')] = '01/03/1985';
    const again = await upload(sheet(fixed), 'errors_fixed.xlsx');
    expect(again.body.data.summary).toMatchObject({ new: 1, error: 0 });
  });

  it('applies valid rows only, in one go, sends dates of birth for verification and touches nothing else', async () => {
    const neemaBefore = await Staff.findOne({ staffNo: 'LFB0412' }).lean();
    await Salary.create({ staffId: neemaBefore._id, basic: 1850000, effectiveFrom: new Date('2026-01-01T00:00:00+03:00'), source: 'manual' });
    const up = await upload(sample());
    const res = await commit(up.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ created: 1, updated: 1, skipped: 3, datesOfBirth: 1 });

    const baraka = await Staff.findOne({ staffNo: 'LFB0612' }).lean();
    expect(baraka).toMatchObject({ firstName: 'Baraka', lastName: 'Mwakyusa', title: 'Teller', category: 'Non-management', personal: { nida: '19900514-12345-00001-23' } });
    expect(localDay(baraka.dateJoined)).toBe('2026-09-03');
    expect(baraka.employmentType).toBeUndefined();
    // D-82: waiting for verification, not in force.
    expect(baraka.dateOfBirth.value).toBeUndefined();
    expect(baraka.dateOfBirth.pending.proposed).toBe('1990-05-14');
    const change = await DobChange.findOne({ staffId: baraka._id }).lean();
    expect(change).toMatchObject({ status: 'pending', source: 'staff_upload', submittedBy: (await User.findOne({ staffNo: 'LFB0051' }))._id });
    // Only the verification stands between Baraka's record and applying: no employment type or salary is needed.
    expect(applyBlockers(baraka)).toEqual(['Your date of birth (1990-05-14) is waiting for People and Culture to verify it. You can apply once it is verified.']);

    // Neema: only the title changed; everything else, including what the template does not hold, is as it was.
    const neema = await Staff.findOne({ staffNo: 'LFB0412' }).lean();
    expect(neema.title).toBe('Senior Customer Service Officer');
    ['department', 'station', 'employmentType', 'lfbAccountNo', 'category', 'firstName', 'lastName', 'personal', 'dateJoined'].forEach((k) => expect(neema[k]).toEqual(neemaBefore[k]));
    expect(neema.dateOfBirth.value).toBe('1989-07-12');
    // The salary history is kept and nothing is added (D-100).
    expect(await Salary.countDocuments({})).toBe(1);

    expect(await AuditLog.countDocuments({ action: 'staff.import_commit' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: { $in: ['staff.create', 'staff.update'] } })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'dob.submit' })).toBe(1);
    // A committed upload cannot be applied twice.
    expect((await commit(up.body.data.id)).status).toBe(409);
  });

  it('the uploader cannot verify an uploaded date of birth; another verifier can', async () => {
    const up = await upload(sheet([row(BARAKA)]));
    await commit(up.body.data.id);
    const change = await DobChange.findOne({ status: 'pending', source: 'staff_upload' }).lean();
    const mine = await api(grace.token).post(`/dob-verifications/${change._id}/approve`);
    expect(mine.status).toBe(403);
    expect(mine.body.code).toBe('SOD_SELF_VERIFY');
    const upendo = await signIn('LFB0129');
    expect((await api(upendo.token).post(`/dob-verifications/${change._id}/approve`)).status).toBe(200);
    expect((await Staff.findOne({ staffNo: 'LFB0612' }).lean()).dateOfBirth.value).toBe('1990-05-14');
  });

  it('a different date of birth already waiting stops the row; the same one changes nothing', async () => {
    const up = await upload(sheet([row({ 'Staff Number/Code': 'LFB0188', 'Date of Birth': '01/02/1975' })]));
    await commit(up.body.data.id);
    const again = await upload(sheet([row({ 'Staff Number/Code': 'LFB0188', 'Date of Birth': '02/02/1975' })]));
    expect(again.body.data.rows[0].problems).toEqual(['A different date of birth (1975-02-01) is already waiting for verification. Decide or withdraw it first, or leave Date of Birth blank']);
    const same = await upload(sheet([row({ 'Staff Number/Code': 'LFB0188', 'Date of Birth': '01/02/1975' })]));
    expect(same.body.data.rows[0].outcome).toBe('unchanged');
  });

  it('never assigns roles from the title', async () => {
    const before = await RoleAssignment.countDocuments({});
    const up = await upload(sheet([row({ ...BARAKA, Title: 'Credit Analyst' }), row({ 'Staff Number/Code': 'LFB0412', Title: 'Chief Executive Officer' })]));
    expect((await commit(up.body.data.id)).body.data.result).toMatchObject({ created: 1, updated: 1 });
    expect(await RoleAssignment.countDocuments({})).toBe(before);
    expect(await User.exists({ staffNo: 'LFB0612' })).toBeNull();
  });

  it('accepts CSV, ignores columns that are not in the template, and refuses other file types', async () => {
    const csv = Buffer.from('Staff Number/Code,Basic salary (TZS),Probation end date,Active\nLFB0188,9999999,01/01/2030,No\n');
    const res = await upload(csv, 'staff.csv');
    expect(res.body.data.summary.unchanged).toBe(1);
    const bad = await upload(Buffer.from('%PDF-1.4'), 'staff.pdf');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('FILE_TYPE');
  });

  it('refuses an unreadable workbook', async () => {
    const res = await upload(Buffer.from('not a spreadsheet at all'), 'staff.xlsx');
    expect(res.status).toBe(400);
  });
});

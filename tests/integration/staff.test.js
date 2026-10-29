'use strict';

// Staff records (FR-01 to FR-04) and Excel bulk upload (FR-02).

const XLSX = require('xlsx');
const { app, seed, signIn, authed, PASSWORD, request } = require('../helpers');
const Staff = require('../../src/models/Staff');
const Salary = require('../../src/models/Salary');
const AuditLog = require('../../src/models/AuditLog');
const { HEADERS } = require('../../src/services/staff/staffImportService');

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
  retirementDate: '2062-02-14',
  lineManagerStaffNo: 'LFB0188',
  lfbAccountNo: '4010 3341 0700',
  salary: { basic: 1150000, allowances: 100000, effectiveFrom: '2026-03-02' },
};

beforeEach(async () => {
  await seed();
  grace = await signIn('LFB0051'); // Head of People and Culture: staff.manage
});

describe('staff records (FR-01)', () => {
  it('lists staff with salary in force and profile completeness', async () => {
    const res = await api(grace.token).get('/staff?q=rehema');
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ staffNo: 'LFB0596', basic: 1100000, profile: { complete: false }, signIn: 'active' });
  });

  it('opening a record is audited (NFR-05)', async () => {
    await api(grace.token).get(`/staff/${await idOf('LFB0412')}`);
    expect(await AuditLog.countDocuments({ action: 'staff.view' })).toBe(1);
  });

  it('adds a staff member with the first salary and a pre-filled LFB account', async () => {
    const res = await api(grace.token).post('/staff', newStaff);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ staffNo: 'LFB0700', lineManager: { staffNo: 'LFB0188' }, salary: { basic: 1150000 }, signIn: null });
    expect(res.body.data.profile.bank.accountNo).toBe('4010 3341 0700');
    expect(await AuditLog.countDocuments({ action: 'staff.create' })).toBe(1);
  });

  it('checks dates and contract rules', async () => {
    const r1 = await api(grace.token).post('/staff', { ...newStaff, retirementDate: '2025-01-01' });
    expect(r1.body.details.retirementDate).toBeDefined();
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

  it('keeps salary history effective-dated (FR-03)', async () => {
    const id = await idOf('LFB0412');
    const res = await api(grace.token).post(`/staff/${id}/salaries`, { basic: 1950000, allowances: 220000, effectiveFrom: '2026-12-01' });
    expect(res.status).toBe(201);
    expect(res.body.data.salaries.map((s) => s.basic)).toEqual([1950000, 1850000]);
    expect(res.body.data.salary.basic).toBe(1850000); // still in force today
    const atDec = await Salary.inForce(id, new Date('2026-12-15T00:00:00+03:00'));
    expect(atDec.basic).toBe(1950000);
    expect((await api(grace.token).post(`/staff/${id}/salaries`, { basic: 1, effectiveFrom: '2026-12-01' })).status).toBe(409);
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

describe('Excel bulk upload (FR-02)', () => {
  const sheet = (rows) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'Staff records');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const row = (o) => HEADERS.map((h) => o[h] ?? '');
  const upload = (buffer, name = 'Staff_records_Nov_2026.xlsx') => request(app()).post('/api/v1/staff/import').set(authed(grace.token)).attach('file', buffer, name);

  // The prototype's sample upload, adapted to SLAS columns.
  const sample = () =>
    sheet([
      row({ 'Staff number': 'LFB0412', 'Basic salary (TZS)': '1,950,000', 'Salary effective from': '01/11/2026' }),
      row({ 'Staff number': 'LFB0612', 'First name': 'Baraka', 'Last name': 'Mwakyusa', 'Job title': 'Teller', 'Department': 'Branch Network', 'Work station': 'Mbeya Branch', 'Line manager staff number': 'LFB0613', 'Category': 'Non-management', 'Employment type': 'Probation', 'Date joined': '03/09/2026', 'Retirement date': '14/02/2062', 'Basic salary (TZS)': 1150000, 'Allowances (TZS)': 100000 }),
      row({ 'Staff number': 'LFB0188', 'Job title': 'Branch Manager', 'Category': 'Non-management' }),
      row({ 'Staff number': 'LFB06O2', 'First name': 'Zawadi', 'Last name': 'Said', 'Job title': 'Loan Officer', 'Work station': 'Tanga Branch', 'Category': 'Officer', 'Employment type': 'Permanent', 'Date joined': '01/12/2025', 'Retirement date': '01/12/2020' }),
      row({ 'Staff number': 'LFB0613', 'First name': 'Imani', 'Last name': 'Komba', 'Job title': 'Head of Finance', 'Work station': 'Head Office', 'Category': 'Management', 'Employment type': 'Contract', 'Date joined': '17/08/2026', 'Retirement date': '30/06/2050', 'Basic salary (TZS)': 9800000, 'Allowances (TZS)': 900000 }),
    ]);

  it('downloads the template with an Instructions sheet', async () => {
    const res = await api(grace.token).get('/staff/import/template').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(XLSX.read(res.body, { type: 'buffer' }).SheetNames).toContain('Instructions');
  });

  it('checks every row and shows new, updated, unchanged and error rows', async () => {
    const res = await upload(sample());
    expect(res.status).toBe(201);
    expect(res.body.data.summary).toEqual({ new: 1, update: 1, unchanged: 1, error: 2 });
    const byNo = Object.fromEntries(res.body.data.rows.map((r) => [r.staffNo, r]));
    expect(byNo.LFB0412.outcome).toBe('update');
    expect(byNo.LFB0412.changes.join()).toMatch(/basic 1,850,000 → 1,950,000/);
    expect(byNo.LFB0188.outcome).toBe('unchanged');
    expect(byNo.LFB06O2.problems).toEqual(expect.arrayContaining(['Staff number must be LFB followed by 4 digits', 'Category must be Management or Non-management', 'Retirement date must be after the date joined']));
    expect(byNo.LFB0613.problems).toContain('Contract end date is required for contract staff');
    // Nothing has changed yet.
    expect(await Staff.exists({ staffNo: 'LFB0612' })).toBeNull();
  });

  it('a line manager in the same file is accepted', async () => {
    const res = await upload(sample());
    expect(res.body.data.rows.find((r) => r.staffNo === 'LFB0612').outcome).toBe('new');
  });

  it('downloads the error rows as Excel to fix and upload again', async () => {
    const up = await upload(sample());
    const res = await api(grace.token).get(`/staff/import/${up.body.data.id}/errors.xlsx`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const rows = XLSX.utils.sheet_to_json(XLSX.read(res.body, { type: 'buffer' }).Sheets['Staff records'], { header: 1 });
    expect(rows[0].slice(-2)).toEqual(['Errors', 'Row in your file']);
    expect(rows).toHaveLength(3);
    expect(rows[1][0]).toBe('LFB06O2');
    // Fix the contract row and upload the error file again.
    const fixed = rows.slice(1).filter((r) => r[0] === 'LFB0613').map((r) => r.slice(0, HEADERS.length));
    fixed[0][HEADERS.indexOf('Contract end date')] = '30/06/2028';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([rows[0], ...fixed]), 'Staff records');
    const again = await upload(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'errors_fixed.xlsx');
    expect(again.body.data.summary).toMatchObject({ new: 1, error: 0 });
  });

  it('applies valid rows only, in one go, with salary history and audit', async () => {
    const up = await upload(sample());
    const res = await api(grace.token).post(`/staff/import/${up.body.data.id}/commit`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ created: 1, updated: 1, skipped: 3 });
    const baraka = await Staff.findOne({ staffNo: 'LFB0612' });
    expect(baraka.employmentType).toBe('Probation');
    const neema = await Staff.findOne({ staffNo: 'LFB0412' });
    expect((await Salary.find({ staffId: neema._id })).map((s) => s.basic).sort()).toEqual([1850000, 1950000]);
    expect(await AuditLog.countDocuments({ action: 'staff.import_commit' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: { $in: ['staff.create', 'staff.update'] } })).toBe(2);
    // A committed upload cannot be applied twice.
    expect((await api(grace.token).post(`/staff/import/${up.body.data.id}/commit`)).status).toBe(409);
  });

  it('accepts CSV and refuses other file types', async () => {
    const csv = Buffer.from(`${HEADERS.slice(0, 1).join(',')}\nLFB0188\n`);
    expect((await upload(csv, 'staff.csv')).body.data.summary.unchanged).toBe(1);
    const bad = await upload(Buffer.from('%PDF-1.4'), 'staff.pdf');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('FILE_TYPE');
  });

  it('refuses an unreadable workbook', async () => {
    const res = await upload(Buffer.from('not a spreadsheet at all'), 'staff.xlsx');
    expect(res.status).toBe(400);
  });

  it('setting Active to No deactivates and signs out', async () => {
    const neema = await signIn('LFB0412');
    const up = await upload(sheet([row({ 'Staff number': 'LFB0412', Active: 'No' })]));
    expect(up.body.data.rows[0].changes).toContain('set inactive');
    await api(grace.token).post(`/staff/import/${up.body.data.id}/commit`);
    expect((await api(neema.token).get('/auth/me')).status).toBe(401);
  });
});

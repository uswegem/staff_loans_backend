'use strict';

// Staff records bulk upload (FR-02, D-100). The file is parsed on the server only
// (DECISIONS D-14). Every row is checked against the rules and the current records before
// anything changes; People and Culture see new, updated, unchanged and error rows and
// confirm. Staff are matched by staff number. Blank cells keep the existing value for
// staff already on file, and fields that are not in the template are never touched.
//
// D-100: the template has eight columns. No salary (affordability comes from the payslip
// attached to each application), no probation end date (worked out from the date joined)
// and no retirement date (worked out from the verified date of birth). A date of birth
// goes to People and Culture's verification queue (D-82): the uploader cannot verify it.
// Titles are stored as text; the upload never assigns roles.

const XLSX = require('xlsx');
const { STAFF_NO } = require('../../constants/staffNo');
const Staff = require('../../models/Staff');
const Settings = require('../../models/Settings');
const { localDay, localMidnight } = require('../../utils/dates');
const { normaliseNida, NIDA_MESSAGE } = require('../../utils/formats');
const { problemWith } = require('./dobService');

const MAX_ROWS = 5000;

// [key, header, instruction shown to People and Culture]. Every column is required for
// new staff; for staff already on file a blank cell keeps what is on file.
const COLUMNS = Object.freeze([
  ['firstName', 'First name', 'Required.'],
  ['userName', 'Username', 'Required for new staff; unique login identifier.'],
  ['gender', 'Gender', 'Optional: Male or Female.'],
  ['department', 'Department', 'Optional.'],
  ['email', 'Email', 'Optional.'],
  ['lastName', 'Surname', 'Required.'],
  ['nida', 'NIDA', 'Required. Used by Credit for CRB checks. Format 19800630-13140-00004-20.'],
  ['title', 'Title', 'Required. Used for assigning roles and permissions.'],
  ['staffNo', 'Staff Number/Code', 'Required. Used to authenticate staff against the payslip uploaded during a loan application.'],
  ['dob', 'Date of Birth', 'Required. Used to work out the retirement date for affordability.'],
  ['dateJoined', 'Date Joined', 'Required. Used to confirm that probation has been completed.'],
  ['category', 'Category', 'Required. Management or Non-management. Decides the approval route.'],
]);

const HEADERS = COLUMNS.map((c) => c[1]);
const norm = (h) => String(h).toLowerCase().replace(/[^a-z]/g, '');
// Headings from earlier templates still find their column; any other column is ignored.
const ALIASES = { username: 'userName', firstname: 'firstName', staffnumbercode: 'staffNo',  staffnumber: 'staffNo', staffno: 'staffNo', staffcode: 'staffNo', employeecode: 'staffNo', lastname: 'lastName', jobtitle: 'title', nidanumber: 'nida', dateofbirth: 'dob', dob: 'dob' };
const HEADER_MAP = { ...ALIASES, ...Object.fromEntries(COLUMNS.map(([k, h]) => [norm(h), k])) };
const label = (k) => COLUMNS.find((c) => c[0] === k)[1];

// ---------- template and error file ----------

function templateWorkbook() {
  const wb = XLSX.utils.book_new();
  // Built by column so the example always lines up with the headings. Fictional person.
  const sample = { userName: 'baraka.mwakyusa', gender: 'Male', department: 'Branch Network', email: 'baraka@example.test', firstName: 'Baraka', lastName: 'Mwakyusa', nida: '19900514-12345-00001-23', title: 'Teller', staffNo: 'AT901', dob: '14/05/1990', dateJoined: '03/11/2026', category: 'Non-management' };
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, COLUMNS.map(([k]) => sample[k] ?? '')]);
  ws['!cols'] = HEADERS.map((h) => ({ wch: Math.max(16, h.length + 4) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Staff records');
  const ins = XLSX.utils.aoa_to_sheet([
    ['Column', 'What to enter'],
    ...COLUMNS.map((c) => [c[1], c[2]]),
    [],
    ['How it works', 'One row per staff member, matched by Staff Number/Code. New staff numbers are added with an incomplete profile, which the staff member completes. For staff already on file a blank cell keeps what is on file, and details that are not in this template are not changed. Rows are checked first and nothing changes until you confirm. Delete the example row before uploading.'],
    ['Date of Birth', "Sent to People and Culture's date of birth verification queue. It is used for loans only after another verifier approves it; you cannot verify a date you uploaded."],
    ['Title', 'Stored on the staff record. Uploading does not give anyone a role: a System Administrator assigns roles in Users and roles.'],
    ['Sign-in', 'Uploading a staff record does not create a sign-in. A System Administrator adds it in Users and roles. Username is unique and is used for login, while staff number remains the payroll identifier.'],
    ['Dates', 'Use day/month/year (15/01/2024), year-month-day (2024-01-15) or an Excel date.'],
    ['Not in this file', 'Salary: affordability comes from the payslip attached to each loan application. Probation end date: worked out as Date Joined plus the probation period in the settings. Retirement date: worked out from the verified date of birth.'],
  ]);
  ins['!cols'] = [{ wch: 22 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, ins, 'Instructions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Category'], ['Management'], ['Non-management']]), 'Lists');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function errorWorkbook(rows) {
  const data = rows.map((r) => [...COLUMNS.map(([k]) => (r.raw?.[k] ?? '')), r.problems.join('; '), r.rowNo]);
  const ws = XLSX.utils.aoa_to_sheet([[...HEADERS, 'Errors', 'Row in your file'], ...data]);
  ws['!cols'] = [...HEADERS.map((h) => ({ wch: Math.max(16, h.length + 4) })), { wch: 80 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Staff records');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------- parsing ----------

class ImportFileError extends Error {}

/** Reads the first sheet named "Staff records", or the first sheet. Returns [{ rowNo, raw }]. */
function parseFile(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: false, cellHTML: false, sheetRows: MAX_ROWS + 2, dense: true });
  } catch {
    throw new ImportFileError('This file could not be read. Save it as .xlsx, .xls or .csv from the template.');
  }
  const ws = wb.Sheets['Staff records'] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new ImportFileError('The file has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
  if (!aoa.length) throw new ImportFileError('The sheet is empty.');
  const headerIndex = aoa.findIndex((row) => row.some((h) => ['staffNo', 'firstName', 'userName'].includes(HEADER_MAP[norm(h)])));
  if (headerIndex < 0) throw new ImportFileError('No recognizable staff header row found.');
  const keys = aoa[headerIndex].map((h) => HEADER_MAP[norm(h)] || null);
  if (!keys.includes('staffNo')) throw new ImportFileError('There is no "Staff Number/Code" column. Use the Excel template.');
  const body = aoa.slice(headerIndex + 1);
  if (body.length > MAX_ROWS) throw new ImportFileError(`The file has more than ${MAX_ROWS.toLocaleString('en-US')} rows. Split it into smaller files.`);
  return body
    .map((cells, i) => {
      const raw = {};
      keys.forEach((k, j) => {
        if (k) raw[k] = typeof cells[j] === 'string' ? cells[j].trim() : cells[j];
      });
      return { rowNo: i + headerIndex + 2, raw };
    })
    .filter((r) => Object.values(r.raw).some((v) => String(v ?? '').trim() !== ''));
}

// ---------- cell values ----------

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const text = (v) => (blank(v) ? null : String(v).trim());

/** 'YYYY-MM-DD', null when blank, or 'bad'. */
function cellDate(v) {
  if (blank(v)) return null;
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    if (!p || p.y < 1900) return 'bad';
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
  const t = String(v).trim();
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  let y;
  let mo;
  let d;
  if (m) [, d, mo, y] = m;
  else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, mo, d] = m;
  else return 'bad';
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) return 'bad';
  return date.toISOString().slice(0, 10);
}

function cellCategory(v) {
  if (blank(v)) return null;
  const t = String(v).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (t === 'management') return 'Management';
  if (['non-management', 'nonmanagement'].includes(t)) return 'Non-management';
  return undefined;
}

/** NIDA as stored (D-93), null when blank, or 'bad'. A number cell loses no digits: 20 digits do not fit a number. */
function cellNida(v) {
  if (blank(v)) return null;
  return normaliseNida(String(v)) || 'bad';
}

const dayOf = (date) => (date ? localDay(date) : null);
const asDate = (day) => (day ? localMidnight(day) : null);

// ---------- row checks ----------

/**
 * Checks one row against the current record (if any). Returns
 * { outcome, problems, changes, name, staffNo, record, nida, dob } where record holds the
 * HR fields to store, nida the NIDA number to store (or null to keep) and dob a date of
 * birth to send for verification (or null).
 */
function checkRow(raw, { existing, seenStaffNos, seenNidas, seenUserNames, userNameOwners, nidaOwners, settings, today }) {
  const problems = [];
  const staffNo = (text(raw.staffNo) || '').toUpperCase();
  if (!staffNo) problems.push('Staff Number/Code is missing');
  else if (!STAFF_NO.test(staffNo)) problems.push('Staff Number/Code must be the employee code on the payslip, for example AT637');
  else if (seenStaffNos.has(staffNo)) problems.push(`Staff Number/Code repeats row ${seenStaffNos.get(staffNo)}`);

  const ex = existing || {};
  const isNew = !existing;
  const pick = (k, current) => (blank(raw[k]) ? current : text(raw[k]));
  const rec = { firstName: pick('firstName', ex.firstName), lastName: pick('lastName', ex.lastName), title: pick('title', ex.title), department: pick('department', ex.department), email: pick('email', ex.email), gender: pick('gender', ex.gender) };
  const userName = (text(raw.userName) || ex.userName || '').toLowerCase();
  if (!userName) problems.push('Username is required');
  else if (!/^[a-z][a-z0-9._-]{2,63}$/.test(userName)) problems.push('Username must contain 3–64 letters, numbers, dots, underscores or hyphens, starting with a letter');
  else if (seenUserNames.has(userName)) problems.push(`Username repeats row ${seenUserNames.get(userName)}`);
  else if (userNameOwners.has(userName) && userNameOwners.get(userName) !== staffNo) problems.push('Username already belongs to another staff member');
  rec.userName = userName;
  if (rec.gender && !['Male', 'Female'].includes(rec.gender)) problems.push('Gender must be Male or Female');
  if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) problems.push('Email is not valid');
  ['firstName', 'lastName'].forEach((k) => {
    if (!rec[k]) problems.push(`${label(k)} is required`);
  });

  const cat = cellCategory(raw.category);
  if (cat === undefined) problems.push('Category must be Management or Non-management');
  rec.category = cat || ex.category;
  if (!rec.category && cat !== undefined) problems.push('Category is required');

  const joined = cellDate(raw.dateJoined);
  if (joined === 'bad') problems.push('Date Joined is not a date');
  const dateJoined = joined && joined !== 'bad' ? joined : dayOf(ex.dateJoined);

  if (dateJoined && dateJoined > today) problems.push('Date Joined cannot be in the future');
  rec.dateJoined = asDate(dateJoined);

  // NIDA (D-93): stored in the standard format; one person's number only.
  const nidaCell = cellNida(raw.nida);
  if (nidaCell === 'bad') problems.push(`NIDA: ${NIDA_MESSAGE}`);
  const nida = nidaCell && nidaCell !== 'bad' ? nidaCell : null;

  if (nida) {
    const owner = nidaOwners.get(nida);
    if (owner && owner !== staffNo) problems.push(`NIDA ${nida} is already on file for ${owner}`);
    else if (seenNidas.has(nida)) problems.push(`NIDA repeats row ${seenNidas.get(nida)}`);
  }

  // Date of birth (D-82): proposed for verification, never set directly.
  const dobCell = cellDate(raw.dob);
  let dob = null;
  const verified = ex.dateOfBirth?.value || null;
  const pending = ex.dateOfBirth?.pending?.changeId ? ex.dateOfBirth.pending.proposed : null;
  if (dobCell === 'bad') problems.push('Date of Birth is not a date');
  else if (dobCell) {
    const wrong = problemWith(dobCell, settings, today);
    if (wrong) problems.push(`Date of Birth: ${wrong}`);
    else if (dobCell !== verified && dobCell !== pending) {
      if (pending) problems.push(`A different date of birth (${pending}) is already waiting for verification. Decide or withdraw it first, or leave Date of Birth blank`);
      else dob = dobCell;
    }
  }

  const name = [rec.firstName, rec.lastName].filter(Boolean).join(' ');
  if (problems.length) return { outcome: 'error', problems, changes: [], staffNo, name };

  const sentForCheck = dob ? `date of birth ${dob} sent for verification` : null;
  const incomplete = [!rec.title && 'title', !dateJoined && 'date joined', !(nida || ex.personal?.nida) && 'NIDA', !(verified || pending || dob) && 'date of birth'].filter(Boolean);
  const incompleteNote = incomplete.length ? `Incomplete HR profile: ${incomplete.join(', ')}` : null;
  if (isNew) {
    return { outcome: 'new', problems, changes: [[`${rec.title || 'Title pending'}; ${rec.category}; joined ${dateJoined || 'pending'}`, sentForCheck, incompleteNote].filter(Boolean).join('; ')], staffNo, name, record: rec, nida, dob };
  }

  const changes = [];
  [['firstName', 'first name'], ['lastName', 'surname'], ['title', 'title'], ['userName', 'username'], ['gender', 'gender'], ['department', 'department'], ['email', 'email']].forEach(([k, l]) => {
    if ((rec[k] || null) !== (ex[k] || null)) changes.push(l);
  });
  if (rec.category !== ex.category) changes.push(`category to ${rec.category}`);
  if (dateJoined !== dayOf(ex.dateJoined)) changes.push('date joined');
  if (nida && nida !== ex.personal?.nida) changes.push('NIDA');
  if (sentForCheck) changes.push(sentForCheck);
  if (incompleteNote && changes.length) changes.push(incompleteNote);
  return { outcome: changes.length ? 'update' : 'unchanged', problems, changes, staffNo, name, record: rec, nida: nida && nida !== ex.personal?.nida ? nida : null, dob };
}

/** Loads what checkRow needs for a set of rows, in one pass. */
async function context(rows, session) {
  const nos = [...new Set(rows.map((r) => (text(r.raw.staffNo) || '').toUpperCase()).filter(Boolean))];
  const nidas = [...new Set(rows.map((r) => cellNida(r.raw.nida)).filter((n) => n && n !== 'bad'))];
  const userNames = [...new Set(rows.map((r) => text(r.raw.userName)?.toLowerCase()).filter(Boolean))];
  const [existing, owners, userOwners, settings] = await Promise.all([
    Staff.find({ staffNo: { $in: nos } }).session(session || null).lean(),
    nidas.length ? Staff.find({ 'personal.nida': { $in: nidas } }).select('staffNo personal.nida').session(session || null).lean() : [],
    userNames.length ? Staff.find({ userName: { $in: userNames } }).select('staffNo userName').session(session || null).lean() : [],
    Settings.get(),
  ]);
  return { byNo: new Map(existing.map((s) => [s.staffNo, s])), nidaOwners: new Map(owners.map((s) => [s.personal.nida, s.staffNo])), userNameOwners: new Map(userOwners.map((s) => [s.userName, s.staffNo])), settings };
}

/** Checks every row; returns rows with outcome, problems, changes and the plan to apply. */
async function checkRows(rows, session) {
  const ctx = await context(rows, session);
  const seen = new Map();
  const seenNidas = new Map();
  const seenUserNames = new Map();
  const today = localDay();
  return rows.map((r) => {
    const sn = (text(r.raw.staffNo) || '').toUpperCase();
    const existing = ctx.byNo.get(sn) || null;
    const res = checkRow(r.raw, { existing, seenStaffNos: seen, seenNidas, seenUserNames, userNameOwners: ctx.userNameOwners, nidaOwners: ctx.nidaOwners, settings: ctx.settings, today });
    if (sn && !seen.has(sn)) seen.set(sn, r.rowNo);
    const un = text(r.raw.userName)?.toLowerCase();
    if (un && !seenUserNames.has(un)) seenUserNames.set(un, r.rowNo);
    const n = cellNida(r.raw.nida);
    if (n && n !== 'bad' && !seenNidas.has(n)) seenNidas.set(n, r.rowNo);
    return { rowNo: r.rowNo, raw: r.raw, existing, ...res };
  });
}

const summarise = (rows) => ({
  new: rows.filter((r) => r.outcome === 'new').length,
  update: rows.filter((r) => r.outcome === 'update').length,
  unchanged: rows.filter((r) => r.outcome === 'unchanged').length,
  error: rows.filter((r) => r.outcome === 'error').length,
});

module.exports = { COLUMNS, HEADERS, MAX_ROWS, templateWorkbook, errorWorkbook, parseFile, checkRows, summarise, ImportFileError, cellDate, cellNida };

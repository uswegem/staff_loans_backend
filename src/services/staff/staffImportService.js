'use strict';

// Staff records bulk upload (FR-02). The file is parsed on the server only (DECISIONS
// D-14). Every row is checked against the rules and the current records before
// anything changes; People and Culture see new, updated, unchanged and error rows and
// confirm. Blank cells keep the existing value for staff already on file (prototype).

const XLSX = require('xlsx');
const { STAFF_NO } = require('../../constants/staffNo');
const Staff = require('../../models/Staff');
const Salary = require('../../models/Salary');
const { localDay, localMidnight } = require('../../utils/dates');
const { normalisePhone, PHONE_MESSAGE } = require('../../utils/formats');

const MAX_ROWS = 5000;

// [key, header, instruction, requiredForNew]
const COLUMNS = Object.freeze([
  ['staffNo', 'Staff number', 'Required. The employee code on the payslip, for example AT637.', true],
  ['firstName', 'First name', 'Required for new staff.', true],
  ['lastName', 'Last name', 'Required for new staff.', true],
  ['title', 'Job title', 'Required for new staff.', true],
  ['department', 'Department', 'Optional.', false],
  ['station', 'Work station', 'Required for new staff. Branch or Head Office.', true],
  ['stationHeadName', 'Head of station', 'Optional. Name of the head of the branch or station.', false],
  ['stationHeadPhone', 'Head of station phone', 'Optional.', false],
  ['lineManager', 'Line manager staff number', 'Optional. Must be a staff number on file or in this upload.', false],
  ['category', 'Category', 'Required for new staff. Management or Non-management. Decides the approval route.', true],
  ['employmentType', 'Employment type', 'Required for new staff. Permanent, Probation or Contract.', true],
  ['dateJoined', 'Date joined', 'Required for new staff. A date, for example 15/01/2024.', true],
  ['probationEndDate', 'Probation end date', 'Optional. Blank means the probation period in the settings, counted from the date joined.', false],
  ['contractEndDate', 'Contract end date', 'Required when the employment type is Contract.', false],
  ['email', 'Email', 'Optional.', false],
  ['workPhone', 'Work phone', 'Optional.', false],
  ['mobile', 'Mobile phone', 'Optional. Only fills an empty mobile number; staff keep their own up to date.', false],
  ['lfbAccountNo', 'LFB account number', 'Optional. Filled in on the staff member\'s profile as their bank account.', false],
  ['basic', 'Basic salary (TZS)', 'Required for new staff. Whole shillings, commas allowed.', true],
  ['allowances', 'Allowances (TZS)', 'Optional. Not counted for affordability.', false],
  ['commission', 'Sales commission (TZS)', 'Optional.', false],
  ['gross', 'Gross salary (TZS)', 'Optional.', false],
  ['net', 'Net salary (TZS)', 'Optional.', false],
  ['salaryEffective', 'Salary effective from', 'Optional. A date. Blank means the date joined for new staff and today for updates. Salary changes are kept as history.', false],
  ['active', 'Active', 'Yes or No. Blank keeps the current status (Yes for new staff). No stops sign-in and new applications.', false],
]);

const HEADERS = COLUMNS.map((c) => c[1]);
const norm = (h) => String(h).toLowerCase().replace(/\(tzs\)/g, '').replace(/[^a-z]/g, '');
const HEADER_MAP = Object.fromEntries(COLUMNS.map(([k, h]) => [norm(h), k]));
const label = (k) => COLUMNS.find((c) => c[0] === k)[1];

// ---------- template and error file ----------

function templateWorkbook() {
  const wb = XLSX.utils.book_new();
  // Built by column so the example always lines up with the headings.
  const sample = { staffNo: 'AT901', firstName: 'Baraka', lastName: 'Mwakyusa', title: 'Teller', department: 'Branch Network', station: 'Mbeya Branch', stationHeadName: 'Faraji Nyoni', stationHeadPhone: '+255787021554', lineManager: 'AT188', category: 'Non-management', employmentType: 'Permanent', dateJoined: '03/11/2026', email: 'baraka.mwakyusa@example.lfb', mobile: '+255744100200', lfbAccountNo: '4010 3341 0612', basic: 1150000, allowances: 100000, salaryEffective: '03/11/2026', active: 'Yes' };
  const example = COLUMNS.map(([k]) => sample[k] ?? '');
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, example]);
  ws['!cols'] = HEADERS.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Staff records');
  const ins = XLSX.utils.aoa_to_sheet([
    ['Column', 'What to enter'],
    ...COLUMNS.map((c) => [c[1], c[2]]),
    [],
    ['How it works', 'One row per staff member. Existing staff numbers are updated; new ones are added with an incomplete profile, which the staff member completes. Blank cells keep what is on file. Rows are checked first and nothing changes until you confirm. Delete the example row before uploading.'],
    ['Sign-in', 'Uploading a staff record does not create a sign-in. A System Administrator adds it in Users and roles.'],
    ['Dates', 'Use day/month/year (15/01/2024), year-month-day (2024-01-15) or an Excel date.'],
    ['Retirement', 'Not entered here: the retirement date is worked out from the date of birth People and Culture verify.'],
  ]);
  ins['!cols'] = [{ wch: 28 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, ins, 'Instructions');
  const lists = XLSX.utils.aoa_to_sheet([['Category', 'Employment type', 'Active'], ['Management', 'Permanent', 'Yes'], ['Non-management', 'Probation', 'No'], ['', 'Contract', '']]);
  XLSX.utils.book_append_sheet(wb, lists, 'Lists');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function errorWorkbook(rows) {
  const data = rows.map((r) => [...COLUMNS.map(([k]) => (r.raw?.[k] ?? '')), r.problems.join('; '), r.rowNo]);
  const ws = XLSX.utils.aoa_to_sheet([[...HEADERS, 'Errors', 'Row in your file'], ...data]);
  ws['!cols'] = [...HEADERS.map((h) => ({ wch: Math.max(14, h.length + 2) })), { wch: 80 }, { wch: 10 }];
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
  const keys = aoa[0].map((h) => HEADER_MAP[norm(h)] || null);
  if (!keys.includes('staffNo')) throw new ImportFileError('There is no "Staff number" column. Use the Excel template.');
  const body = aoa.slice(1);
  if (body.length > MAX_ROWS) throw new ImportFileError(`The file has more than ${MAX_ROWS.toLocaleString('en-US')} rows. Split it into smaller files.`);
  return body
    .map((cells, i) => {
      const raw = {};
      keys.forEach((k, j) => {
        if (k) raw[k] = typeof cells[j] === 'string' ? cells[j].trim() : cells[j];
      });
      return { rowNo: i + 2, raw };
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

/** Whole shillings, null when blank, or NaN. */
function cellMoney(v) {
  if (blank(v)) return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : Number.NaN;
  const t = String(v).replace(/[,\s]/g, '').replace(/^tzs/i, '');
  return /^\d+$/.test(t) ? Number.parseInt(t, 10) : Number.NaN;
}

function cellYesNo(v) {
  if (blank(v)) return null;
  const t = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'ndiyo'].includes(t)) return true;
  if (['no', 'n', 'false', '0', 'hapana'].includes(t)) return false;
  return undefined;
}

function cellCategory(v) {
  if (blank(v)) return null;
  const t = String(v).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (t === 'management') return 'Management';
  if (['non-management', 'nonmanagement'].includes(t)) return 'Non-management';
  return undefined;
}

function cellEmployment(v) {
  if (blank(v)) return null;
  const t = String(v).trim().toLowerCase();
  return { permanent: 'Permanent', probation: 'Probation', contract: 'Contract' }[t];
}

const dayOf = (date) => (date ? localDay(date) : null);
const asDate = (day) => (day ? localMidnight(day) : null);

// ---------- row checks ----------

/**
 * Checks one row against the current record (if any). Returns
 * { outcome, problems, changes, name, staffNo, record, salary, status } where record is
 * the full set of HR fields to store and salary is a new salary row or null.
 */
function checkRow(raw, { existing, salaryInForce, knownStaffNos, seenStaffNos, today }) {
  const problems = [];
  const staffNo = (text(raw.staffNo) || '').toUpperCase();
  if (!staffNo) problems.push('Staff number is missing');
  else if (!STAFF_NO.test(staffNo)) problems.push('Staff number must be the employee code on the payslip, for example AT637');
  else if (seenStaffNos.has(staffNo)) problems.push(`Staff number repeats row ${seenStaffNos.get(staffNo)}`);

  const ex = existing || {};
  const pick = (k, current) => (blank(raw[k]) ? current : text(raw[k]));
  const rec = {
    firstName: pick('firstName', ex.firstName),
    lastName: pick('lastName', ex.lastName),
    title: pick('title', ex.title),
    department: pick('department', ex.department),
    station: pick('station', ex.station),
    stationHead: { name: pick('stationHeadName', ex.stationHead?.name), phone: pick('stationHeadPhone', ex.stationHead?.phone) },
    email: blank(raw.email) ? ex.email : text(raw.email).toLowerCase(),
    workPhone: pick('workPhone', ex.workPhone),
    lfbAccountNo: pick('lfbAccountNo', ex.lfbAccountNo),
  };
  // Phone numbers in the stored format (D-93); one that does not normalise is an error.
  const phoneCell = (k) => {
    if (blank(raw[k])) return null;
    const p = normalisePhone(String(raw[k]));
    if (!p) problems.push(`${label(k)}: ${PHONE_MESSAGE}`);
    return p;
  };
  const newPhones = { stationHeadPhone: phoneCell('stationHeadPhone'), workPhone: phoneCell('workPhone'), mobile: phoneCell('mobile') };
  if (newPhones.stationHeadPhone) rec.stationHead.phone = newPhones.stationHeadPhone;
  if (newPhones.workPhone) rec.workPhone = newPhones.workPhone;
  if (!existing) {
    COLUMNS.filter((c) => c[3] && c[0] !== 'staffNo' && !['category', 'employmentType', 'dateJoined', 'basic'].includes(c[0])).forEach(([k, h]) => {
      if (!rec[k]) problems.push(`${h} is required for new staff`);
    });
  }
  if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) problems.push('Email is not a valid address');

  const cat = cellCategory(raw.category);
  if (cat === undefined) problems.push('Category must be Management or Non-management');
  rec.category = cat || ex.category;
  if (!rec.category) problems.push('Category is required for new staff');

  const emp = cellEmployment(raw.employmentType);
  if (emp === undefined) problems.push('Employment type must be Permanent, Probation or Contract');
  rec.employmentType = emp || ex.employmentType;
  if (!rec.employmentType) problems.push('Employment type is required for new staff');

  const dates = {};
  for (const k of ['dateJoined', 'probationEndDate', 'contractEndDate']) {
    const d = cellDate(raw[k]);
    if (d === 'bad') problems.push(`${label(k)} is not a date`);
    dates[k] = d && d !== 'bad' ? d : dayOf(ex[k]);
  }
  if (!dates.dateJoined) problems.push('Date joined is required');
  if (dates.dateJoined && dates.dateJoined > today) problems.push('Date joined cannot be in the future');
  if (dates.probationEndDate && dates.dateJoined && dates.probationEndDate < dates.dateJoined) problems.push('Probation end date must not be before the date joined');
  if (rec.employmentType === 'Contract' && !dates.contractEndDate) problems.push('Contract end date is required for contract staff');
  if (dates.contractEndDate && dates.dateJoined && dates.contractEndDate <= dates.dateJoined) problems.push('Contract end date must be after the date joined');
  Object.assign(rec, Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, asDate(v)])));

  const lm = text(raw.lineManager)?.toUpperCase();
  if (lm) {
    if (!STAFF_NO.test(lm)) problems.push('Line manager staff number must be an employee code, for example AT637');
    else if (lm === staffNo) problems.push('A staff member cannot be their own line manager');
    else if (!knownStaffNos.has(lm)) problems.push(`Line manager ${lm} is not on file or in this upload`);
  }
  rec.lineManagerStaffNo = lm || null;

  // Salary (FR-03): a new effective-dated row when any amount changes.
  const money = {};
  for (const k of ['basic', 'allowances', 'commission', 'gross', 'net']) {
    money[k] = cellMoney(raw[k]);
    if (Number.isNaN(money[k])) problems.push(`${label(k)} must be whole shillings`);
  }
  const eff = cellDate(raw.salaryEffective);
  if (eff === 'bad') problems.push('Salary effective from is not a date');
  const cur = salaryInForce || {};
  const salary = {
    basic: money.basic ?? cur.basic,
    allowances: money.allowances ?? cur.allowances ?? 0,
    commission: money.commission ?? cur.commission ?? 0,
    gross: money.gross ?? cur.gross,
    net: money.net ?? cur.net,
  };
  if (!(salary.basic > 0)) problems.push('Basic salary must be a number above zero');
  const salaryChanged = !salaryInForce || ['basic', 'allowances', 'commission', 'gross', 'net'].some((k) => (salary[k] ?? null) !== (cur[k] ?? null));
  const effective = eff && eff !== 'bad' ? eff : existing ? today : dates.dateJoined;
  if (salaryChanged && dates.dateJoined && effective && effective < dates.dateJoined) problems.push('Salary effective from must not be before the date joined');

  const active = cellYesNo(raw.active);
  if (active === undefined) problems.push('Active must be Yes or No');
  const status = active === null ? ex.status || 'active' : active ? 'active' : 'deactivated';
  const name = [rec.firstName, rec.lastName].filter(Boolean).join(' ');

  if (problems.length) return { outcome: 'error', problems, changes: [], staffNo, name };

  const { mobile } = newPhones;
  if (!existing) {
    return {
      outcome: 'new',
      problems,
      changes: [`${rec.title}, ${rec.station}; ${rec.category}; basic ${salary.basic.toLocaleString('en-US')}`],
      staffNo,
      name,
      record: rec,
      mobile,
      status,
      salary: { ...salary, effectiveFrom: effective },
    };
  }

  const changes = [];
  const sameDay = (a, b) => dayOf(a) === dayOf(b);
  const compare = [
    ['firstName', 'first name'],
      ['lastName', 'last name'],
    ['title', 'job title'],
    ['department', 'department'],
    ['station', 'work station'],
    ['email', 'email'],
    ['workPhone', 'work phone'],
    ['lfbAccountNo', 'LFB account number'],
    ['employmentType', 'employment type'],
  ];
  compare.forEach(([k, l]) => {
    if ((rec[k] || null) !== (ex[k] || null)) changes.push(l);
  });
  if (rec.category !== ex.category) changes.push(`category to ${rec.category}`);
  if ((rec.stationHead.name || null) !== (ex.stationHead?.name || null) || (rec.stationHead.phone || null) !== (ex.stationHead?.phone || null)) changes.push('head of station');
  ['dateJoined', 'probationEndDate', 'contractEndDate'].forEach((k) => {
    if (!sameDay(rec[k], ex[k])) changes.push(label(k).toLowerCase());
  });
  if (rec.lineManagerStaffNo && rec.lineManagerStaffNo !== ex.lineManagerStaffNo) changes.push('line manager');
  if (mobile && !ex.personal?.mobile) changes.push('mobile phone');
  if (salaryChanged) changes.push(`salary from ${dayOf(asDate(effective))}${money.basic != null && money.basic !== cur.basic ? `: basic ${(cur.basic || 0).toLocaleString('en-US')} → ${salary.basic.toLocaleString('en-US')}` : ''}`);
  if (status !== ex.status) changes.push(status === 'active' ? 'reactivated' : 'set inactive');

  return {
    outcome: changes.length ? 'update' : 'unchanged',
    problems,
    changes,
    staffNo,
    name,
    record: rec,
    mobile,
    status,
    salary: salaryChanged ? { ...salary, effectiveFrom: effective } : null,
  };
}

/** Loads what checkRow needs for a set of rows, in one pass. */
async function context(rows, session) {
  const nos = [...new Set(rows.map((r) => (text(r.raw.staffNo) || '').toUpperCase()).filter(Boolean))];
  const lineManagers = [...new Set(rows.map((r) => (text(r.raw.lineManager) || '').toUpperCase()).filter(Boolean))];
  const existing = await Staff.find({ staffNo: { $in: [...nos, ...lineManagers] } }).session(session || null).lean();
  const byNo = new Map(existing.map((s) => [s.staffNo, s]));
  const ids = existing.map((s) => s._id);
  const salaries = await Salary.find({ staffId: { $in: ids }, effectiveFrom: { $lte: new Date() } }).sort({ effectiveFrom: -1 }).session(session || null).lean();
  const salaryByStaff = new Map();
  salaries.forEach((s) => {
    if (!salaryByStaff.has(String(s.staffId))) salaryByStaff.set(String(s.staffId), s);
  });
  const lmIds = existing.filter((s) => s.lineManagerId).map((s) => s.lineManagerId);
  const lms = await Staff.find({ _id: { $in: lmIds } }).select('staffNo').session(session || null).lean();
  const lmNoById = new Map(lms.map((s) => [String(s._id), s.staffNo]));
  existing.forEach((s) => {
    s.lineManagerStaffNo = s.lineManagerId ? lmNoById.get(String(s.lineManagerId)) : null;
  });
  const knownStaffNos = new Set([...existing.map((s) => s.staffNo), ...nos]);
  return { byNo, salaryByStaff, knownStaffNos };
}

/** Checks every row; returns rows with outcome, problems, changes and the plan to apply. */
async function checkRows(rows, session) {
  const ctx = await context(rows, session);
  const seen = new Map();
  const today = localDay();
  return rows.map((r) => {
    const sn = (text(r.raw.staffNo) || '').toUpperCase();
    const existing = ctx.byNo.get(sn) || null;
    const res = checkRow(r.raw, { existing, salaryInForce: existing ? ctx.salaryByStaff.get(String(existing._id)) : null, knownStaffNos: ctx.knownStaffNos, seenStaffNos: seen, today });
    if (sn && !seen.has(sn)) seen.set(sn, r.rowNo);
    return { rowNo: r.rowNo, raw: r.raw, existing, ...res };
  });
}

const summarise = (rows) => ({
  new: rows.filter((r) => r.outcome === 'new').length,
  update: rows.filter((r) => r.outcome === 'update').length,
  unchanged: rows.filter((r) => r.outcome === 'unchanged').length,
  error: rows.filter((r) => r.outcome === 'error').length,
});

module.exports = { COLUMNS, HEADERS, MAX_ROWS, templateWorkbook, errorWorkbook, parseFile, checkRows, summarise, ImportFileError, cellDate, cellMoney };

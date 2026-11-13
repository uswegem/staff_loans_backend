'use strict';

const XLSX = require('xlsx');
const { normaliseNida, formatNida } = require('../../src/services/staff/profileService');
const { cellDate, cellNida, parseFile, HEADERS, COLUMNS, templateWorkbook } = require('../../src/services/staff/staffImportService');
const { cooling } = require('../../src/services/staff/eligibilityService');
const { probationInfo } = require('../../src/services/staff/staffService');
const { addMonths } = require('../../src/utils/dates');

describe('NIDA number (decision 7, D-93)', () => {
  // Stored with its hyphens; 20 digits typed or pasted in any grouping are accepted.
  it.each([
    ['19890712-14112-00004-21', '19890712-14112-00004-21'],
    ['19890712141120000421', '19890712-14112-00004-21'],
    ['  19890712-14112-0000421 ', '19890712-14112-00004-21'],
    ['19800630-13140-0000420', '19800630-13140-00004-20'],
  ])('accepts %s', (input, stored) => {
    expect(normaliseNida(input)).toBe(stored);
  });

  it.each(['1989071214112000042', '19890712-14112-00004-2X', '19891332-14112-00004-21', '18000101141120000421', ''])('refuses %s', (input) => {
    expect(normaliseNida(input)).toBeNull();
  });

  it('formats with dashes', () => {
    expect(formatNida('19890712141120000421')).toBe('19890712-14112-00004-21');
  });
});

describe('import cells', () => {
  it('reads dates in every accepted form', () => {
    expect(cellDate('15/01/2024')).toBe('2024-01-15');
    expect(cellDate('2024-01-15')).toBe('2024-01-15');
    expect(cellDate(45306)).toBe('2024-01-15'); // Excel serial
    expect(cellDate('')).toBeNull();
    expect(cellDate('31/02/2024')).toBe('bad');
    expect(cellDate('next week')).toBe('bad');
  });

  it('reads a NIDA number with the existing format helper (D-93, D-100)', () => {
    expect(cellNida('19900514123450000123')).toBe('19900514-12345-00001-23');
    expect(cellNida(' 19900514-12345-00001-23 ')).toBe('19900514-12345-00001-23');
    expect(cellNida('')).toBeNull();
    expect(cellNida('1990051412345')).toBe('bad');
    expect(cellNida('19901314-12345-00001-23')).toBe('bad'); // month 13
  });
});

describe('import file', () => {
  const book = (rows, sheet = 'Staff records', type = 'xlsx') => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
    return XLSX.write(wb, { type: 'buffer', bookType: type });
  };

  it('the template has the extended columns, their instructions and an example (D-100)', () => {
    expect(HEADERS).toEqual(['First name', 'Middle name', 'Username', 'Gender', 'Department', 'Email', 'Surname', 'NIDA', 'Title', 'Staff Number/Code', 'Date of Birth', 'Date Joined', 'Category']);
    const wb = XLSX.read(templateWorkbook(), { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Staff records', 'Instructions', 'Lists']);
    const [head, example] = XLSX.utils.sheet_to_json(wb.Sheets['Staff records'], { header: 1 });
    expect(head).toEqual(HEADERS);
    expect(example).toEqual(['Baraka', '', 'baraka.mwakyusa', 'Male', 'Branch Network', 'baraka@example.test', 'Mwakyusa', '19900514-12345-00001-23', 'Teller', 'AT901', '14/05/1990', '03/11/2026', 'Non-management']);
    const ins = XLSX.utils.sheet_to_json(wb.Sheets.Instructions, { header: 1 });
    expect(ins.slice(1, 1 + COLUMNS.length)).toEqual(COLUMNS.map((c) => [c[1], c[2]]));
    expect(ins[8]).toEqual(['NIDA', COLUMNS[7][2]]);
    expect(ins[10]).toEqual(['Staff Number/Code', 'Required. Used to authenticate staff against the payslip uploaded during a loan application.']);
  });

  it('maps headings loosely, ignores columns that are not in the template and skips blank rows', () => {
    const rows = parseFile(book([['STAFF NUMBER/CODE', 'first name', 'Basic salary', 'date of birth'], ['LFB0700', 'Baraka', 1200000, '14/05/1990'], ['', '', '', ''], ['LFB0701', 'Zawadi', 900000, '']]));
    expect(rows).toEqual([
      { rowNo: 2, raw: { staffNo: 'LFB0700', firstName: 'Baraka', dob: '14/05/1990' } },
      { rowNo: 4, raw: { staffNo: 'LFB0701', firstName: 'Zawadi', dob: '' } },
    ]);
  });

  it('reads CSV and old .xls', () => {
    const csv = Buffer.from('Staff number,First name\nLFB0700,Baraka\n');
    expect(parseFile(csv)[0].raw.staffNo).toBe('LFB0700');
    expect(parseFile(book([['Staff number'], ['LFB0700']], 'Sheet1', 'biff8'))[0].raw.staffNo).toBe('LFB0700');
  });

  it('refuses a file without a staff number column', () => {
    expect(() => parseFile(book([['First name'], ['Baraka']]))).toThrow('Staff Number/Code');
  });
});

describe('reapply cooling period (NS-02, NS-03)', () => {
  const staff = { loanHistory: [{ productId: 'p1', appliedAt: new Date('2026-06-03T09:00:00+03:00'), approvedAt: new Date('2026-06-10T09:00:00+03:00'), ref: 'SL-2026-00010' }], existingLfbLoans: [] };

  it('counts days until the same product can be applied for again', () => {
    const c = cooling(staff, 'p1', 6, new Date('2026-10-29T12:00:00+03:00'));
    expect(c).toMatchObject({ nextEligibleDate: '2026-12-03', daysRemaining: 35, ref: 'SL-2026-00010' });
  });

  it('is zero once the period has passed', () => {
    expect(cooling(staff, 'p1', 6, new Date('2026-12-03T08:00:00+03:00')).daysRemaining).toBe(0);
  });

  it('other products are not affected', () => {
    expect(cooling(staff, 'p2', 6, new Date())).toBeNull();
  });

  it('an application that never reached final approval does not count', () => {
    expect(cooling({ loanHistory: [{ productId: 'p1', appliedAt: new Date(), approvedAt: null }] }, 'p1', 6)).toBeNull();
  });

  it('a declared paper loan with product and date counts (C-03)', () => {
    const c = cooling({ loanHistory: [], existingLfbLoans: [{ productId: 'p1', disbursedOn: new Date('2026-09-01T00:00:00+03:00') }] }, 'p1', 6, new Date('2026-10-29T12:00:00+03:00'));
    expect(c.nextEligibleDate).toBe('2027-03-01');
  });

  it('adds calendar months, clamping to the month end', () => {
    expect(addMonths(new Date('2026-08-31T00:00:00Z'), 6).toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});

describe('probation (NS-01)', () => {
  it('is the first probation months after joining', () => {
    const p = probationInfo({ dateJoined: new Date('2026-02-02T00:00:00+03:00') }, 6, new Date('2026-07-01T00:00:00+03:00'));
    expect(p).toEqual({ onProbation: true, endsOn: '2026-08-02' });
  });

  it('a probation end date entered before D-100 no longer counts, earlier or later', () => {
    const joined = new Date('2026-02-02T00:00:00+03:00');
    expect(probationInfo({ dateJoined: joined, probationEndDate: new Date('2026-12-31T00:00:00+03:00') }, 6, new Date('2026-10-01T00:00:00+03:00'))).toEqual({ onProbation: false, endsOn: '2026-08-02' });
    expect(probationInfo({ dateJoined: joined, probationEndDate: new Date('2026-03-01T00:00:00+03:00') }, 6, new Date('2026-05-01T00:00:00+03:00'))).toEqual({ onProbation: true, endsOn: '2026-08-02' });
  });

  it('follows the probation months in the settings', () => {
    expect(probationInfo({ dateJoined: new Date('2026-02-02T00:00:00+03:00') }, 3).endsOn).toBe('2026-05-02');
  });

  it('long-serving staff are not on probation', () => {
    expect(probationInfo({ dateJoined: new Date('2019-03-04') }, 6).onProbation).toBe(false);
  });
});

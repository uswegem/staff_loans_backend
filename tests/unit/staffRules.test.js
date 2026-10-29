'use strict';

const XLSX = require('xlsx');
const { normaliseNida, formatNida } = require('../../src/services/staff/profileService');
const { cellDate, cellMoney, parseFile, HEADERS, templateWorkbook } = require('../../src/services/staff/staffImportService');
const { cooling } = require('../../src/services/staff/eligibilityService');
const { probationInfo } = require('../../src/services/staff/staffService');
const { addMonths } = require('../../src/utils/dates');

describe('NIDA number (decision 7)', () => {
  it.each([
    ['19890712-14112-00004-21', '19890712141120000421'],
    ['19890712141120000421', '19890712141120000421'],
    ['  19890712-14112-0000421 ', '19890712141120000421'],
  ])('accepts %s', (input, digits) => {
    expect(normaliseNida(input)).toBe(digits);
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

  it('reads whole shillings with or without separators', () => {
    expect(cellMoney('1,950,000')).toBe(1950000);
    expect(cellMoney(1150000)).toBe(1150000);
    expect(cellMoney('TZS 500 000')).toBe(500000);
    expect(cellMoney('')).toBeNull();
    expect(Number.isNaN(cellMoney('12.5'))).toBe(true);
    expect(Number.isNaN(cellMoney(-5))).toBe(true);
  });
});

describe('import file', () => {
  const book = (rows, sheet = 'Staff records', type = 'xlsx') => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
    return XLSX.write(wb, { type: 'buffer', bookType: type });
  };

  it('the template has the staff sheet, instructions and lists', () => {
    const wb = XLSX.read(templateWorkbook(), { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Staff records', 'Instructions', 'Lists']);
    const head = XLSX.utils.sheet_to_json(wb.Sheets['Staff records'], { header: 1 })[0];
    expect(head).toEqual(HEADERS);
  });

  it('maps headings loosely and skips blank rows', () => {
    const rows = parseFile(book([['STAFF NUMBER', 'first name', 'Basic salary'], ['LFB0700', 'Baraka', 1200000], ['', '', ''], ['LFB0701', 'Zawadi', 900000]]));
    expect(rows).toEqual([
      { rowNo: 2, raw: { staffNo: 'LFB0700', firstName: 'Baraka', basic: 1200000 } },
      { rowNo: 4, raw: { staffNo: 'LFB0701', firstName: 'Zawadi', basic: 900000 } },
    ]);
  });

  it('reads CSV and old .xls', () => {
    const csv = Buffer.from('Staff number,First name\nLFB0700,Baraka\n');
    expect(parseFile(csv)[0].raw.staffNo).toBe('LFB0700');
    expect(parseFile(book([['Staff number'], ['LFB0700']], 'Sheet1', 'biff8'))[0].raw.staffNo).toBe('LFB0700');
  });

  it('refuses a file without a staff number column', () => {
    expect(() => parseFile(book([['Name'], ['Baraka']]))).toThrow(/Staff number/);
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

  it('a later end date set by People and Culture wins', () => {
    const p = probationInfo({ dateJoined: new Date('2026-02-02T00:00:00+03:00'), probationEndDate: new Date('2026-12-31T00:00:00+03:00') }, 6, new Date('2026-10-01T00:00:00+03:00'));
    expect(p).toEqual({ onProbation: true, endsOn: '2026-12-31' });
  });

  it('long-serving staff are not on probation', () => {
    expect(probationInfo({ dateJoined: new Date('2019-03-04') }, 6).onProbation).toBe(false);
  });
});

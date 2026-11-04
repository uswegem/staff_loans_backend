'use strict';

// Reads Basic Pay, LFB deductions and the pay date from the applicant's payslip PDF
// (DECISIONS D-79). The text is taken from the PDF with PDF.js and rebuilt into lines
// by position, then matched against labels held in Settings (payslipRules), so a new
// payroll layout needs a settings change, not code. Scanned images have no text and
// are refused with a clear message.

const path = require('path');
const { pathToFileURL } = require('url');

const MAX_PAGES = 3;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Labels used when Settings hold none (D-79), set from LFB's SeamlessHR payslip of
 * October 2026: "Payslip for October 2026", "Basic", "STAFF LOAN". The bank's own name
 * is on every payslip (header, bank name, footer), so it is never an LFB label.
 */
const DEFAULT_RULES = Object.freeze({
  basicLabels: ['Basic Salary', 'Basic Pay', 'Basic'],
  lfbLabels: ['Staff Loan', 'Staff Loans', 'LFB Loan'],
  dateLabels: ['Payslip for', 'Pay Date', 'Payment Date', 'Pay Period'],
});

/** The labels in force: those saved in Settings, or the defaults. */
const rulesFrom = (settings) => Object.fromEntries(Object.keys(DEFAULT_RULES).map((k) => [k, settings?.payslipRules?.[k]?.length ? [...settings.payslipRules[k]] : [...DEFAULT_RULES[k]]]));

let pdfjsPromise;
const pdfjs = () => {
  pdfjsPromise = pdfjsPromise || import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  return pdfjsPromise;
};
// PDF.js wants forward slashes and a trailing slash, also on Windows.
const FONTS = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').split(path.sep).join('/')}/`;

/** Text lines of the first pages, left to right, top to bottom. */
async function textLines(buffer) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl: FONTS, verbosity: 0 });
  const doc = await task.promise;
  const lines = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGES); p += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { items } = await (await doc.getPage(p)).getTextContent();
      const rows = [];
      for (const it of items.filter((i) => i.str && i.str.trim())) {
        const y = it.transform[5];
        let row = rows.find((r) => Math.abs(r.y - y) <= 2);
        if (!row) rows.push((row = { y, cells: [] }));
        row.cells.push({ x: it.transform[4], text: it.str.trim() });
      }
      rows.sort((a, b) => b.y - a.y).forEach((r) => lines.push(r.cells.sort((a, b) => a.x - b.x).map((c) => c.text).join('  ')));
    }
  } finally {
    await task.destroy();
  }
  return lines;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A label is a whole word: "LFB" must not match the staff number "LFB0412".
const labelRe = (labels) => new RegExp(`(?:^|[^A-Za-z0-9])(${labels.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9])`, 'i');
// Staff loan labels (D-101): words may be joined by any spacing or punctuation ("Staff Loan - Car"
// finds "STAFF LOAN CAR"), and the longest label is tried first, so "Staff Loan" never cuts
// "Staff Loan - Car" short.
const words = (label) => String(label).split(/[^A-Za-z0-9]+/).filter(Boolean);
const loanLabelRe = (labels) => {
  const alts = [...new Set(labels)].filter((l) => words(l).length).sort((a, b) => words(b).join('').length - words(a).join('').length || b.length - a.length);
  return new RegExp(`(?:^|[^A-Za-z0-9])(${alts.map((l) => words(l).map(escapeRe).join('[^A-Za-z0-9]*')).join('|')})(?![A-Za-z0-9])`, 'i');
};
// An amount is printed as money: with thousands separators (1,850,000) or cents
// (500.00), standing alone. A year (2026), an account number (20000000000) or a code
// such as LFB0412 is not an amount.
const MONEY = /(?:TZS|TSH|Tsh\.?)?\s*(?<![A-Za-z0-9/.,-])(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})(?![\d/A-Za-z-]|,\d)/i;

/** Whole shillings from the first amount in the text (cents are dropped). */
function firstAmount(text) {
  const m = MONEY.exec(text);
  return m ? { value: Math.floor(Number(m[1].replace(/,/g, ''))), end: m.index + m[0].length } : null;
}

/** A payslip date: 31/10/2026, 2026-10-31, 31 Oct 2026, October 2026 (month end). */
function parseDate(text) {
  const pad = (n) => String(n).padStart(2, '0');
  const valid = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
  };
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(text);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = /(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})/.exec(text);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return valid(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  m = /([A-Za-z]{3,9})[\s,-]+(\d{4})/.exec(text);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) {
    const y = +m[2];
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return valid(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate()); // a pay month counts from its last day
  }
  return null;
}

/**
 * Finds the figures in the lines. Every staff loan label (the settings' and each product's,
 * D-101) starts a separate line of lfbLines, kept with its label as printed; LFB deductions
 * are their sum (a payslip can carry several staff loans).
 */
function parse(lines, rules = DEFAULT_RULES) {
  const basicRe = labelRe(rules.basicLabels);
  const lfbRe = loanLabelRe([...rules.lfbLabels, ...(rules.productLabels || [])]);
  const dateRe = labelRe(rules.dateLabels);
  let basic = null;
  let payDate = null;
  const lfbLines = [];
  for (const line of lines) {
    if (basic === null) {
      const m = basicRe.exec(line);
      const amt = m && firstAmount(line.slice(m.index + m[0].length));
      if (amt) basic = amt.value;
    }
    if (payDate === null) {
      const m = dateRe.exec(line);
      if (m) payDate = parseDate(line.slice(m.index + m[0].length));
    }
    let rest = line;
    for (let guard = 0; guard < 10; guard += 1) {
      const m = lfbRe.exec(rest);
      if (!m) break;
      const after = rest.slice(m.index + m[0].length);
      const amt = firstAmount(after);
      if (!amt) break;
      const label = (m[0] + after.slice(0, MONEY.exec(after).index)).replace(/^[^A-Za-z]+/, '').replace(/[\s:.-]+$/, '').trim();
      lfbLines.push({ label, amount: amt.value });
      rest = after.slice(amt.end);
    }
  }
  return { basic, payDate, lfbLines, lfbDeductions: lfbLines.reduce((s, l) => s + l.amount, 0) };
}

/**
 * Is this the staff member's payslip? Its employee code is the staff number (C-07),
 * unique per staff member, so it must appear as a whole code: AT63 does not match AT637.
 */
function namesStaff(lines, staff) {
  if (!staff.staffNo) return false;
  return new RegExp(`(^|[^A-Z0-9])${escapeRe(staff.staffNo.toUpperCase())}($|[^A-Z0-9])`).test(lines.join('  ').toUpperCase());
}

/**
 * Reads a payslip for an applicant. Returns { basic, lfbDeductions, lfbLines, payDate }
 * or { problem: { code, message } }.
 */
async function read(buffer, { staff, rules = DEFAULT_RULES }) {
  let lines;
  try {
    lines = await textLines(buffer);
  } catch {
    return { problem: { code: 'PAYSLIP_UNREADABLE', message: 'This file could not be opened as a PDF. Attach the payslip PDF from the payroll system.' } };
  }
  if (!lines.length) return { problem: { code: 'PAYSLIP_UNREADABLE', message: 'This payslip has no readable text (it looks like a scan or photo). Attach the PDF payslip from the payroll system.' } };
  if (!namesStaff(lines, staff)) return { problem: { code: 'PAYSLIP_NOT_YOURS', message: "Staff Code in the Payslip doesn't match your staff number, upload correct Pay Slip" } };
  const out = parse(lines, rules);
  if (!out.basic) return { problem: { code: 'PAYSLIP_NO_BASIC', message: 'Basic Pay could not be found on this payslip. Attach the payslip PDF from the payroll system, or ask People and Culture for help.' } };
  if (!out.payDate) return { problem: { code: 'PAYSLIP_NO_DATE', message: 'The pay date could not be found on this payslip. Attach the payslip PDF from the payroll system, or ask People and Culture for help.' } };
  return out;
}

module.exports = { read, parse, parseDate, textLines, namesStaff, rulesFrom, DEFAULT_RULES };

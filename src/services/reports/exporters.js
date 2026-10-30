'use strict';

// Report exports (BRD 12: Excel and PDF; prompt 4: CSV and Excel). Every format takes
// the same report object { name, columns: [{ label, type }], rows: [[...]], filters },
// so the FR-55 projection applied when the report is built holds in every export.

const XLSX = require('xlsx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ---------- CSV ----------

/** Neutralises spreadsheet formulas (CSV injection) and quotes when needed. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const BOM = String.fromCharCode(0xfeff); // so Excel reads the CSV as UTF-8

function toCsv(report) {
  return BOM + [report.columns.map((c) => c.label), ...report.rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// ---------- Excel ----------

/** Text cells that look like formulas are stored as text; numbers stay numbers. */
function toXlsx(report) {
  const aoa = [report.columns.map((c) => c.label), ...report.rows.map((r) => r.map((v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v ?? '')))];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = report.columns.map((c, i) => ({ wch: Math.min(60, Math.max(c.label.length, ...report.rows.slice(0, 200).map((r) => String(r[i] ?? '').length)) + 2) }));
  report.columns.forEach((c, i) => {
    if (c.type !== 'money' && c.type !== 'number') return;
    for (let r = 1; r < aoa.length; r += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: i })];
      if (cell && cell.t === 'n') cell.z = c.type === 'money' ? '#,##0' : '0.##';
    }
  });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, report.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  const about = [['Report', report.name], ['Generated', new Date().toISOString()], ...Object.entries(report.filters || {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)])];
  if (report.limitedCount) about.push(['Limited details', `${report.limitedCount} row(s) show name only (FR-55)`]);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(about), 'About');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

// ---------- PDF ----------

const A4_LANDSCAPE = [841.89, 595.28];
const MARGIN = 30;
const WIN_ANSI = /[^\x20-\x7E\xA0-\xFF–—‘’‚“”„•…€™]/g;
const safe = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(WIN_ANSI, '?');
const fmt = (v, type) => {
  if (v == null) return '';
  if (typeof v === 'number') return type === 'money' ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
  return String(v);
};

function fit(text, font, size, width) {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

async function toPdf(report) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 7.5;
  const rowH = 11;
  const width = A4_LANDSCAPE[0] - MARGIN * 2;

  // Column widths from content, capped so long text columns cannot crowd out the rest.
  const cells = [report.columns.map((c) => c.label), ...report.rows.slice(0, 300).map((r) => r.map((v, i) => fmt(v, report.columns[i].type)))];
  const natural = report.columns.map((_, i) => Math.min(160, Math.max(...cells.map((r) => regular.widthOfTextAtSize(safe(r[i]), size))) + 8));
  const scale = Math.min(1, width / natural.reduce((a, b) => a + b, 0));
  const widths = natural.map((w) => w * scale);

  let page;
  let y;
  const header = () => {
    page = doc.addPage(A4_LANDSCAPE);
    y = A4_LANDSCAPE[1] - MARGIN;
    page.drawText(safe(`${report.name}`), { x: MARGIN, y: y - 12, size: 12, font: bold });
    const sub = [`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, ...Object.entries(report.filters || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].join('   ');
    page.drawText(fit(sub, regular, 8, width), { x: MARGIN, y: y - 26, size: 8, font: regular, color: rgb(0.35, 0.35, 0.35) });
    y -= 40;
    let x = MARGIN;
    report.columns.forEach((c, i) => {
      page.drawText(fit(c.label, bold, size, widths[i] - 4), { x: x + 2, y: y - size, size, font: bold });
      x += widths[i];
    });
    y -= rowH;
    page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: MARGIN + width, y: y + 2 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  };
  header();
  for (const row of report.rows) {
    if (y - rowH < MARGIN) header();
    let x = MARGIN;
    row.forEach((v, i) => {
      const col = report.columns[i];
      const t = fit(fmt(v, col.type), regular, size, widths[i] - 4);
      const right = col.type === 'money' || col.type === 'number';
      page.drawText(t, { x: right ? x + widths[i] - 2 - regular.widthOfTextAtSize(t, size) : x + 2, y: y - size, size, font: regular });
      x += widths[i];
    });
    y -= rowH;
  }
  if (!report.rows.length) page.drawText('No rows for these filters.', { x: MARGIN, y: y - 10, size: 9, font: regular });
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: A4_LANDSCAPE[0] - MARGIN - 60, y: 14, size: 7, font: regular, color: rgb(0.4, 0.4, 0.4) }));
  return Buffer.from(await doc.save());
}

const FORMATS = {
  csv: { mime: 'text/csv; charset=utf-8', ext: 'csv', build: async (r) => toCsv(r) },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', build: async (r) => toXlsx(r) },
  pdf: { mime: 'application/pdf', ext: 'pdf', build: toPdf },
};

module.exports = { FORMATS, csvCell, toCsv, toXlsx, toPdf };

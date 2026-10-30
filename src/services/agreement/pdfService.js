'use strict';

// Locks a signed agreement as a PDF (FR-37): the accepted text exactly as rendered,
// followed by the acceptance evidence (FR-35). Uses pdf-lib's standard fonts, so text
// is limited to the Windows-1252 character set; anything else is replaced.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const A4 = [595.28, 841.89];
const MARGIN = 50;
const WIDTH = A4[0] - MARGIN * 2;
const WIN_ANSI = /[^\x20-\x7E\xA0-\xFF–—‘’‚“”„•…€™]/g;

const safe = (s) => String(s).replace(/\t/g, ' ').replace(WIN_ANSI, '?');

class Writer {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  ensure(h) {
    if (this.y - h < MARGIN + 20) this.newPage();
  }

  wrap(text, font, size, width) {
    const words = safe(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  text(text, { size = 10, bold = false, indent = 0, gap = 4, center = false, color = rgb(0.11, 0.11, 0.11) } = {}) {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    const lines = this.wrap(text, font, size, WIDTH - indent);
    for (const l of lines) {
      this.ensure(size + 3);
      const x = center ? MARGIN + (WIDTH - font.widthOfTextAtSize(l, size)) / 2 : MARGIN + indent;
      this.page.drawText(l, { x, y: this.y - size, size, font, color });
      this.y -= size + 3;
    }
    this.y -= gap;
  }

  table(head, rows, widths) {
    const size = 8;
    const rowH = 12;
    const draw = (cells, bold) => {
      this.ensure(rowH);
      let x = MARGIN;
      cells.forEach((c, i) => {
        const font = bold ? this.fonts.bold : this.fonts.regular;
        const t = safe(c);
        const w = widths[i] * WIDTH;
        const tx = i === 0 || i === 1 ? x + 2 : x + w - font.widthOfTextAtSize(t, size) - 2;
        this.page.drawText(t, { x: tx, y: this.y - size, size, font });
        x += w;
      });
      this.y -= rowH;
    };
    draw(head, true);
    rows.forEach((r) => {
      if (this.y - rowH < MARGIN + 20) {
        this.newPage();
        draw(head, true);
      }
      draw(r, false);
    });
    this.y -= 6;
  }
}

const plain = (parts) => parts.map((p) => p.text).join('');

/**
 * blocks: rendered agreement blocks; evidence: [[label, value]].
 * Returns a Buffer.
 */
async function agreementPdf({ blocks, title, evidence }) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('LFB Staff Loans');
  doc.setCreationDate(new Date());
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const w = new Writer(doc, fonts);

  for (const b of blocks) {
    if (b.type === 'h1') w.text(plain(b.parts), { size: 14, bold: true, center: true, gap: 6 });
    else if (b.type === 'h2') {
      w.y -= 4;
      w.text(plain(b.parts), { size: 11, bold: true, gap: 4 });
    } else if (b.type === 'note') w.text(plain(b.parts), { size: 8, center: true, gap: 6, color: rgb(0.42, 0.42, 0.4) });
    else if (b.type === 'p') w.text(plain(b.parts), { size: 10, gap: 6 });
    else if (b.type === 'ol') b.items.forEach((it, i) => w.text(`${i + 1}. ${plain(it)}`, { size: 10, indent: 10, gap: 3 }));
    else if (b.type === 'ul') b.items.forEach((it) => w.text(`• ${plain(it)}`, { size: 10, indent: 10, gap: 3 }));
    else if (b.type === 'table') w.table(b.head, b.rows, [0.1, 0.22, 0.17, 0.17, 0.15, 0.19]);
  }

  w.newPage();
  w.text('Ushahidi wa kukubali kwa njia ya kielektroniki / Electronic acceptance evidence', { size: 12, bold: true, gap: 10 });
  evidence.forEach(([k, v]) => w.text(`${k}: ${v}`, { size: 10, gap: 4 }));

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(safe(`${title} - ukurasa ${i + 1} wa ${pages.length}`), { x: MARGIN, y: 25, size: 8, font: fonts.regular, color: rgb(0.42, 0.42, 0.4) });
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

/** Rebuilds printable blocks from the stored canonical text (one line per block). */
function textBlocks(text) {
  const blocks = [];
  const lines = text.split(NL);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes(TAB)) {
      const head = line.split(TAB);
      const rows = [];
      while (lines[i + 1] && lines[i + 1].includes(TAB)) {
        i += 1;
        rows.push(lines[i].split(TAB));
      }
      blocks.push({ type: 'table', head, rows });
    } else if (i === 0) blocks.push({ type: 'h1', parts: [{ text: line }] });
    else blocks.push({ type: 'p', parts: [{ text: line }] });
  }
  return blocks;
}

module.exports = { agreementPdf, textBlocks };

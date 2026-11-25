'use strict';

// Page layout for the bank's PDFs (D-110): A4 with 20 mm margins, Source Sans 3 embedded
// (full Latin coverage, so Swahili and any name print as written), the LFB letterhead on
// page 1, a small logo header on the pages after it, and a footer on every page in the
// document's language. Content is laid out as "chunks" of lines so that a heading is kept
// with at least the first two lines that follow it and no paragraph leaves a single line
// alone at the bottom or top of a page.

const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');
const { PDFDocument, rgb } = require('pdf-lib');

const MM = 72 / 25.4;
const A4 = [595.28, 841.89];
const MARGIN = 20 * MM;
const WIDTH = A4[0] - MARGIN * 2;
const BODY = 10;
const LEADING = BODY * 1.35;

const COLOR = {
  ink: rgb(0.106, 0.106, 0.106),
  muted: rgb(0.42, 0.42, 0.4),
  brand: rgb(1, 0.761, 0.055), // LFB yellow #FFC20E: rules and accents
  heading: rgb(0.478, 0.353, 0), // dark gold #7A5A00: headings, readable on white
  shade: rgb(0.976, 0.965, 0.925), // light row shading #F9F6EC
  line: rgb(0.85, 0.84, 0.8),
};

const ASSETS = path.join(__dirname, '..', '..', '..', 'assets', 'agreement');
const fontBytes = {};
const readFont = (name) => {
  fontBytes[name] = fontBytes[name] || fs.readFileSync(path.join(ASSETS, 'fonts', `SourceSans3-${name}.ttf`));
  return fontBytes[name];
};

const BANK = {
  name: 'Letshego Faidika Bank Limited',
  address: { en: ['P.O. Box 34459, Dar es Salaam', 'United Republic of Tanzania'], sw: ['S.L.P. 34459, Dar es Salaam', 'Jamhuri ya Muungano wa Tanzania'] },
};

// Control characters cannot be printed: they become spaces.
const clean = (s) => [...String(s ?? '')].map((c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('');

/** Splits parts into words with their font, keeping where spaces were. */
function tokens(parts, fonts, { bold = false } = {}) {
  const out = [];
  for (const part of parts) {
    const font = bold || part.strong ? fonts.bold : part.semibold ? fonts.semibold : fonts.regular;
    clean(part.text).split(/(\s+)/).forEach((w) => {
      if (!w) return;
      if (/^\s+$/.test(w)) out.push({ space: true });
      else out.push({ text: w, font });
    });
  }
  return out;
}

/** Wraps parts to a width: lines of segments { text, font, dx }. */
function wrap(parts, fonts, size, width, opts) {
  const lines = [];
  let line = [];
  let w = 0;
  let pending = false;
  for (const t of tokens(parts, fonts, opts)) {
    if (t.space) {
      pending = line.length > 0;
      continue;
    }
    const space = pending ? t.font.widthOfTextAtSize(' ', size) : 0;
    const tw = t.font.widthOfTextAtSize(t.text, size);
    if (line.length && w + space + tw > width) {
      lines.push(line);
      line = [{ text: t.text, font: t.font, dx: 0 }];
      w = tw;
    } else {
      line.push({ text: t.text, font: t.font, dx: w + space });
      w += space + tw;
    }
    pending = false;
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

const widthOf = (segs, size) => (segs.length ? segs.at(-1).dx + segs.at(-1).font.widthOfTextAtSize(segs.at(-1).text, size) : 0);

class Layout {
  /**
   * opts: { language, title (PDF metadata), header (text on pages after the first),
   *         footerLeft, logo (PNG/JPG bytes), pageLabel(i, n) }
   */
  static async create(opts) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setTitle(opts.title);
    doc.setProducer('LFB Staff Loans');
    doc.setCreator('LFB Staff Loans');
    doc.setCreationDate(opts.createdAt || new Date());
    doc.setModificationDate(opts.createdAt || new Date());
    const fonts = {
      regular: await doc.embedFont(readFont('Regular'), { subset: true }),
      semibold: await doc.embedFont(readFont('Semibold'), { subset: true }),
      bold: await doc.embedFont(readFont('Bold'), { subset: true }),
    };
    let logo = null;
    if (opts.logo) {
      const isPng = opts.logo[0] === 0x89 && opts.logo[1] === 0x50;
      logo = isPng ? await doc.embedPng(opts.logo) : await doc.embedJpg(opts.logo);
    }
    return new Layout(doc, fonts, logo, opts);
  }

  constructor(doc, fonts, logo, opts) {
    Object.assign(this, { doc, fonts, logo, opts, page: null, y: 0, chunks: [], margin: MARGIN });
  }

  // ---------- pages ----------

  newPage() {
    this.page = this.doc.addPage(A4);
    const first = this.doc.getPageCount() === 1;
    const top = A4[1] - MARGIN;
    const lang = this.opts.language === 'en' ? 'en' : 'sw';
    if (first) {
      // Letterhead: logo top left, the bank's legal name and address top right, a brand rule.
      if (this.logo) {
        const h = 30;
        const w = Math.min(190, (this.logo.width / this.logo.height) * h);
        this.page.drawImage(this.logo, { x: MARGIN, y: top - h, width: w, height: (w / this.logo.width) * this.logo.height });
      }
      const lines = [[BANK.name, this.fonts.bold, 9.5], ...BANK.address[lang].map((l) => [l, this.fonts.regular, 8.5])];
      let ly = top - 9;
      for (const [t, f, s] of lines) {
        this.page.drawText(t, { x: A4[0] - MARGIN - f.widthOfTextAtSize(t, s), y: ly, size: s, font: f, color: COLOR.ink });
        ly -= s + 3;
      }
      const ruleY = top - 42;
      this.page.drawLine({ start: { x: MARGIN, y: ruleY }, end: { x: A4[0] - MARGIN, y: ruleY }, thickness: 1.2, color: COLOR.brand });
      this.y = ruleY - 16;
    } else {
      if (this.logo) {
        const h = 13;
        const w = (this.logo.width / this.logo.height) * h;
        this.page.drawImage(this.logo, { x: MARGIN, y: top - h, width: w, height: h });
      }
      const t = this.opts.header || '';
      this.page.drawText(t, { x: A4[0] - MARGIN - this.fonts.regular.widthOfTextAtSize(t, 8.5), y: top - 10, size: 8.5, font: this.fonts.regular, color: COLOR.muted });
      const ruleY = top - 20;
      this.page.drawLine({ start: { x: MARGIN, y: ruleY }, end: { x: A4[0] - MARGIN, y: ruleY }, thickness: 0.6, color: COLOR.brand });
      this.y = ruleY - 14;
    }
    this.atTop = true;
  }

  bottom() {
    return MARGIN + 8;
  }

  // ---------- lines ----------

  /** A wrapped text line set: lines of { h, draw(page, yTop) } for parts at an x offset. */
  textLines(parts, { size = BODY, leading, x = 0, width = WIDTH - x, bold = false, color = COLOR.ink, center = false, align = 'left', first } = {}) {
    const lead = leading || size * 1.35;
    const wrapped = wrap(parts, this.fonts, size, width, { bold });
    return wrapped.map((segs, i) => ({
      h: lead,
      draw: (page, yTop) => {
        const base = yTop - lead + (lead - size) / 2 + size * 0.22;
        const lw = widthOf(segs, size);
        const x0 = MARGIN + x + (center ? (width - lw) / 2 : align === 'right' ? width - lw : 0);
        segs.forEach((s) => page.drawText(s.text, { x: x0 + s.dx, y: base, size, font: s.font, color }));
        if (i === 0 && first) first(page, yTop, base);
      },
    }));
  }

  /** Adds a chunk: { lines, before, after, keepWithNext, together, header (repeated table head) }. */
  add(chunk) {
    this.chunks.push({ before: 0, after: 0, ...chunk });
  }

  space(chunk) {
    return this.atTop ? 0 : chunk.before;
  }

  drawLine(line) {
    line.draw(this.page, this.y);
    this.y -= line.h;
    this.atTop = false;
  }

  fits(h) {
    return this.y - h >= this.bottom();
  }

  /** Lays the chunks out on pages. */
  flow() {
    if (!this.page) this.newPage();
    const chunks = this.chunks;
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      if (c.pageBreak) {
        this.newPage();
        continue;
      }
      if (c.keepWithNext) {
        // A heading stays with at least the first two lines of what follows it.
        const next = chunks[i + 1];
        const need = this.space(c) + c.lines.reduce((s, l) => s + l.h, 0) + (next ? next.before + next.lines.slice(0, 2).reduce((s, l) => s + l.h, 0) : 0);
        if (!this.fits(need) && !this.atTop) this.newPage();
      }
      this.y -= this.space(c);
      this.placeLines(c, c.lines);
      this.y -= c.after;
    }
  }

  placeLines(c, lines) {
    const n = lines.length;
    let fit = 0;
    let h = 0;
    while (fit < n && this.y - (h + lines[fit].h) >= this.bottom()) {
      h += lines[fit].h;
      fit += 1;
    }
    if (fit >= n) {
      lines.forEach((l) => this.drawLine(l));
      return;
    }
    const together = c.together || n <= 3;
    if (this.atTop) fit = Math.max(fit, 1); // a block taller than a page still has to go somewhere
    else if (together || fit < 2) {
      this.newPage();
      if (c.header) c.header.forEach((l) => this.drawLine(l));
      this.placeLines({ ...c, together: false }, lines);
      return;
    } else if (!c.rows && n - fit < 2) fit = n - 2; // no single line left alone on the next page
    lines.slice(0, fit).forEach((l) => this.drawLine(l));
    this.newPage();
    if (c.header) c.header.forEach((l) => this.drawLine(l));
    this.placeLines({ ...c, together: false }, lines.slice(fit));
  }

  /** Draws the footer on every page and returns the PDF bytes. */
  async save() {
    const pages = this.doc.getPages();
    const lang = this.opts.language === 'en' ? 'en' : 'sw';
    const pageText = (i, total) => (lang === 'en' ? `Page ${i} of ${total}` : `Ukurasa ${i} kati ya ${total}`);
    pages.forEach((p, i) => {
      const y = MARGIN - 16;
      p.drawLine({ start: { x: MARGIN, y: y + 11 }, end: { x: A4[0] - MARGIN, y: y + 11 }, thickness: 0.4, color: COLOR.line });
      const left = this.opts.footerLeft || '';
      p.drawText(left, { x: MARGIN, y, size: 8, font: this.fonts.regular, color: COLOR.muted });
      const right = pageText(i + 1, pages.length);
      p.drawText(right, { x: A4[0] - MARGIN - this.fonts.regular.widthOfTextAtSize(right, 8), y, size: 8, font: this.fonts.regular, color: COLOR.muted });
    });
    return Buffer.from(await this.doc.save({ useObjectStreams: false }));
  }
}

module.exports = { Layout, A4, MARGIN, WIDTH, BODY, LEADING, COLOR, ASSETS, wrap };

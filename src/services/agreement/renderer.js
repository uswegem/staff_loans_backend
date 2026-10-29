'use strict';

// Renders the Swahili agreement template into blocks the web app shows and the PDF
// prints, and into the canonical text whose SHA-256 is the acceptance evidence
// (FR-33, FR-35, DECISIONS D-11).
//
// Template syntax, one block per line:
//   # Title            ## Heading           ~ small centred note
//   1. Numbered item   - Plain list item    {{schedule}} alone on a line: the Jedwali
//   anything else      a paragraph
// {{key}} inserts a value; filled values are marked so they can be highlighted.

const crypto = require('crypto');

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Splits a line into parts, replacing placeholders. A value may be a string or parts. */
function fill(line, values) {
  const parts = [];
  let last = 0;
  for (const m of line.matchAll(PLACEHOLDER)) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index) });
    const v = values[m[1]];
    if (v === undefined) throw new Error(`Agreement template uses an unknown value {{${m[1]}}}`);
    if (Array.isArray(v)) parts.push(...v);
    else parts.push({ text: String(v), fill: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts;
}

/** Turns a sentence with {{keys}} into parts (used for clauses built in code). */
const sentence = (text, values) => fill(text, values);

const plain = (parts) => parts.map((p) => p.text).join('');

/**
 * template: the template body; values: placeholder values; schedule: { head, rows }.
 * Returns { blocks, text, textSha256 }.
 */
function render(template, values, schedule) {
  const blocks = [];
  for (const raw of template.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '{{schedule}}') {
      blocks.push({ type: 'table', head: schedule.head, rows: schedule.rows });
    } else if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', parts: fill(line.slice(3), values) });
    } else if (line.startsWith('# ')) {
      blocks.push({ type: 'h1', parts: fill(line.slice(2), values) });
    } else if (line.startsWith('~ ')) {
      blocks.push({ type: 'note', parts: fill(line.slice(2), values) });
    } else if (/^\d+\.\s/.test(line)) {
      const prev = blocks.at(-1);
      const item = fill(line.replace(/^\d+\.\s+/, ''), values);
      if (prev && prev.type === 'ol') prev.items.push(item);
      else blocks.push({ type: 'ol', items: [item] });
    } else if (line.startsWith('- ')) {
      const prev = blocks.at(-1);
      const item = fill(line.slice(2), values);
      if (prev && prev.type === 'ul') prev.items.push(item);
      else blocks.push({ type: 'ul', items: [item] });
    } else {
      blocks.push({ type: 'p', parts: fill(line, values) });
    }
  }
  const text = canonicalText(blocks);
  return { blocks, text, textSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** The exact text that is hashed and stored: one line per heading, paragraph, item and table row. */
function canonicalText(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b.type === 'ol') b.items.forEach((it, i) => lines.push(`${i + 1}. ${plain(it)}`));
    else if (b.type === 'ul') b.items.forEach((it) => lines.push(`- ${plain(it)}`));
    else if (b.type === 'table') {
      lines.push(b.head.join('\t'));
      b.rows.forEach((r) => lines.push(r.join('\t')));
    } else lines.push(plain(b.parts));
  }
  return lines.join('\n');
}

module.exports = { render, sentence, canonicalText, plain };

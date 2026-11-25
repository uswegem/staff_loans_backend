'use strict';

// Renders the Swahili agreement template into blocks the web app shows and the PDF
// prints, and into the canonical text whose SHA-256 is the acceptance evidence
// (FR-33, FR-35, DECISIONS D-11).
//
// Template syntax, one block per line:
//   # Title            ## Heading           ~ small centred note
//   1. Numbered item   - Plain list item    {{schedule}} alone on a line: the Jedwali
//   [ ] Declaration    a statement the staff member ticks before signing
//   anything else      a paragraph
// A line whose only content was a value that is not known (null) is left out.
// {{key}} inserts a value; filled values are marked so they can be highlighted. A value given
// as parts may mark a part strong (shown in bold, e.g. the Employee's name in the parties).
// Bold is presentation only: the canonical text and its SHA-256 are the plain words.

const crypto = require('crypto');

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

// Words that only introduce a party detail ("wa {{poBox}}", "simu {{mobile}}"): left out with it.
const LEADS = ['wa', 'simu', 'ya', 'of', 'phone'];

/**
 * A value set to null is not known: its placeholder goes, with the word that introduces it
 * and the comma after it, so the text never shows an empty value or a dash.
 */
function omitMissing(line, values) {
  let out = line;
  for (const [key, v] of Object.entries(values)) {
    if (v !== null || !out.includes(`{{${key}}}`)) continue;
    out = out.replace(new RegExp(`(?:\\s+(?:${LEADS.join('|')}))?\\s*\\{\\{${key}\\}\\}\\s*,?`, 'g'), '');
  }
  return out === line ? line : out.replace(/\s+,/g, ',').replace(/,\s*\(/g, ' (').replace(/\s{2,}/g, ' ');
}

/** Splits a line into parts, replacing placeholders. A value may be a string or parts. */
function fill(raw, values) {
  const line = omitMissing(raw, values);
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
    } else if (line.startsWith('[ ] ')) {
      blocks.push({ type: 'declaration', parts: fill(line.slice(4), values) });
    } else if (line.startsWith('~ ')) {
      blocks.push({ type: 'note', parts: fill(line.slice(2), values) });
    } else if (/^\d+\.\s/.test(line)) {
      const prev = blocks.at(-1);
      const item = fill(line.replace(/^\d+\.\s+/, ''), values);
      if (!plain(item).trim()) continue;
      if (prev && prev.type === 'ol') prev.items.push(item);
      else blocks.push({ type: 'ol', items: [item] });
    } else if (line.startsWith('- ')) {
      const prev = blocks.at(-1);
      const item = fill(line.slice(2), values);
      if (!plain(item).trim()) continue;
      if (prev && prev.type === 'ul') prev.items.push(item);
      else blocks.push({ type: 'ul', items: [item] });
    } else {
      const parts = fill(line, values);
      if (plain(parts).trim()) blocks.push({ type: 'p', parts });
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
    else if (b.type === 'declaration') lines.push(`[ ] ${plain(b.parts)}`);
    else if (b.type === 'table') {
      lines.push(b.head.join('\t'));
      b.rows.forEach((r) => lines.push(r.join('\t')));
    } else lines.push(plain(b.parts));
  }
  return lines.join('\n');
}

/** The statements a template asks the staff member to tick, in order, as plain text. */
const declarationsOf = (blocks) => blocks.filter((b) => b.type === 'declaration').map((b) => plain(b.parts));

/** True when every declaration of the agreement was ticked: one true per declaration, in order. */
const allDeclared = (blocks, ticked) => {
  const n = declarationsOf(blocks).length;
  return Array.isArray(ticked) && ticked.length === n && ticked.every((v) => v === true);
};

module.exports = { render, sentence, canonicalText, plain, declarationsOf, allDeclared };

'use strict';

// Renders an agreement template into blocks the web app shows and the PDF prints, and into
// the canonical text whose SHA-256 is the acceptance evidence (FR-33, FR-35, D-11).
//
// Two markups exist. Templates written before D-110 ("legacy") keep rendering exactly as
// they were signed. A template that uses any of the numbered markup below is "numbered"
// (D-110), and the numbers are worked out by the renderer, never typed:
//
//   # Title              ~ small centred note        [ ] declaration the staff member ticks
//   ## Heading           a numbered section: 1., 2., 3. ...
//   ##* Heading          an unnumbered section (Loan Details, Signatures)
//   + Clause text        a numbered clause in the current section: 1.1, 1.2 ...
//   (a) Sub-clause       a lettered sub-clause of the current clause: (a), (b) ... in order
//   - Bullet             a bullet (under a clause it is indented with the clause)
//   | Label | Value      a row of a two-column details table (the Loan Details)
//   anything else        a paragraph
//
// A heading, clause or sub-clause may carry a label: "+ {#salary-deduction} Salary deduction: ..."
// {{ref:salary-deduction}} prints "clause 4.2" ("kifungu 4.2" in Swahili) and
// {{num:salary-deduction}} the bare "4.2", so renumbering never breaks a cross-reference.
// An unknown or repeated label is refused. {{schedule}} is refused: the repayment schedule
// is not part of the agreement (D-110); it is given on request.
//
// {{key}} inserts a value; filled values are marked so they can be highlighted. A value given
// as parts may mark a part strong (bold). A line whose only content was a value that is not
// known (null) is left out. Bold is presentation only: the canonical text is the plain words.

const crypto = require('crypto');

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const REF = /\{\{(ref|num):([a-z0-9][a-z0-9-]*)\}\}/g;
const LABEL = /^\{#([a-z0-9][a-z0-9-]*)\}\s*/;
const SUB = /^\(([a-z]{1,3}|[ivx]{1,5})\)\s+/;
const NUMBERED_MARKUP = /^\s*(\+ |##\* |\| )|\{\{(ref|num):/m;

// Words that only introduce a party detail ("wa {{poBox}}", "simu {{mobile}}"): left out with it.
const LEADS = ['wa', 'simu', 'ya', 'of', 'phone'];

/** True when the template uses the numbered markup (D-110). */
const isNumbered = (template) => NUMBERED_MARKUP.test(String(template || ''));

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

// ---------- legacy markup (agreements signed before D-110 keep their text and fingerprint) ----------

function renderLegacy(template, values) {
  const blocks = [];
  const lines = template.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // D-110: the schedule is no longer part of an agreement; an older template's schedule
    // heading goes with it.
    if (line === '{{schedule}}') continue;
    if (line.startsWith('## ') && lines[i + 1] === '{{schedule}}') continue;
    if (line.startsWith('## ')) {
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
  return blocks;
}

/** The exact text hashed for a legacy agreement: one line per heading, paragraph, item and table row. */
function legacyText(blocks) {
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

// ---------- numbered markup (D-110) ----------

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const letter = (i) => (i < 26 ? LETTERS[i] : LETTERS[Math.floor(i / 26) - 1] + LETTERS[i % 26]);
const REF_WORD = { en: 'clause', sw: 'kifungu' };

/** Splits off a {#label}; returns [label|null, rest]. */
function takeLabel(text) {
  const m = text.match(LABEL);
  return m ? [m[1], text.slice(m[0].length)] : [null, text];
}

/**
 * First pass: the line kinds and numbers, and the number of every label. Throws on a
 * repeated label, a clause before any numbered section, or a sub-clause outside a clause.
 */
function outline(lines) {
  const items = [];
  const labels = new Map();
  let section = 0;
  let clause = 0;
  let sub = 0;
  let inNumbered = false;
  let lastClause = null;
  const label = (name, number) => {
    if (!name) return;
    if (labels.has(name)) throw new Error(`The text uses the label {#${name}} twice.`);
    labels.set(name, number);
  };
  for (const raw of lines) {
    let line = raw;
    if (line.startsWith('##* ')) {
      inNumbered = false;
      lastClause = null;
      const [name, text] = takeLabel(line.slice(4));
      if (name) throw new Error(`An unnumbered heading cannot carry a label ({#${name}}).`);
      items.push({ kind: 'h2', number: null, text });
    } else if (line.startsWith('## ')) {
      section += 1;
      clause = 0;
      inNumbered = true;
      lastClause = null;
      const [name, text] = takeLabel(line.slice(3));
      label(name, String(section));
      items.push({ kind: 'h2', number: `${section}.`, ref: String(section), text });
    } else if (line.startsWith('+ ')) {
      if (!inNumbered) throw new Error(`A numbered clause must follow a numbered heading: "${line.slice(0, 60)}".`);
      clause += 1;
      sub = 0;
      const [name, text] = takeLabel(line.slice(2));
      const number = `${section}.${clause}`;
      label(name, number);
      lastClause = number;
      items.push({ kind: 'clause', number, text });
    } else if (SUB.test(line)) {
      if (!lastClause) throw new Error(`A lettered sub-clause must follow a numbered clause: "${line.slice(0, 60)}".`);
      line = line.replace(SUB, '');
      const [name, text] = takeLabel(line);
      const l = letter(sub);
      sub += 1;
      label(name, `${lastClause}(${l})`);
      items.push({ kind: 'sub', number: `(${l})`, text });
    } else {
      items.push({ kind: 'line', text: line, underClause: !!lastClause });
    }
  }
  return { items, labels };
}

/** Replaces {{ref:x}} and {{num:x}}; an unknown label is refused. */
function resolveRefs(text, labels, language) {
  return text.replace(REF, (m, kind, name) => {
    if (!labels.has(name)) throw new Error(`The text refers to an unknown label {{${kind}:${name}}}.`);
    const n = labels.get(name);
    return kind === 'num' ? n : `${REF_WORD[language] || REF_WORD.en} ${n}`;
  });
}

// Presentation only (bold), never part of the text: defined terms at their definition
// ('"Loan" means', '(the "Bank")') and a clause's run-in heading ("Salary deduction:").
const DEFINED = /("[^"]{1,60}")(?=\s+means\b|\s+maana\s+yake\b)|(\(the\s+|\(hapa\s+(?:inajulikana|anajulikana)\s+kama\s+)("[^"]{1,60}")/g;

function emphasise(parts, { runIn = false } = {}) {
  const out = [];
  let first = true;
  for (const p of parts) {
    if (p.fill || p.strong) {
      out.push(p);
      first = false;
      continue;
    }
    let text = p.text;
    if (runIn && first) {
      const m = text.match(/^([A-ZÀ-ɏ][^:.;]{1,48}):\s/);
      if (m && m[1].split(/\s+/).length <= 6) {
        out.push({ text: `${m[1]}:`, strong: true });
        text = text.slice(m[1].length + 1);
      }
    }
    first = false;
    let last = 0;
    for (const m of text.matchAll(DEFINED)) {
      const quoted = m[1] || m[3];
      const at = m.index + (m[1] ? 0 : m[2].length);
      if (at > last) out.push({ text: text.slice(last, at) });
      out.push({ text: quoted, strong: true });
      last = at + quoted.length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
  }
  return out.filter((p) => p.text !== '');
}

function renderNumbered(template, values, language) {
  const lines = template.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l.includes('{{schedule}}'))) throw new Error('The repayment schedule is not part of the agreement. Remove {{schedule}} and its heading: staff get the schedule on request from Operations or Credit.');
  const { items, labels } = outline(lines);
  const blocks = [];
  const parts = (text, opts) => emphasise(fill(resolveRefs(text, labels, language), values), opts);
  for (const it of items) {
    if (it.kind === 'h2') blocks.push({ type: 'h2', number: it.number, parts: fill(resolveRefs(it.text, labels, language), values) });
    else if (it.kind === 'clause') blocks.push({ type: 'clause', number: it.number, parts: parts(it.text, { runIn: true }) });
    else if (it.kind === 'sub') blocks.push({ type: 'sub', number: it.number, parts: parts(it.text) });
    else {
      const line = it.text;
      if (line.startsWith('# ')) blocks.push({ type: 'h1', parts: fill(line.slice(2), values) });
      else if (line.startsWith('~ ')) blocks.push({ type: 'note', parts: fill(line.slice(2), values) });
      else if (line.startsWith('[ ] ')) blocks.push({ type: 'declaration', parts: fill(resolveRefs(line.slice(4), labels, language), values) });
      else if (line.startsWith('| ')) {
        const cells = line.slice(2).replace(/\|\s*$/, '').split(' | ');
        if (cells.length !== 2) throw new Error(`A details row needs a label and a value: "${line.slice(0, 60)}".`);
        const value = fill(resolveRefs(cells[1].trim(), labels, language), values);
        if (!plain(value).trim()) continue;
        const row = { label: fill(cells[0].trim(), values), value };
        const prev = blocks.at(-1);
        if (prev && prev.type === 'details') prev.rows.push(row);
        else blocks.push({ type: 'details', rows: [row] });
      } else if (line.startsWith('- ')) {
        const item = parts(line.slice(2));
        if (!plain(item).trim()) continue;
        const level = it.underClause ? 1 : 0;
        const prev = blocks.at(-1);
        if (prev && prev.type === 'ul' && prev.level === level) prev.items.push(item);
        else blocks.push({ type: 'ul', level, items: [item] });
      } else {
        const p = parts(line);
        if (plain(p).trim()) blocks.push({ type: 'p', parts: p });
      }
    }
  }
  return blocks;
}

/**
 * The canonical text of a numbered agreement (format 2): one line per block or item, with
 * its number and a marker for its kind, so the text alone carries the structure and the
 * fingerprint covers the numbering, the sections and the Loan Details table.
 */
function numberedText(blocks) {
  const lines = [];
  for (const b of blocks) {
    const t = b.parts ? plain(b.parts) : '';
    if (b.type === 'h1') lines.push(`# ${t}`);
    else if (b.type === 'note') lines.push(`~ ${t}`);
    else if (b.type === 'h2') lines.push(b.number ? `## ${b.number} ${t}` : `##* ${t}`);
    else if (b.type === 'clause') lines.push(`${b.number} ${t}`);
    else if (b.type === 'sub') lines.push(`  ${b.number} ${t}`);
    else if (b.type === 'ul') b.items.forEach((it) => lines.push(`${'  '.repeat(b.level || 0)}- ${plain(it)}`));
    else if (b.type === 'details') b.rows.forEach((r) => lines.push(`| ${plain(r.label)} | ${plain(r.value)}`));
    else if (b.type === 'declaration') lines.push(`[ ] ${t}`);
    else if (b.type === 'ol') b.items.forEach((it, i) => lines.push(`${i + 1}. ${plain(it)}`));
    else if (b.type === 'table') {
      lines.push(b.head.join('\t'));
      b.rows.forEach((r) => lines.push(r.join('\t')));
    } else lines.push(t);
  }
  return lines.join('\n');
}

/** The canonical text for blocks of either format. */
const canonicalText = (blocks, format = 1) => (format === 2 ? numberedText(blocks) : legacyText(blocks));

/**
 * template: the template body; values: placeholder values; options: { language }.
 * Returns { blocks, text, textSha256, format } (format 2: numbered, D-110; 1: legacy).
 */
function render(template, values, options = {}) {
  const language = options.language || 'sw';
  const numbered = isNumbered(template);
  const blocks = numbered ? renderNumbered(template, values, language) : renderLegacy(template, values);
  const format = numbered ? 2 : 1;
  const text = canonicalText(blocks, format);
  return { blocks, text, textSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), format };
}

/** The statements a template asks the staff member to tick, in order, as plain text. */
const declarationsOf = (blocks) => blocks.filter((b) => b.type === 'declaration').map((b) => plain(b.parts));

/** True when every declaration of the agreement was ticked: one true per declaration, in order. */
const allDeclared = (blocks, ticked) => {
  const n = declarationsOf(blocks).length;
  return Array.isArray(ticked) && ticked.length === n && ticked.every((v) => v === true);
};

module.exports = { render, sentence, canonicalText, plain, declarationsOf, allDeclared, isNumbered };

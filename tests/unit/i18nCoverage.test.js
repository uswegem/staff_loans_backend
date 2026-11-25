'use strict';

// D-109: one language at a time. Every message the API writes for people has a Swahili
// entry, and every entry is complete in both languages. This fails CI when a message is
// added in English only (or an entry has lost one of its languages).

const fs = require('fs');
const path = require('path');
const CATALOGUE = require('../../src/i18n/sw');
const { translate, identify, render } = require('../../src/i18n');

const ROOT = path.join(__dirname, '../../src');

// Not shown to people in the app, or not API messages:
const SKIP = [
  /^config\//, // start-up logs and the API description for developers
  /^i18n\//, // the catalogue itself
  /^services\/agreement\//, // agreement text is Legal's, in the template's language
  /^services\/consent\/dataProtection\.js$/, // the notice is Legal's text, kept per language
  /^models\/plugins\/appendOnly\.js$/, // a programming guard, never reached from a request
  /^services\/staff\/staffImportService\.js$/, // notes inside the downloadable English import template
  /^scripts\//,
];

/** String literals in a source file, with comments removed first. */
function literals(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  return [...src.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

/** A literal that reads as a sentence for people: capital or value first, a space, a full stop. */
function sentenceOf(lit) {
  let s = lit.slice(1, -1);
  if (lit[0] === '`') s = s.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, 'Value');
  s = s.replace(/\\'/g, "'").replace(/\\"/g, '"');
  if (!/^[A-Z]/.test(s) || !s.includes(' ') || !/[.?!]$/.test(s)) return null;
  return s;
}

describe('i18n coverage (D-109)', () => {
  it('every catalogue entry has a unique code and both languages', () => {
    const codes = new Set();
    const problems = [];
    for (const entry of CATALOGUE) {
      const [code, en, sw] = entry;
      if (entry.length !== 3 || !/^[A-Z][A-Z0-9_]*$/.test(code)) problems.push(`bad entry ${JSON.stringify(entry)}`);
      if (codes.has(code)) problems.push(`duplicate code ${code}`);
      codes.add(code);
      if (!en || !en.trim()) problems.push(`${code}: no English`);
      if (!sw || !sw.trim()) problems.push(`${code}: no Swahili`);
      // The same placeholders in both languages.
      const names = (t) => (t.match(/\{\w+\}/g) || []).sort().join(',');
      if (en && sw && names(en) !== names(sw)) problems.push(`${code}: placeholders differ`);
    }
    expect(problems).toEqual([]);
  });

  it('every English message in the API source has a Swahili entry', () => {
    const missing = [];
    for (const file of files(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (SKIP.some((re) => re.test(rel))) continue;
      for (const lit of literals(file)) {
        const s = sentenceOf(lit);
        if (!s) continue;
        if (!identify(s)) missing.push(`${rel}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('codes and params render the same message in each language', () => {
    const id = identify('SL-2026-00001 went back to Credit Analyst review.');
    expect(id.code).toBeTruthy();
    expect(render(id.code, id.params, 'en')).toBe('SL-2026-00001 went back to Credit Analyst review.');
    expect(render(id.code, id.params, 'sw')).toBe(translate('SL-2026-00001 went back to Credit Analyst review.', 'sw'));
    expect(render(id.code, id.params, 'sw')).not.toMatch(/went back/);
  });
});

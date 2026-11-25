'use strict';

// Requirement and decision codes such as (BR-10), (FR-04) or (D-88) belong in code
// comments and the API docs, never in text people read (UX review #10).

const fs = require('fs');
const path = require('path');
const SW = require('../../src/i18n/sw');
const { DEFAULT_ROLES } = require('../../src/constants/systemRoles');

const CODE = /\((?:[^()]*\b)?(?:D|BR|FR|NFR|NS|RP)-\d+/;

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

describe('no internal codes in user-facing text', () => {
  it('Swahili and English message pairs', () => {
    SW.forEach(([, en, sw]) => {
      expect([en, CODE.test(en)]).toEqual([en, false]);
      expect([sw, CODE.test(sw)]).toEqual([sw, false]);
    });
  });

  it('role descriptions', () => {
    DEFAULT_ROLES.forEach((r) => expect([r.code, CODE.test(r.description)]).toEqual([r.code, false]));
  });

  it('messages written by services, controllers and middleware (route files hold API docs)', () => {
    const root = path.join(__dirname, '../../src');
    const found = ['services', 'controllers', 'middleware', 'constants']
      .flatMap((d) => files(path.join(root, d)))
      .flatMap((f) => literals(f).filter((s) => CODE.test(s)).map((s) => `${path.relative(root, f)}: ${s}`));
    expect(found).toEqual([]);
  });
});

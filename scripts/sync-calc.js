'use strict';

/* eslint-disable no-console */
// Generates the web app's copy of the loan calculator (PLAN 1a): one calculation for
// the API and the live calculator. Run `npm run calc:sync` after changing it;
// `npm run calc:check` fails when the copy is stale.

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '../src/services/calc/loanCalculator.js');
const TARGET = path.join(__dirname, '../../staff_loans_frontend/src/lib/calc/loanCalculator.js');

function generate() {
  const src = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const exportsMatch = src.match(/module\.exports = \{([^}]+)\};\n?$/);
  if (!exportsMatch) throw new Error('loanCalculator.js must end with module.exports = { ... };');
  const body = src
    .replace(/^'use strict';\n\n/, '')
    .replace(/module\.exports = \{([^}]+)\};\n?$/, `export {$1};\n`);
  return `// GENERATED from staff_loans_backend/src/services/calc/loanCalculator.js by\n// scripts/sync-calc.js. Do not edit here: change the backend file and run npm run calc:sync.\n\n${body}`;
}

const out = generate();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== out) {
    console.error('The frontend calculator copy is out of date. Run npm run calc:sync.');
    process.exit(1);
  }
  console.log('Calculator copies match.');
} else {
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, out);
  console.log(`Wrote ${path.relative(process.cwd(), TARGET)}`);
}

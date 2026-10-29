'use strict';

// Prompt 4.4: products are data, not code. Nothing under src/ may branch on a product
// code or name; only the seed knows the launch products.

const fs = require('fs');
const path = require('path');
const { PRODUCTS } = require('../../seed/products');

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

describe('no code branches on a product', () => {
  const sources = filesUnder(path.join(__dirname, '../../src')).map((f) => [f, fs.readFileSync(f, 'utf8')]);

  it.each(PRODUCTS.map((p) => [p.code, p.name]))('%s / %s does not appear in src/', (code, name) => {
    const offenders = sources.filter(([, text]) => new RegExp(`['"\`]${code}['"\`]`).test(text) || text.includes(name)).map(([f]) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});

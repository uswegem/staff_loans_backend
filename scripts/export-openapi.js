'use strict';

// Writes openapi.json from the route annotations (the API contract the frontend follows).
const fs = require('fs');
const path = require('path');
const spec = require('../src/config/swagger');

fs.writeFileSync(path.join(__dirname, '..', 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`openapi.json written: ${Object.keys(spec.paths).length} paths`);

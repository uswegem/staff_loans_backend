'use strict';

const fs = require('fs');
const { runDir } = require('./testDirs');

module.exports = async function globalTeardown() {
  if (globalThis.__MONGO_REPLSET__) await globalThis.__MONGO_REPLSET__.stop({ doCleanup: true, force: true });
  // The database files, uploads and data-reset backups of this run.
  fs.rmSync(runDir(), { recursive: true, force: true });
};

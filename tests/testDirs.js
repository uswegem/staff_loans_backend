'use strict';

// Everything a test run writes to disk (the in-memory database, uploads and the data
// reset's backups) goes under one folder per run, removed when the run ends. Folders
// left by runs that were stopped early are removed by the next run.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.tmpdir(), 'slas-test');
const STALE_MS = 6 * 3600 * 1000;

/** This run's folder; the workers inherit it from globalSetup through the environment. */
const runDir = () => process.env.SLAS_TEST_RUN_DIR || path.join(ROOT, `run-${process.pid}`);

/** Removes run folders older than six hours: left by runs that did not finish. */
function removeStale() {
  if (!fs.existsSync(ROOT)) return;
  for (const name of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // In use by another run: leave it.
    }
  }
}

module.exports = { ROOT, runDir, removeStale };

'use strict';

// One in-memory MongoDB replica set for the whole run, so transactions work as in production.
// Its data files live in this run's folder (tests/testDirs.js), removed at teardown.

const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { runDir, removeStale } = require('./testDirs');

module.exports = async function globalSetup() {
  removeStale();
  const dir = runDir();
  process.env.SLAS_TEST_RUN_DIR = dir;
  const dbPath = path.join(dir, 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ dbPath }] });
  globalThis.__MONGO_REPLSET__ = replSet;
  process.env.SLAS_TEST_MONGO_URI = replSet.getUri();
};

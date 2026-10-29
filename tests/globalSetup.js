'use strict';

// One in-memory MongoDB replica set for the whole run, so transactions work as in production.

const { MongoMemoryReplSet } = require('mongodb-memory-server');

module.exports = async function globalSetup() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  globalThis.__MONGO_REPLSET__ = replSet;
  process.env.SLAS_TEST_MONGO_URI = replSet.getUri();
};

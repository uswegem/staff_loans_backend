'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

async function connect(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  // Workflow state changes need transactions, which need a replica set (prompt 3.3).
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) {
    logger.warn('MongoDB is not running as a replica set; transactions will fail. See README.');
  }
  return mongoose.connection;
}

/** Runs fn inside a transaction and retries on transient errors. */
async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { connect, withTransaction };

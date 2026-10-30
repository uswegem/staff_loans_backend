'use strict';

// API for the Playwright end-to-end runs (prompt 7, milestone 8). Starts an in-memory
// MongoDB replica set, seeds the prototype's sample data (all fictional) and serves
// the API over plain HTTP on E2E_API_PORT (default 4100). Nothing outside a temp
// folder is touched; everything is discarded when the process stops.
//
// Not for production: it uses throwaway secrets and turns off the Secure cookie flag
// so the browser keeps the refresh cookie on http://localhost.

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const PORT = Number(process.env.E2E_API_PORT || 4100);
const PASSWORD = process.env.E2E_PASSWORD || 'Sample#2026';

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  Object.assign(process.env, {
    NODE_ENV: 'e2e',
    PORT: String(PORT),
    MONGODB_URI: replSet.getUri('slas_e2e'),
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    MFA_ENC_KEY: crypto.randomBytes(32).toString('hex'),
    COOKIE_SECURE: 'false',
    LOGIN_RATE_LIMIT_PER_MIN: '1000',
    UPLOAD_DIR: path.join(os.tmpdir(), `slas-e2e-${process.pid}`),
  });

  const { config } = require('../src/config/env');
  const { connect } = require('../src/config/db');
  const { buildApp } = require('../src/app');
  const { seedFoundation } = require('../seed/foundation');
  const { seedProducts } = require('../seed/products');
  const { seedAgreementTemplate } = require('../seed/agreementTemplate');
  const { seedSampleApplications } = require('../seed/applications');
  const scheduler = require('../src/jobs/scheduler');

  await connect(config.mongoUri);
  const { users } = await seedFoundation({ password: PASSWORD });
  const products = await seedProducts(users);
  await seedAgreementTemplate(users);
  await seedSampleApplications({ users, products });
  const stopJobs = scheduler.start();

  const server = buildApp().listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`SLAS e2e API ready on http://localhost:${PORT}`);
  });

  const stop = async () => {
    stopJobs();
    server.close();
    await require('mongoose').disconnect();
    await replSet.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

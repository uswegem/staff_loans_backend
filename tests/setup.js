'use strict';

// Adapted from Ess-Backend/tests/setup.js (commit 522bdbd): tenant and CBS
// variables removed; uses the shared replica set started in globalSetup, with one
// database per test file; collections are cleared between tests.

const crypto = require('crypto');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-slas-unit-tests-only-0123456789';
process.env.MFA_ENC_KEY = process.env.MFA_ENC_KEY || 'a'.repeat(64);
process.env.BCRYPT_ROUNDS = '4';
process.env.LOGIN_RATE_LIMIT_PER_MIN = '1000';
// A developer's .env may turn Secure cookies off for http://localhost; tests use the default.
process.env.COOKIE_SECURE = 'true';
process.env.MONGODB_URI = process.env.SLAS_TEST_MONGO_URI;
// Uploads (and the data reset's backups next to them) go in this run's folder, removed at teardown.
process.env.UPLOAD_DIR = require('path').join(require('./testDirs').runDir(), 'uploads');
// Offline upload tests exercise content signatures without an antivirus scanner.

beforeAll(async () => {
  const dbName = `slas_test_${crypto.randomBytes(4).toString('hex')}`;
  // Generous timeouts: the in-memory mongod can stall briefly on a loaded Windows machine.
  await mongoose.connect(process.env.SLAS_TEST_MONGO_URI, { dbName, serverSelectionTimeoutMS: 60000, connectTimeoutMS: 60000, socketTimeoutMS: 120000, heartbeatFrequencyMS: 30000 });
  await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().then(() => m.syncIndexes())));
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

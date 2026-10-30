'use strict';

// Seeds a development database with the prototype's sample data (all fictional).
// Usage: SEED_PASSWORD=... npm run seed

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const { seedFoundation } = require('./foundation');
const { seedProducts } = require('./products');
const { seedAgreementTemplate } = require('./agreementTemplate');
const { seedSampleApplications } = require('./applications');

async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password) throw new Error('Set SEED_PASSWORD to the password every sample account should use.');
  await connect(config.mongoUri);
  const { users } = await seedFoundation({ password });
  const products = await seedProducts(users);
  await seedAgreementTemplate(users);
  const apps = await seedSampleApplications({ users, products });
  // eslint-disable-next-line no-console
  console.log(`Seeded ${Object.keys(users).length} sample accounts, ${Object.keys(products).length} products and ${apps} sample applications.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});

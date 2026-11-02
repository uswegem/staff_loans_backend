'use strict';

// Seeds the system data a new database needs: settings, public holidays, roles, launch
// pricing and the sample agreement template. It creates no people, no loan products and
// no applications (D-92): staff are loaded by `npm run reset:staff` (or People and
// Culture), and products are created and published through the product module.
// Usage: npm run seed   (safe to run again)

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const { seedSystem } = require('./foundation');
const { seedPricing } = require('./pricing');
const { seedAgreementTemplate } = require('./agreementTemplate');

async function main() {
  await connect(config.mongoUri);
  const roles = await seedSystem();
  const pricing = await seedPricing();
  await seedAgreementTemplate();
  // eslint-disable-next-line no-console
  console.log(`System data ready: ${Object.keys(roles).length} roles${pricing ? ', launch pricing' : ''}, agreement template. No people or products are created.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});

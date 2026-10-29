'use strict';

const { config } = require('./config/env');
const { connect } = require('./config/db');
const { buildApp } = require('./app');
const logger = require('./utils/logger');

async function main() {
  await connect(config.mongoUri);
  const app = buildApp();
  const server = app.listen(config.port, () => logger.info(`SLAS API listening on port ${config.port}`));
  const stopJobs = require('./jobs/scheduler').start();
  const shutdown = () => {
    stopJobs();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('Failed to start', { error: err.message });
  process.exit(1);
});

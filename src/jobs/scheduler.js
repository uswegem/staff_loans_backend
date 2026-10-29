'use strict';

// In-process jobs (DECISIONS D-22). Each job is idempotent, so several API
// instances can run it. Version resolution does not depend on these jobs: they only
// keep display states (scheduled → active → superseded) current.

const logger = require('../utils/logger');
const { promoteAll } = require('../services/products/productService');

const JOBS = [{ name: 'product-go-live', everyMs: 60 * 1000, run: () => promoteAll() }];

function start() {
  const timers = JOBS.map((job) => {
    const tick = () => job.run().catch((err) => logger.error(`Job ${job.name} failed`, { error: err.message }));
    tick();
    return setInterval(tick, job.everyMs);
  });
  return () => timers.forEach(clearInterval);
}

module.exports = { start, JOBS };

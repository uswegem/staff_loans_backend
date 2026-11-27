'use strict';

// In-process jobs (DECISIONS D-22). Each job is idempotent, so several API
// instances can run it. Version resolution does not depend on these jobs: they only
// keep display states (scheduled → active → superseded) current.

const logger = require('../utils/logger');
const { promoteAll } = require('../services/products/productService');
const { expireRevisedTerms } = require('../services/review/reviewService');
const { remindOverdue } = require('../services/workflow/reminders');
const { flagOutsideSla } = require('../services/disbursement/disbursementService');
const retention = require('../services/retention/retentionService');
const { config } = require('../config/env');

const JOBS = [
  { name: 'product-go-live', everyMs: 60 * 1000, run: () => promoteAll() },
  { name: 'revised-terms-expiry', everyMs: 5 * 60 * 1000, run: () => expireRevisedTerms() }, // FR-39
  { name: 'stage-overdue-reminders', everyMs: 5 * 60 * 1000, run: () => remindOverdue() }, // BRD 12
  { name: 'disbursement-outside-sla', everyMs: 60 * 60 * 1000, run: () => flagOutsideSla() }, // Q3, BR-13
  // D-115: once a day; nothing is due until ten years after the first loans end.
  ...(config.retentionPurgeEnabled ? [{ name: 'retention-purge', everyMs: 24 * 60 * 60 * 1000, run: () => retention.run({ apply: true }) }] : []),
];

function start() {
  const timers = JOBS.map((job) => {
    const tick = () => job.run().catch((err) => logger.error(`Job ${job.name} failed`, { error: err.message }));
    tick();
    return setInterval(tick, job.everyMs);
  });
  return () => timers.forEach(clearInterval);
}

module.exports = { start, JOBS };

'use strict';

// Read-only report of product payslip deduction labels (D-101). Each product needs its
// own label: a payslip line is matched to one product only, so products sharing a label
// get each other's deductions and top-ups are not picked up. Run on any environment:
//   node scripts/payslip-label-report.js
// Lists each product's label in force (latest approved version) and any open change, and
// every label used by more than one product. Changes nothing: fix a clash through
// Products and pricing (maker-checker).
const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const Product = require('../src/models/Product');
const ProductVersion = require('../src/models/ProductVersion');
const { normLabel } = require('../src/services/payslip/deductionLines');
const { OPEN_STATES } = require('../src/models/plugins/makerChecker');

async function main() {
  await connect(config.mongoUri);
  const products = await Product.find().sort({ code: 1 }).lean();
  const rows = [];
  for (const p of products) {
    // eslint-disable-next-line no-await-in-loop
    const [approved, open] = await Promise.all([
      ProductVersion.findOne({ productId: p._id, approvedAt: { $ne: null } }).sort({ liveFrom: -1, version: -1 }).select('name version payslipLabel topUpAllowed').lean(),
      ProductVersion.findOne({ productId: p._id, state: { $in: OPEN_STATES } }).select('version state payslipLabel').lean(),
    ]);
    rows.push({
      code: p.code,
      name: approved?.name || p.code,
      status: p.status,
      topUpAllowed: !!approved?.topUpAllowed,
      label: approved?.payslipLabel || '',
      openChange: open ? { version: open.version, state: open.state, label: open.payslipLabel || '' } : null,
    });
  }
  const byLabel = new Map();
  rows.forEach((r) => {
    const k = normLabel(r.label);
    if (k) byLabel.set(k, [...(byLabel.get(k) || []), r.code]);
  });
  const report = {
    environment: config.nodeEnv,
    products: rows,
    sharedLabels: [...byLabel.entries()].filter(([, codes]) => codes.length > 1).map(([k, codes]) => ({ label: rows.find((r) => normLabel(r.label) === k).label, products: codes })),
    missingLabels: rows.filter((r) => r.topUpAllowed && !r.label).map((r) => r.code),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

'use strict';

// Staff loan deductions on the payslip, matched to products (D-101). Each product carries
// the label its deduction has on the payslip ("Payslip deduction label", set through the
// product maker-checker). Labels match without regard to case, spacing or punctuation; a
// line that matches no product still counts against Room and is flagged for reviewers.

const ProductVersion = require('../../models/ProductVersion');

/** A label reduced to lower-case letters and digits: "STAFF LOAN - CAR" → "staffloancar". */
const normLabel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The product whose label starts this payslip line, or null. When several do, the longest
 * label wins, so "Staff Loan - Car" is not taken for a product labelled "Staff Loan".
 * products: [{ productId, name, label }].
 */
function matchLine(label, products) {
  const n = normLabel(label);
  let best = null;
  for (const p of products) {
    const pl = normLabel(p.label);
    if (pl && n.startsWith(pl) && (!best || pl.length > normLabel(best.label).length)) best = p;
  }
  return best;
}

/** Payslip lines with their matched product: [{ label, amount, productId, product }]. */
function matchLines(lines, products) {
  return (lines || []).map((l) => {
    const p = matchLine(l.label, products);
    return { label: l.label, amount: l.amount, productId: p ? String(p.productId) : null, product: p?.name || null };
  });
}

/**
 * The deduction label of every product: the latest approved version of each, live or
 * not (a deactivated product's loans still run). pinned: a version to use for its product
 * instead, such as the one an application was submitted under. Returns [{ productId, name, label }].
 */
async function productLabels(pinned = null) {
  const versions = await ProductVersion.find({ approvedAt: { $ne: null } }).sort({ liveFrom: -1, version: -1 }).select('productId name payslipLabel').lean();
  const byProduct = new Map();
  versions.forEach((v) => {
    if (!byProduct.has(String(v.productId))) byProduct.set(String(v.productId), { productId: String(v.productId), name: v.name, label: v.payslipLabel || '' });
  });
  if (pinned) byProduct.set(String(pinned.productId), { productId: String(pinned.productId), name: pinned.name, label: pinned.payslipLabel || '' });
  return [...byProduct.values()];
}

/** Every product label, for the payslip reader to find each line (D-101). */
const readerLabels = (products) => products.map((p) => p.label).filter((l) => l && l.trim());

module.exports = { normLabel, matchLine, matchLines, productLabels, readerLabels };

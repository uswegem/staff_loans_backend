'use strict';

// Per-product eligibility the staff member can see before applying.
// Milestone 3 covers the profile gate (decision 7) and the reapply cooling period with
// the days until a top-up (NS-02, NS-03). The other rules (BR-01 to BR-09) join in M4.

const { liveProducts } = require('../products/productService');
const { completeness } = require('./profileService');
const { cutoffProblem, cutoffFor } = require('./retirement');
const Settings = require('../../models/Settings');
const { addMonths, localDay, localMidnight } = require('../../utils/dates');

const DAY_MS = 24 * 3600 * 1000;

/**
 * The most recent successful application per product: SLAS applications that reached
 * final approval (NS-02), and declared paper loans with a product and disbursement date.
 */
function lastSuccessfulByProduct(staff) {
  const last = new Map();
  const consider = (productId, at, ref) => {
    if (!productId || !at) return;
    const key = String(productId);
    const prev = last.get(key);
    if (!prev || at > prev.at) last.set(key, { at, ref });
  };
  (staff.loanHistory || []).filter((h) => h.approvedAt).forEach((h) => consider(h.productId, h.appliedAt, h.ref));
  (staff.existingLfbLoans || []).forEach((l) => consider(l.productId, l.disbursedOn, l.description || 'declared staff loan'));
  return last;
}

/**
 * Cooling period for one product version: { lastAppliedAt, nextEligibleDate, daysRemaining, ref }
 * or null when there is no earlier successful application.
 */
function cooling(staff, productId, months, now = new Date()) {
  const last = lastSuccessfulByProduct(staff).get(String(productId));
  if (!last) return null;
  const next = localMidnight(localDay(addMonths(last.at, months)));
  const today = localMidnight(localDay(now));
  const daysRemaining = Math.max(0, Math.round((next - today) / DAY_MS));
  return { lastAppliedAt: last.at, ref: last.ref, nextEligibleDate: localDay(next), daysRemaining };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pretty = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

function coolingMessage(name, c) {
  return `You applied for a ${name} on ${pretty(localDay(c.lastAppliedAt))}. You can apply for this product again from ${pretty(c.nextEligibleDate)} (${c.daysRemaining} ${c.daysRemaining === 1 ? 'day' : 'days'}).`;
}

async function eligibilityFor(staff, now = new Date()) {
  const profile = await completeness(staff);
  const products = await liveProducts(now);
  const settings = await Settings.get();
  const items = products.map(({ product, version }) => {
    const reasons = [];
    if (!profile.complete && !profile.missing.every((m) => m.key === 'personal.dob')) reasons.push(`You can apply once your profile is complete. Missing: ${profile.missing.map((m) => m.label).join(', ')}.`);
    const cut = cutoffProblem(staff, version, settings, localDay(now));
    if (cut) reasons.push(cut);
    const c = cooling(staff, product._id, version.reapplyCoolingMonths, now);
    const waiting = c && c.daysRemaining > 0;
    if (waiting) reasons.push(coolingMessage(version.name, c));
    return {
      productId: String(product._id),
      versionId: String(version._id),
      name: version.name,
      topUpAllowed: version.topUpAllowed,
      reapplyCoolingMonths: version.reapplyCoolingMonths,
      canApply: reasons.length === 0,
      reasons,
      lastAppliedAt: c?.lastAppliedAt || null,
      nextEligibleDate: waiting ? c.nextEligibleDate : null,
      daysRemaining: waiting ? c.daysRemaining : 0,
    };
  });
  return { profile, products: items, cutoff: cutoffFor(staff, settings) };
}

module.exports = { eligibilityFor, cooling, coolingMessage, lastSuccessfulByProduct };

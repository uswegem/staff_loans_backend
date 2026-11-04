'use strict';

// TEST FIXTURES ONLY (D-92): the four sample products for the automated tests and the
// throwaway e2e system. In a real database, products are created and published only
// through the product module (two-stage approval, D-89).

// Four sample products (BRD 5): TZS 500,000 to 300,000,000; tenor and minimum service are
// samples. Seeded as published version 1: prepared by Peter Lyimo, approved by Asha
// Mfinanga (Head of Credit) and Daniel Mrema (Head of Risk and Compliance).

const Product = require('../../src/models/Product');
const ProductVersion = require('../../src/models/ProductVersion');
const { seedPricing, approvedMeta, PRICING, IN_FORCE } = require('../../seed/pricing');

const COMMON = {
  minAmount: 500000,
  maxAmount: 300000000,
  minServiceMonths: 6,
  maxConcurrent: 1,
  contractStaffAllowed: false,
  eligibleCategories: ['Management', 'Non-management'],
  repaymentMethods: ['payroll'],
  reapplyCoolingMonths: 6,
};

const PRODUCTS = [
  {
    code: 'SA',
    name: 'Salary Advance',
    payslipLabel: 'Salary Advance Recovery', // D-101
    description: 'A short advance against your salary.',
    minTenor: 1,
    maxTenor: 3,
    topUpAllowed: false,
    fields: [], // the purpose field carries the reason for the advance (DECISIONS D-50)
  },
  {
    code: 'PL',
    name: 'Personal Loan',
    payslipLabel: 'Staff Loan - Personal', // D-101
    description: 'For personal needs and emergencies.',
    minTenor: 6,
    maxTenor: 60,
    topUpAllowed: true,
    fields: [],
  },
  {
    code: 'VL',
    name: 'Vehicle Loan',
    payslipLabel: 'Staff Loan - Vehicle', // D-101
    description: 'To buy a new or used vehicle.',
    minTenor: 12,
    maxTenor: 84,
    topUpAllowed: false,
    fields: [
      { key: 'make', label: 'Make and model', type: 'text', mandatory: true },
      { key: 'year', label: 'Year of manufacture', type: 'number', mandatory: true },
      { key: 'seller', label: 'Seller or dealer', type: 'text', mandatory: true },
      { key: 'price', label: 'Vehicle price (TZS)', type: 'money', mandatory: true },
    ],
  },
  {
    code: 'HE',
    name: 'Housing / Education Loan',
    payslipLabel: 'Staff Loan - Housing', // D-101
    description: 'To buy, build or renovate a home, or pay tuition.',
    minTenor: 6,
    maxTenor: 120,
    topUpAllowed: true,
    fields: [], // staff loans are unsecured; the purpose is captured on the loan step (D-84)
  },
];

// BRD 10 and prototype settings: 6% interest, 1% / 0.5% processing, 0.60% insurance,
// 50% affordability, 10% pension, instalment rounded up to TZS 100.



/** The fixture people who prepare and approve (D-89). */
const people = (users) => ({ maker: users.LFB0274?._id, creditApprover: users.LFB0010?._id, riskApprover: users.LFB0067?._id });

async function seedProducts(users) {
  const out = {};
  for (const p of PRODUCTS) {
    const { code, ...values } = p;
    /* eslint-disable no-await-in-loop */
    let product = await Product.findOne({ code });
    if (!product) {
      product = await Product.create({ code, status: 'active', createdBy: users.LFB0274?._id });
      const v = await ProductVersion.create({ productId: product._id, ...COMMON, ...values, ...approvedMeta(people(users), 'Sample product (test fixture).') });
      product.liveVersionId = v._id;
      await product.save();
    }
    out[code] = product;
    /* eslint-enable no-await-in-loop */
  }
  await seedPricing(people(users));
  return out;
}

module.exports = { seedProducts, PRODUCTS, PRICING, IN_FORCE };

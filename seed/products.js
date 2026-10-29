'use strict';

// Launch products and pricing (BRD 5, decision 33; prototype seed). Amounts are
// confirmed (TZS 500,000 to 300,000,000). Salary multiple, tenor range and minimum
// service are sample values until the Staff Loan Policy confirms them (BRD 14,
// DECISIONS D-01). Seeded as approved version 1: maker Peter Lyimo, checker Asha
// Mfinanga, in force from 1 Oct 2026 (DECISIONS D-37).

const Product = require('../src/models/Product');
const ProductVersion = require('../src/models/ProductVersion');
const PricingVersion = require('../src/models/PricingVersion');
const { localMidnight } = require('../src/utils/dates');

const IN_FORCE = '2026-10-01';
const COMMON = {
  minAmount: 500000,
  maxAmount: 300000000,
  minServiceMonths: 6,
  maxConcurrent: 1,
  contractStaffAllowed: false,
  eligibleCategories: ['Management', 'Non-management'],
  repaymentMethods: ['payroll', 'account'],
  requiredDocuments: [],
  reapplyCoolingMonths: 6,
};

const PRODUCTS = [
  {
    code: 'SA',
    name: 'Salary Advance',
    description: 'A short advance against your salary.',
    salaryMultiple: 1,
    minTenor: 1,
    maxTenor: 3,
    topUpAllowed: false,
    optionalDocuments: ['Latest salary slip'],
    fields: [], // the purpose field carries the reason for the advance (DECISIONS D-50)
    disbursementConditions: [],
  },
  {
    code: 'PL',
    name: 'Personal Loan',
    description: 'For personal needs and emergencies.',
    salaryMultiple: 8,
    minTenor: 6,
    maxTenor: 60,
    topUpAllowed: true,
    optionalDocuments: ['Latest salary slip', 'Latest 3 months bank statement', 'Purpose statement'],
    fields: [],
    disbursementConditions: [],
  },
  {
    code: 'VL',
    name: 'Vehicle Loan',
    description: 'To buy a new or used vehicle.',
    salaryMultiple: 15,
    minTenor: 12,
    maxTenor: 84,
    topUpAllowed: false,
    optionalDocuments: ['Latest salary slip', 'Proforma invoice or sale agreement', 'Vehicle registration card (used vehicles)'],
    fields: [
      { key: 'make', label: 'Make and model', type: 'text', mandatory: true },
      { key: 'year', label: 'Year of manufacture', type: 'number', mandatory: true },
      { key: 'seller', label: 'Seller or dealer', type: 'text', mandatory: true },
      { key: 'price', label: 'Vehicle price (TZS)', type: 'money', mandatory: true },
    ],
    disbursementConditions: ['Comprehensive insurance cover note received', 'Sale agreement or proforma invoice on file'],
  },
  {
    code: 'HE',
    name: 'Housing / Education Loan',
    description: 'To buy, build or renovate a home, or pay tuition.',
    salaryMultiple: 30,
    minTenor: 6,
    maxTenor: 120,
    topUpAllowed: true,
    optionalDocuments: ['Latest salary slip', 'Quotation, BOQ or title documents (housing)', 'Admission letter and fee structure (education)'],
    fields: [
      { key: 'kind', label: 'What is the loan for?', type: 'select', options: ['Home purchase', 'Construction', 'Renovation', 'Tuition: self', 'Tuition: dependant'], mandatory: true },
      { key: 'place', label: 'Property location or institution name', type: 'text', mandatory: true },
    ],
    disbursementConditions: [],
  },
];

// BRD 10 and prototype settings: 6% interest, 1% / 0.5% processing, 0.60% insurance,
// 50% affordability, 10% pension, instalment rounded up to TZS 100.
const PRICING = {
  interestBps: 600,
  processingFeeBps: 100,
  processingFeeTopUpBps: 50,
  insuranceBps: 60,
  affordabilityBps: 5000,
  pensionBps: 1000,
  instalmentRounding: 100,
  payeBands: [
    { from: 0, base: 0, rateBps: 0 },
    { from: 270000, base: 0, rateBps: 800 },
    { from: 520000, base: 20000, rateBps: 2000 },
    { from: 760000, base: 68000, rateBps: 2500 },
    { from: 1000000, base: 128000, rateBps: 3000 },
  ],
};

function approvedMeta(users, note) {
  const maker = users.LFB0274?._id;
  const checker = users.LFB0010?._id;
  const at = localMidnight(IN_FORCE);
  return {
    version: 1,
    state: 'active',
    changeType: 'create',
    effectiveFrom: at,
    liveFrom: at,
    note,
    editors: [maker],
    makerId: maker,
    submittedAt: at,
    submittedBy: maker,
    checkerId: checker,
    decidedAt: at,
    approvedAt: at,
  };
}

async function seedProducts(users) {
  const out = {};
  for (const p of PRODUCTS) {
    const { code, ...values } = p;
    /* eslint-disable no-await-in-loop */
    let product = await Product.findOne({ code });
    if (!product) {
      product = await Product.create({ code, status: 'active', createdBy: users.LFB0274?._id });
      const v = await ProductVersion.create({ productId: product._id, ...COMMON, ...values, ...approvedMeta(users, 'Launch product (seed). Salary multiple, tenor and minimum service are samples until the Staff Loan Policy confirms them.') });
      product.liveVersionId = v._id;
      await product.save();
    }
    out[code] = product;
    /* eslint-enable no-await-in-loop */
  }
  if (!(await PricingVersion.exists({}))) {
    await PricingVersion.create({ ...PRICING, ...approvedMeta(users, 'Launch pricing (seed): BRD 10 and BR-14, BR-15.') });
  }
  return out;
}

module.exports = { seedProducts, PRODUCTS, PRICING, IN_FORCE };

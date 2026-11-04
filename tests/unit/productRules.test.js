'use strict';

const { validateProduct, diff, PRODUCT_FIELDS } = require('../../src/services/products/productRules');
const { validatePricing } = require('../../src/services/products/pricingRules');
const { PRODUCTS, PRICING } = require('../fixtures/products');

const base = {
  name: 'Personal Loan',
  minAmount: 500000,
  maxAmount: 300000000,
  salaryMultiple: 8,
  minTenor: 6,
  maxTenor: 60,
  minServiceMonths: 6,
  maxConcurrent: 1,
  reapplyCoolingMonths: 6,
  eligibleCategories: ['Management', 'Non-management'],
  repaymentMethods: ['payroll'],
  requiredDocuments: [],
  optionalDocuments: ['Latest salary slip'],
  fields: [],
};

describe('product validation (FR-58)', () => {
  it('accepts a valid product', () => {
    expect(validateProduct(base)).toEqual({});
  });

  it('every seeded launch product is valid', () => {
    PRODUCTS.forEach(({ code, ...p }) => expect([code, validateProduct({ ...base, ...p })]).toEqual([code, {}]));
  });

  it('minimum amount must be below maximum', () => {
    expect(validateProduct({ ...base, minAmount: 5000000, maxAmount: 1000000 }).maxAmount).toBeDefined();
  });

  it('amounts are positive whole shillings', () => {
    expect(validateProduct({ ...base, minAmount: 0 }).minAmount).toBeDefined();
    expect(validateProduct({ ...base, minAmount: 500000.5 }).minAmount).toBeDefined();
  });

  it('tenor range must be in order', () => {
    expect(validateProduct({ ...base, minTenor: 24, maxTenor: 12 }).maxTenor).toBeDefined();
  });

  it('no longer needs a salary multiple: the reverse calculation sets the maximum amount (D-78)', () => {
    const noMultiple = { ...base };
    delete noMultiple.salaryMultiple;
    expect(validateProduct(noMultiple)).toEqual({});
  });

  it('needs a category; repayment is always by salary deduction (D-84)', () => {
    const e = validateProduct({ ...base, eligibleCategories: [], repaymentMethods: [] });
    expect(Object.keys(e).sort()).toEqual(['eligibleCategories']);
  });

  it('checks application fields', () => {
    const e = validateProduct({
      ...base,
      fields: [
        { key: 'kind', label: 'Kind', type: 'select', options: ['One'] },
        { key: 'kind', label: 'Again', type: 'text', options: ['x'] },
      ],
    });
    expect(Object.keys(e).sort()).toEqual(['fields.0.options', 'fields.1.key', 'fields.1.options']);
  });

  it('accepts product-specific mandatory documents and rejects duplicate codes', () => {
    const invoice = { code: 'invoice', name: 'Vehicle invoice', mandatory: true, minFiles: 1, maxFiles: 1, allowedTypes: ['pdf', 'jpg'], maxFileMb: 10, active: true };
    expect(validateProduct({ ...base, requiredDocuments: [invoice] })).toEqual({});
    const repeated = validateProduct({ ...base, requiredDocuments: [invoice, { ...invoice, name: 'Other invoice' }] });
    expect(repeated['requiredDocuments.1.code']).toBeDefined();
  });

  it('requires at least one attachment for mandatory categories and a valid file limit', () => {
    const bad = validateProduct({ ...base, requiredDocuments: [{
      code: 'front', name: 'Front photograph', mandatory: true, minFiles: 0,
      maxFiles: 0, allowedTypes: ['exe'], active: true,
    }] });
    expect(bad['requiredDocuments.0.minFiles']).toBeDefined();
    expect(bad['requiredDocuments.0.maxFiles']).toBeDefined();
    expect(bad['requiredDocuments.0.allowedTypes']).toBeDefined();
  });

  it('tracks versioned document requirements without old optional document fields or OPS conditions', () => {
    expect(PRODUCT_FIELDS.map((x) => x[0])).toContain('requiredDocuments');
    expect(PRODUCT_FIELDS.map((x) => x[0])).not.toContain('optionalDocuments');
    expect(PRODUCT_FIELDS.map((x) => x[0])).not.toContain('disbursementConditions');
    expect(PRODUCT_FIELDS.find((x) => x[0] === 'reapplyCoolingMonths')[1]).toBe('Minimum number of Months Before Applying for Topup');
  });
});

describe('comparison with the live version (FR-58, FR-59)', () => {
  it('lists only the fields that changed, with labels', () => {
    const d = diff(PRODUCT_FIELDS, base, { ...base, maxTenor: 72, minServiceMonths: 12 });
    expect(d).toEqual([
      { field: 'maxTenor', label: 'Maximum tenor (months)', before: 60, after: 72 },
      { field: 'minServiceMonths', label: 'Minimum service (months)', before: base.minServiceMonths, after: 12 },
    ]);
  });

  it('shows every field as new for a first version', () => {
    expect(diff(PRODUCT_FIELDS, null, base).map((x) => x.field)).toContain('name');
  });
});

describe('pricing validation', () => {
  it('accepts the launch pricing', () => {
    expect(validatePricing(PRICING)).toEqual({});
  });

  it('PAYE bands start at 0 and go up', () => {
    expect(validatePricing({ ...PRICING, payeBands: [{ from: 100, base: 0, rateBps: 0 }] }).payeBands).toBeDefined();
    const e = validatePricing({ ...PRICING, payeBands: [{ from: 0, base: 0, rateBps: 0 }, { from: 500, base: 0, rateBps: 800 }, { from: 400, base: 0, rateBps: 900 }] });
    expect(e['payeBands.2']).toBeDefined();
  });

  it('rates are whole basis points within range', () => {
    expect(validatePricing({ ...PRICING, interestBps: 600.5 }).interestBps).toBeDefined();
    expect(validatePricing({ ...PRICING, affordabilityBps: 0 }).affordabilityBps).toBeDefined();
    expect(validatePricing({ ...PRICING, instalmentRounding: 50 }).instalmentRounding).toBeDefined();
  });
});

'use strict';

// The agreement loader (scripts/load-agreement-templates.js): the English Staff Personal
// Loan and Staff Car Loan agreements, loaded as approved and assigned to their products.

const { seedAll } = require('../flows');
const AgreementTemplate = require('../../src/models/AgreementTemplate');
const ProductVersion = require('../../src/models/ProductVersion');
const AuditLog = require('../../src/models/AuditLog');
const mc = require('../../src/services/products/makerChecker');
const { productChain } = require('../../src/services/products/productService');
const loader = require('../../scripts/load-agreement-templates');

const run = (opts) => loader.run({ ownConnection: false, ...opts });
let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

describe('agreement loader', () => {
  it('a dry run finds the Personal Loan and the Vehicle Loan and changes nothing', async () => {
    const out = await run({ dryRun: true });
    expect(out.summary.map((s) => s.product)).toEqual([expect.stringMatching(/^PL Personal Loan, live version \d+$/), expect.stringMatching(/^VL Vehicle Loan, live version \d+$/)]);
    expect(out.summary[0].template).toBe('2026.12c (English, 6 declarations)');
    expect(out.summary[1].template).toBe('2026.12d (English, 8 declarations)');
    expect(await AgreementTemplate.countDocuments({ language: 'en' })).toBe(0);
  });

  it('needs --confirm and a Head of Legal as the approver', async () => {
    await expect(run({ approvedBy: 'LFB0451' })).rejects.toThrow(/--confirm/);
    await expect(run({ confirm: true })).rejects.toThrow(/--approved-by/);
    await expect(run({ confirm: true, approvedBy: 'LFB0412' })).rejects.toThrow(/cannot approve agreement templates/);
    expect(await AgreementTemplate.countDocuments({ language: 'en' })).toBe(0);
  });

  it('loads both agreements as approved, assigns them to new live product versions, and is safe to run again', async () => {
    const out = await run({ confirm: true, approvedBy: 'LFB0451' });
    expect(out.done).toHaveLength(4);
    const personal = await AgreementTemplate.findOne({ version: '2026.12c' }).lean();
    const car = await AgreementTemplate.findOne({ version: '2026.12d' }).lean();
    expect(personal).toMatchObject({ language: 'en', status: 'approved', sample: false });
    expect(car.body).toMatch(/^# STAFF CAR LOAN AGREEMENT/);
    const livePL = await mc.liveAt(productChain(products.PL));
    const liveVL = await mc.liveAt(productChain(products.VL));
    expect(String(livePL.agreementTemplateId)).toBe(String(personal._id));
    expect(String(liveVL.agreementTemplateId)).toBe(String(car._id));
    expect(livePL.name).toBe('Personal Loan');
    expect(await AuditLog.countDocuments({ action: { $in: ['template.load', 'product.agreement_assign'] } })).toBe(4);

    const again = await run({ confirm: true, approvedBy: 'LFB0451' });
    expect(again.done).toEqual([]);
    expect(await AgreementTemplate.countDocuments({ language: 'en' })).toBe(2);
  });

  it('stops, changing nothing, when a product has a change waiting', async () => {
    const live = await mc.liveAt(productChain(products.VL));
    await ProductVersion.create({ ...live.toObject(), _id: undefined, version: live.version + 1, state: 'draft', approvedAt: null, liveFrom: null });
    await expect(run({ confirm: true, approvedBy: 'LFB0451' })).rejects.toThrow(/VL has a change waiting/);
    expect(await AgreementTemplate.countDocuments({ language: 'en' })).toBe(0);
  });
});

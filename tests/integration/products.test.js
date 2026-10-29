'use strict';

// Products and pricing with maker-checker (BRD 5.1, FR-57 to FR-63, decision 32, 33).

const { app, seed, signIn, authed, request } = require('../helpers');
const { seedProducts } = require('../../seed/products');
const Product = require('../../src/models/Product');
const ProductVersion = require('../../src/models/ProductVersion');
const Role = require('../../src/models/Role');
const User = require('../../src/models/User');
const RoleAssignment = require('../../src/models/RoleAssignment');
const Notification = require('../../src/models/Notification');
const AuditLog = require('../../src/models/AuditLog');
const svc = require('../../src/services/products/productService');
const { localDay } = require('../../src/utils/dates');

const DAY = 24 * 3600 * 1000;
const today = () => localDay();
const inDays = (n) => localDay(new Date(Date.now() + n * DAY));

let maker;
let checker;
let products;

const api = (token) => ({
  get: (url) => request(app()).get(`/api/v1${url}`).set(authed(token)),
  post: (url, body = {}) => request(app()).post(`/api/v1${url}`).set(authed(token)).send(body),
  patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(authed(token)).send(body),
});

const pl = () => String(products.PL._id);
const draft = (body, id = pl()) => api(maker.token).post(`/admin/products/${id}/drafts`, { effectiveFrom: today(), ...body });
const submit = (vid) => api(maker.token).post(`/admin/product-versions/${vid}/submit`);
const approve = (vid, who = checker) => api(who.token).post(`/admin/product-versions/${vid}/approve`);

beforeEach(async () => {
  const { users } = await seed();
  products = await seedProducts(users);
  maker = await signIn('LFB0274'); // Peter Lyimo, products.make
  checker = await signIn('LFB0010'); // Asha Mfinanga, products.check
});

describe('launch products (decision 33)', () => {
  it('four live products, each TZS 500,000 to 300,000,000', async () => {
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).get('/products');
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.name)).toEqual(['Housing / Education Loan', 'Personal Loan', 'Salary Advance', 'Vehicle Loan']);
    res.body.data.forEach((p) => expect([p.minAmount, p.maxAmount]).toEqual([500000, 300000000]));
    const vl = res.body.data.find((p) => p.code === 'VL');
    expect(vl.fields.map((f) => f.key)).toEqual(['make', 'year', 'seller', 'price']);
    expect(vl.disbursementConditions).toHaveLength(2);
  });

  it('launch pricing is 6% reducing, 1% / 0.5% fees, 0.60% insurance, 50% affordability', async () => {
    const neema = await signIn('LFB0412');
    const res = await api(neema.token).get('/pricing');
    expect(res.body.data).toMatchObject({ interestBps: 600, processingFeeBps: 100, processingFeeTopUpBps: 50, insuranceBps: 60, affordabilityBps: 5000, pensionBps: 1000, instalmentRounding: 100 });
  });

  it('staff cannot open the product module', async () => {
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).get('/admin/products')).status).toBe(403);
  });
});

describe('maker drafts a change (FR-58)', () => {
  it('saves a draft and shows what changed against the live version', async () => {
    const res = await draft({ values: { maxTenor: 72 } });
    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('draft');
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.comparison.changes).toEqual([{ field: 'maxTenor', label: 'Maximum tenor (months)', before: 60, after: 72 }]);
    expect(res.body.data.comparison.liveVersion.version).toBe(1);
  });

  it('checks every value on save', async () => {
    const res = await draft({ values: { minAmount: 5000000, maxAmount: 1000000 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUES');
    expect(res.body.details.maxAmount[0]).toMatch(/above the minimum/);
    expect(await ProductVersion.countDocuments({ productId: products.PL._id })).toBe(1);
  });

  it('refuses a choice field without options and a past effective date', async () => {
    const bad = await draft({ values: { fields: [{ key: 'kind', label: 'Kind', type: 'select', options: [] }] } });
    expect(bad.body.details['fields.0.options']).toBeDefined();
    const past = await draft({ effectiveFrom: inDays(-1), values: { maxTenor: 72 } });
    expect(past.body.code).toBe('EFFECTIVE_DATE_PASSED');
  });

  it('allows one open change per product', async () => {
    await draft({ values: { maxTenor: 72 } });
    const second = await draft({ values: { maxTenor: 84 } });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('OPEN_CHANGE_EXISTS');
  });

  it('edits a draft and records before and after in the audit log (FR-63)', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    const res = await api(maker.token).patch(`/admin/product-versions/${d.body.data.id}`, { values: { maxTenor: 84 } });
    expect(res.body.data.values.maxTenor).toBe(84);
    const entry = await AuditLog.findOne({ action: 'product.draft_update' });
    expect(entry.before.maxTenor).toBe(72);
    expect(entry.after.maxTenor).toBe(84);
  });

  it('refuses to submit a draft with no changes', async () => {
    const d = await draft({ values: {} });
    expect((await submit(d.body.data.id)).body.code).toBe('NO_CHANGES');
  });

  it('a checker cannot draft and a maker cannot approve', async () => {
    expect((await api(checker.token).post(`/admin/products/${pl()}/drafts`, { effectiveFrom: today(), values: { maxTenor: 72 } })).status).toBe(403);
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    expect((await approve(d.body.data.id, maker)).status).toBe(403);
  });
});

describe('checker decides (FR-59, FR-60)', () => {
  it('submitting notifies checkers, not the maker', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    const res = await submit(d.body.data.id);
    expect(res.body.data.state).toBe('pending_approval');
    const asha = await User.findOne({ staffNo: 'LFB0010' });
    const peter = await User.findOne({ staffNo: 'LFB0274' });
    expect(await Notification.countDocuments({ userId: asha._id, type: 'maker_checker.submitted' })).toBe(1);
    expect(await Notification.countDocuments({ userId: peter._id })).toBe(0);
    const bell = await api(checker.token).get('/notifications');
    expect(bell.body.data.unread).toBe(1);
    expect(bell.body.data.items[0].href).toBe(`/admin/products/versions/${d.body.data.id}`);
  });

  it('the checker sees the full product and the comparison', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    const res = await api(checker.token).get(`/admin/product-versions/${d.body.data.id}`);
    expect(res.body.data.values.name).toBe('Personal Loan');
    expect(res.body.data.comparison.changes).toHaveLength(1);
    expect(res.body.data.canCheck).toBe(true);
  });

  it('rejection needs a reason and returns the draft to the maker', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    const noReason = await api(checker.token).post(`/admin/product-versions/${d.body.data.id}/reject`, {});
    expect(noReason.status).toBe(400);
    const res = await api(checker.token).post(`/admin/product-versions/${d.body.data.id}/reject`, { reason: 'Policy caps Personal Loan at 60 months.' });
    expect(res.body.data.state).toBe('rejected');
    expect(res.body.data.rejectionReason).toBe('Policy caps Personal Loan at 60 months.');
    const peter = await User.findOne({ staffNo: 'LFB0274' });
    expect(await Notification.countDocuments({ userId: peter._id, type: 'maker_checker.rejected' })).toBe(1);
    // The maker edits it again; it becomes a draft and can be resubmitted.
    const edited = await api(maker.token).patch(`/admin/product-versions/${d.body.data.id}`, { values: { maxTenor: 66 } });
    expect(edited.body.data.state).toBe('draft');
    expect((await submit(d.body.data.id)).body.data.state).toBe('pending_approval');
  });

  it('refuses approval by anyone who edited the draft, even with checker rights (FR-60)', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    // Peter later becomes a checker (his maker role removed, so SoD allows it).
    const peter = await User.findOne({ staffNo: 'LFB0274' });
    const sysAdmin = await Role.findOne({ code: 'sys_admin' });
    const checkerRole = await Role.findOne({ code: 'product_checker' });
    await RoleAssignment.updateOne({ userId: peter._id, roleId: sysAdmin._id }, { $set: { revokedAt: new Date() } });
    await RoleAssignment.create({ userId: peter._id, roleId: checkerRole._id });
    const peterAsChecker = await signIn('LFB0274');
    const res = await approve(d.body.data.id, peterAsChecker);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL');
  });

  it('approval with today as the effective date puts the version live at once', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    const before = new Date();
    const res = await approve(d.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('active');
    expect(new Date(res.body.data.liveFrom).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    const neema = await signIn('LFB0412');
    const live = await api(neema.token).get('/products');
    expect(live.body.data.find((p) => p.code === 'PL').maxTenor).toBe(72);
    const v1 = await ProductVersion.findOne({ productId: products.PL._id, version: 1 });
    expect(v1.state).toBe('superseded');
    expect(await AuditLog.countDocuments({ action: 'product.approve' })).toBe(1);
  });
});

describe('versions and effective dates (FR-61)', () => {
  it('a future version stays scheduled and the old one stays live until then', async () => {
    const d = await draft({ effectiveFrom: inDays(10), values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    const res = await approve(d.body.data.id);
    expect(res.body.data.state).toBe('approved_scheduled');

    const now = await svc.liveProductVersion(products.PL._id);
    expect(now.version.version).toBe(1);
    const later = await svc.liveProductVersion(products.PL._id, new Date(Date.now() + 11 * DAY));
    expect(later.version.version).toBe(2);

    await svc.promoteAll({ now: new Date(Date.now() + 11 * DAY) });
    expect((await ProductVersion.findOne({ productId: products.PL._id, version: 2 })).state).toBe('active');
    expect((await ProductVersion.findOne({ productId: products.PL._id, version: 1 })).state).toBe('superseded');
  });

  it('an application keeps the version it was submitted under', async () => {
    const submittedAt = new Date();
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    await approve(d.body.data.id);
    const atSubmission = await svc.liveProductVersion(products.PL._id, submittedAt);
    expect(atSubmission.version.maxTenor).toBe(60);
  });

  it('a later change cannot take effect before a scheduled one', async () => {
    const d = await draft({ effectiveFrom: inDays(10), values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    await approve(d.body.data.id);
    const early = await draft({ effectiveFrom: inDays(5), values: { maxTenor: 84 } });
    expect(early.body.code).toBe('EFFECTIVE_DATE_BEFORE_SCHEDULED');
  });

  it('recall and discard keep the history', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    expect((await api(maker.token).post(`/admin/product-versions/${d.body.data.id}/recall`)).body.data.state).toBe('draft');
    expect((await api(maker.token).post(`/admin/product-versions/${d.body.data.id}/discard`)).body.data.state).toBe('discarded');
    const history = await api(maker.token).get(`/admin/products/${pl()}`);
    expect(history.body.data.versions.map((v) => v.state)).toEqual(['discarded', 'active']);
    // A new change can start once the old one is discarded.
    expect((await draft({ values: { maxTenor: 84 } })).status).toBe(201);
  });
});

describe('deactivation and new products (FR-62, FR-57)', () => {
  it('deactivation goes through maker-checker and hides the product from new applications', async () => {
    const d = await draft({ changeType: 'deactivate', values: { maxTenor: 99 } });
    expect(d.body.data.changeType).toBe('deactivate');
    expect(d.body.data.values.maxTenor).toBe(60); // a deactivation carries the live values unchanged
    await submit(d.body.data.id);
    const res = await approve(d.body.data.id);
    expect(res.body.data.state).toBe('inactive');
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).get('/products')).body.data.map((p) => p.code)).not.toContain('PL');
    expect((await Product.findById(products.PL._id)).status).toBe('inactive');
    // Reactivation is a normal change.
    const back = await draft({ values: { description: 'Back by popular demand.' } });
    await submit(back.body.data.id);
    await approve(back.body.data.id);
    expect((await api(neema.token).get('/products')).body.data.map((p) => p.code)).toContain('PL');
  });

  it('creates a new product that goes live only after approval', async () => {
    const res = await api(maker.token).post('/admin/products', {
      code: 'em',
      effectiveFrom: today(),
      values: {
        name: 'Emergency Loan',
        minAmount: 500000,
        maxAmount: 300000000,
        salaryMultiple: 2,
        minTenor: 1,
        maxTenor: 12,
        minServiceMonths: 3,
        maxConcurrent: 1,
        eligibleCategories: ['Non-management'],
        repaymentMethods: ['payroll'],
        fields: [{ key: 'reason', label: 'What is the emergency?', type: 'textarea', mandatory: true }],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.values.reapplyCoolingMonths).toBe(6);
    expect(res.body.data.product.code).toBe('EM');
    expect(res.body.data.changeType).toBe('create');
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).get('/products')).body.data.map((p) => p.code)).not.toContain('EM');
    await submit(res.body.data.id);
    await approve(res.body.data.id);
    expect((await api(neema.token).get('/products')).body.data.map((p) => p.code)).toContain('EM');
    expect((await api(maker.token).post('/admin/products', { code: 'EM', effectiveFrom: today(), values: res.body.data.values })).status).toBe(409);
  });
});

describe('pricing maker-checker (D-06)', () => {
  it('changes interest through draft, submit and approve', async () => {
    const d = await api(maker.token).post('/admin/pricing/drafts', { effectiveFrom: today(), values: { interestBps: 700 } });
    expect(d.status).toBe(201);
    expect(d.body.data.comparison.changes).toEqual([{ field: 'interestBps', label: 'Interest a year (basis points)', before: 600, after: 700 }]);
    await api(maker.token).post(`/admin/pricing-versions/${d.body.data.id}/submit`);
    expect((await api(maker.token).post(`/admin/pricing-versions/${d.body.data.id}/approve`)).status).toBe(403);
    expect((await api(checker.token).post(`/admin/pricing-versions/${d.body.data.id}/approve`)).body.data.state).toBe('active');
    expect((await api(maker.token).get('/pricing')).body.data.interestBps).toBe(700);
  });

  it('validates PAYE bands', async () => {
    const res = await api(maker.token).post('/admin/pricing/drafts', { effectiveFrom: today(), values: { payeBands: [{ from: 10, base: 0, rateBps: 0 }] } });
    expect(res.status).toBe(400);
    expect(res.body.details.payeBands).toBeDefined();
  });
});

describe('notifications inbox', () => {
  it('lists only my own and marks them read', async () => {
    const d = await draft({ values: { maxTenor: 72 } });
    await submit(d.body.data.id);
    const mine = await api(checker.token).get('/notifications');
    const id = mine.body.data.items[0].id;
    expect((await api(maker.token).post(`/notifications/${id}/read`)).status).toBe(404);
    expect((await api(checker.token).post(`/notifications/${id}/read`)).body.data.read).toBe(true);
    expect((await api(checker.token).get('/notifications/unread-count')).body.data.unread).toBe(0);
  });
});

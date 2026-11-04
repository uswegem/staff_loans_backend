'use strict';

// Product and pricing maker-checker (BRD 5.1, FR-57 to FR-63) and the live product
// list for the application form.

const Product = require('../models/Product');
const ProductVersion = require('../models/ProductVersion');
const PricingVersion = require('../models/PricingVersion');
const AgreementTemplate = require('../models/AgreementTemplate');
const User = require('../models/User');
const Staff = require('../models/Staff');
const mc = require('../services/products/makerChecker');
const svc = require('../services/products/productService');
const notify = require('../services/notify/notificationService');
const audit = require('../services/audit/auditService');
const { PRODUCT_FIELDS } = require('../services/products/productRules');
const { PRICING_FIELDS } = require('../services/products/pricingRules');
const { withTransaction } = require('../config/db');
const { localDay } = require('../utils/dates');
const { notFound, conflict, badRequest } = require('../utils/errors');

async function namesOf(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const users = await User.find({ _id: { $in: unique } }).select('staffNo staffId').lean();
  const staff = await Staff.find({ _id: { $in: users.map((u) => u.staffId) } }).select('firstName lastName').lean();
  const byStaff = new Map(staff.map((s) => [String(s._id), [s.firstName, s.lastName].filter(Boolean).join(' ')]));
  return new Map(users.map((u) => [String(u._id), { id: String(u._id), staffNo: u.staffNo, name: byStaff.get(String(u.staffId)) || u.staffNo }]));
}

function meta(v, names) {
  return {
    id: String(v._id),
    version: v.version,
    state: v.state,
    changeType: v.changeType,
    effectiveFrom: localDay(v.effectiveFrom),
    liveFrom: v.liveFrom,
    note: v.note,
    maker: names.get(String(v.makerId)) || null,
    editors: v.editors.map((e) => names.get(String(e))).filter(Boolean),
    submittedAt: v.submittedAt,
    checker: names.get(String(v.checkerId)) || null,
    decidedAt: v.decidedAt,
    rejectionReason: v.rejectionReason,
  };
}

const values = (fields, v) => Object.fromEntries(fields.map(([f]) => [f, f === 'agreementTemplateId' ? (v[f] ? String(v[f]) : null) : v[f]]));
const peopleIn = (versions) => versions.flatMap((v) => [v.makerId, v.checkerId, ...v.editors]);

async function loadProduct(id) {
  const product = await Product.findById(id);
  if (!product) throw notFound('Product not found.');
  return product;
}

async function loadProductVersion(vid) {
  const v = await ProductVersion.findById(vid);
  if (!v) throw notFound('Version not found.');
  return { version: v, product: await loadProduct(v.productId) };
}

function permissionsFor(req, v) {
  const p = req.auth.permissions;
  const editor = v.editors.map(String).includes(String(req.auth.user._id));
  return {
    canEdit: p.has('products.make') && ['draft', 'rejected'].includes(v.state),
    canSubmit: p.has('products.make') && ['draft', 'rejected'].includes(v.state),
    canRecall: p.has('products.make') && v.state === 'pending_approval',
    // D-89: the approver for the stage the version waits for; never an editor or the first approver.
    canCheck: v.state === 'pending_approval' && !!v.stage && p.has(mc.STAGE_PERMISSION[v.stage]) && !editor && !(v.approvals || []).some((a) => String(a.by) === String(req.auth.user._id)),
    stage: v.stage || null,
    stageLabel: v.stage ? mc.STAGE_NAME[v.stage] : null,
    approvals: (v.approvals || []).map((a) => ({ stage: a.stage, stageLabel: mc.STAGE_NAME[a.stage], at: a.at })),
    isEditor: editor,
  };
}

async function afterSubmit(chain, doc, session) {
  await notify.notifyPermission(
    'products.approveCredit',
    { type: 'maker_checker.submitted', text: `${chain.describe(doc)} is waiting for your approval.`, href: chain.href(doc), entity: chain.entity, entityId: String(doc._id) },
    { exclude: doc.editors, session }
  );
}

async function afterDecision(chain, doc, verb, session) {
  const text = verb === 'approved' ? `${chain.describe(doc)} was approved and goes live ${localDay(doc.liveFrom)}.` : `${chain.describe(doc)} was rejected: ${doc.rejectionReason}`;
  await notify.notifyUsers(doc.editors, { type: `maker_checker.${verb}`, text, href: chain.href(doc), entity: chain.entity, entityId: String(doc._id) }, { session });
}

const productChain = (product) => ({ ...svc.productChain(product), href: (v) => `/admin/products/versions/${v._id}` });
const pricingChain = () => ({ ...svc.pricingChain(), href: (v) => `/admin/pricing/versions/${v._id}` });

/** Shared handlers for a version in either chain. */
function versionActions(load, chainOf) {
  const run = (fn) => async (req, res) => {
    const { version, chain } = await load(req.params.vid, chainOf);
    const updated = await withTransaction((session) => fn(req, version, chain, session));
    res.json({ success: true, data: await versionDetail(req, updated, chain) });
  };
  return {
    get: async (req, res) => {
      const { version, chain } = await load(req.params.vid, chainOf);
      res.json({ success: true, data: await versionDetail(req, version, chain) });
    },
    update: run((req, v, chain, session) => mc.updateDraft(chain, v, { req, values: req.body.values || {}, effectiveFrom: req.body.effectiveFrom, note: req.body.note, session })),
    submit: run(async (req, v, chain, session) => {
      const doc = await mc.submit(chain, v, { req, session });
      await afterSubmit(chain, doc, session);
      return doc;
    }),
    recall: run((req, v, chain, session) => mc.recall(chain, v, { req, session })),
    approve: run(async (req, v, chain, session) => {
      const doc = await mc.approve(chain, v, { req, session });
      if (doc.state === 'pending_approval') {
        // First stage done: the Head of Risk and Compliance is next (D-89).
        await notify.notifyPermission('products.approveRisk', { type: 'maker_checker.submitted', text: `${chain.describe(doc)} is waiting for your approval (approved by the Head of Credit).`, href: chain.href(doc), entity: chain.entity, entityId: String(doc._id) }, { exclude: [...doc.editors, req.auth.user._id], session });
        return doc;
      }
      if (chain.afterApprove) await chain.afterApprove(session);
      await afterDecision(chain, doc, 'approved', session);
      return doc;
    }),
    reject: run(async (req, v, chain, session) => {
      const doc = await mc.reject(chain, v, { req, reason: req.body.reason, session });
      await afterDecision(chain, doc, 'rejected', session);
      return doc;
    }),
    discard: run((req, v, chain, session) => mc.discard(chain, v, { req, session })),
  };
}

async function versionDetail(req, v, chain) {
  const [comparison, names] = await Promise.all([mc.comparison(chain, v), namesOf(peopleIn([v]))]);
  return { ...meta(v, names), values: values(chain.fields, v), comparison, ...permissionsFor(req, v), ...(chain.extra ? await chain.extra(v) : {}) };
}

async function loadProductChainVersion(vid) {
  const { version, product } = await loadProductVersion(vid);
  const chain = {
    ...productChain(product),
    extra: async () => ({ product: { id: String(product._id), code: product.code, status: product.status } }),
    afterApprove: (session) => svc.refreshProduct(product, { session }),
  };
  return { version, chain };
}

async function loadPricingVersion(vid) {
  const version = await PricingVersion.findById(vid);
  if (!version) throw notFound('Version not found.');
  return { version, chain: pricingChain() };
}

function summary(v) {
  if (!v) return null;
  return { id: String(v._id), version: v.version, state: v.state, changeType: v.changeType, effectiveFrom: localDay(v.effectiveFrom), liveFrom: v.liveFrom };
}

const ProductController = {
  async availableAgreements(req, res) {
    const now = new Date();
    const items = await AgreementTemplate.find({
      status: 'approved', sample: { $ne: true },
      $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }],
    }).select('version note effectiveFrom approvedAt').sort({ effectiveFrom: -1, approvedAt: -1 }).lean();
    res.json({ success: true, data: items.map((t) => ({
      id: String(t._id), version: t.version, note: t.note || '',
      effectiveFrom: t.effectiveFrom, approvedAt: t.approvedAt,
    })) });
  },
  /** Live products for the application form (FR-05, FR-62). */
  async listLive(req, res) {
    const live = await svc.liveProducts();
    res.json({
      success: true,
      data: live.map(({ product, version }) => ({ id: String(product._id), code: product.code, versionId: String(version._id), version: version.version, ...values(PRODUCT_FIELDS, version) })),
    });
  },

  async livePricing(req, res) {
    const v = await svc.livePricing();
    if (!v) throw notFound('No pricing is in force.');
    res.json({ success: true, data: { id: String(v._id), version: v.version, liveFrom: v.liveFrom, ...values(PRICING_FIELDS, v) } });
  },

  async adminList(req, res) {
    const products = await Product.find().sort({ code: 1 });
    const rows = [];
    for (const product of products) {
      const chain = svc.productChain(product);
      // eslint-disable-next-line no-await-in-loop
      const [live, latest, open] = await Promise.all([mc.liveAt(chain), mc.latestApproved(chain), mc.openChange(chain)]);
      const shown = live || open;
      rows.push({
        id: String(product._id),
        code: product.code,
        status: product.status,
        name: shown?.name,
        configuration: live && live.changeType !== 'deactivate' ? await require('../services/products/configReadiness').assess(live) : null,
        live: live ? { ...summary(live), ...values(PRODUCT_FIELDS, live) } : null,
        scheduled: latest && (!live || String(latest._id) !== String(live._id)) ? summary(latest) : null,
        openChange: open ? summary(open) : null,
      });
    }
    res.json({ success: true, data: rows });
  },

  async adminGet(req, res) {
    const product = await loadProduct(req.params.id);
    const versions = await ProductVersion.find({ productId: product._id }).sort({ version: -1 });
    const names = await namesOf(peopleIn(versions));
    res.json({ success: true, data: { id: String(product._id), code: product.code, status: product.status, versions: versions.map((v) => ({ ...meta(v, names), name: v.name })) } });
  },

  async create(req, res) {
    const { code, effectiveFrom, note, values: vals } = req.body;
    if (await Product.exists({ code })) throw conflict(`A product with code ${code} already exists.`, 'DUPLICATE_CODE');
    const doc = await withTransaction(async (session) => {
      const [product] = await Product.create([{ code, createdBy: req.auth.user._id }], { session });
      await audit.record({ req, action: 'product.create', description: `Product ${code} created`, entity: 'Product', entityId: String(product._id), after: { code } }, { session });
      return mc.createDraft(productChain(product), { req, values: vals, changeType: 'create', effectiveFrom, note, session });
    });
    const { chain } = await loadProductChainVersion(doc._id);
    res.status(201).json({ success: true, data: await versionDetail(req, doc, chain) });
  },

  async createDraft(req, res) {
    const product = await loadProduct(req.params.id);
    const { changeType, effectiveFrom, note } = req.body;
    if (changeType === 'deactivate' && product.status !== 'active') throw badRequest('Only an active product can be deactivated.', undefined, 'NOT_ACTIVE');
    if (product.status === 'not_live' && !(await mc.latestApproved(svc.productChain(product)))) {
      throw badRequest('This product has no approved version yet. Edit its first draft instead.', undefined, 'NO_APPROVED_VERSION');
    }
    const doc = await withTransaction((session) =>
      mc.createDraft(productChain(product), { req, values: changeType === 'deactivate' ? {} : req.body.values || {}, changeType, effectiveFrom, note, session })
    );
    const { chain } = await loadProductChainVersion(doc._id);
    res.status(201).json({ success: true, data: await versionDetail(req, doc, chain) });
  },

  productVersion: versionActions(loadProductChainVersion),

  async pricingList(req, res) {
    const chain = svc.pricingChain();
    const [versions, live, open] = await Promise.all([PricingVersion.find().sort({ version: -1 }), mc.liveAt(chain), mc.openChange(chain)]);
    const names = await namesOf(peopleIn(versions));
    res.json({
      success: true,
      data: {
        live: live ? { ...summary(live), ...values(PRICING_FIELDS, live) } : null,
        openChange: open ? summary(open) : null,
        versions: versions.map((v) => meta(v, names)),
      },
    });
  },

  async pricingDraft(req, res) {
    const doc = await withTransaction((session) => mc.createDraft(pricingChain(), { req, values: req.body.values || {}, effectiveFrom: req.body.effectiveFrom, note: req.body.note, session }));
    res.status(201).json({ success: true, data: await versionDetail(req, doc, pricingChain()) });
  },

  pricingVersion: versionActions(loadPricingVersion),
};

module.exports = ProductController;

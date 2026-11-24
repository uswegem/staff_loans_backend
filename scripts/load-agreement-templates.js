'use strict';

/* eslint-disable no-console */
// Loads the English Staff Personal Loan and Staff Car Loan agreements
// (seed/data/agreements) as approved templates and assigns each to its product.
//
//   npm run agreements:load -- --dry-run
//   npm run agreements:load -- --approved-by <username> --confirm
//
// This replaces the in-app steps (Legal Officer uploads, Head of Legal approves, product
// maker assigns, Heads of Credit and Risk approve), so it asks for the person who approved
// the text outside the system: --approved-by names a user holding templates.approve
// (Head of Legal), recorded as the approver and in the audit log.
//
// Options:
//   --personal <CODE> --car <CODE>   product codes; by default the one product whose name
//                                    says "personal", and the one that says car, vehicle or motor
//   --effective-from YYYY-MM-DD      when the templates are used from (default today)
//
// Each product gets a new approved version, a copy of its live version with the agreement
// set, live at once. It stops, changing nothing, when a product has a change waiting
// (draft or pending approval), when a template version already exists with other text, or
// when the text fails the template check. Safe to run again: what is already in place is
// left as it is.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const DIR = path.join(__dirname, '..', 'seed', 'data', 'agreements');
const LOANS = [
  { key: 'personal', label: 'Staff Personal Loan', file: 'staff-personal-loan.en.md', version: '2026.12a', match: /\bpersonal\b/i },
  { key: 'car', label: 'Staff Car Loan', file: 'staff-car-loan.en.md', version: '2026.12b', match: /\b(car|vehicle|motor)\b/i },
];

function argsOf(argv) {
  const out = { dryRun: argv.includes('--dry-run'), confirm: argv.includes('--confirm') };
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  out.approvedBy = value('--approved-by');
  out.personal = value('--personal');
  out.car = value('--car');
  out.effectiveFrom = value('--effective-from');
  return out;
}

/** opts: { dryRun, confirm, approvedBy, personal, car, effectiveFrom, ownConnection } */
async function run(opts = {}) {
  /* eslint-disable global-require */
  const { config } = require('../src/config/env');
  const { connect } = require('../src/config/db');
  const AgreementTemplate = require('../src/models/AgreementTemplate');
  const Product = require('../src/models/Product');
  const ProductVersion = require('../src/models/ProductVersion');
  const User = require('../src/models/User');
  const audit = require('../src/services/audit/auditService');
  const rbac = require('../src/services/rbac/rbacService');
  const templates = require('../src/services/agreement/templateService');
  const mc = require('../src/services/products/makerChecker');
  const { productChain, refreshProduct } = require('../src/services/products/productService');
  const { localDay, localMidnight } = require('../src/utils/dates');
  const { describeTarget } = require('./reset-staff-and-products');
  /* eslint-enable global-require */

  const target = describeTarget();
  const { dryRun = false, confirm = false, ownConnection = true } = opts;
  const effectiveFrom = opts.effectiveFrom || localDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new Error('--effective-from must be YYYY-MM-DD.');
  if (!dryRun && !confirm) throw new Error('This loads approved agreements into the system. Run with --dry-run first, then add --confirm.');
  if (!dryRun && !opts.approvedBy) throw new Error('Name the Head of Legal who approved the text: --approved-by <username>.');

  if (ownConnection) await connect(config.mongoUri);
  try {
    // The approver: a user who may approve agreement templates.
    let approver = null;
    if (opts.approvedBy) {
      const who = String(opts.approvedBy).trim();
      approver = await User.findOne({ $or: [{ userName: who.toLowerCase() }, { staffNo: who.toUpperCase() }] });
      if (!approver) throw new Error(`No user ${who}. Nothing changed.`);
      if (!(await rbac.effectiveFor(approver._id)).permissions.has('templates.approve')) throw new Error(`${who} cannot approve agreement templates (templates.approve). Name the Head of Legal. Nothing changed.`);
    }

    // The products: by code when given, otherwise the one product whose name matches.
    const products = await Product.find().lean();
    const plan = [];
    for (const loan of LOANS) {
      /* eslint-disable no-await-in-loop */
      const code = opts[loan.key];
      let product;
      if (code) {
        product = products.find((p) => p.code === String(code).toUpperCase());
        if (!product) throw new Error(`No product with code ${code}. Nothing changed.`);
      } else {
        const named = [];
        for (const p of products) {
          const live = await mc.liveAt(productChain(p));
          if (live && loan.match.test(live.name)) named.push({ p, live });
        }
        if (named.length !== 1) throw new Error(`${named.length ? 'Several' : 'No'} live products look like the ${loan.label} (${named.map((x) => `${x.p.code} ${x.live.name}`).join(', ') || 'none'}). Give the code with --${loan.key}. Nothing changed.`);
        product = named[0].p;
      }
      const live = await mc.liveAt(productChain(product));
      if (!live) throw new Error(`${product.code} has no live version. Nothing changed.`);
      const open = await mc.openChange(productChain(product));
      if (open) throw new Error(`${product.code} has a change waiting (version ${open.version}, ${open.state}). Approve, reject or discard it first. Nothing changed.`);

      const body = fs.readFileSync(path.join(DIR, loan.file), 'utf8');
      const checked = await templates.check(body, loan.version, 'en');
      const existing = await AgreementTemplate.findOne({ version: loan.version });
      if (existing && (existing.body !== body || existing.language !== 'en')) throw new Error(`Template version ${loan.version} already exists with other text. Nothing changed.`);
      plan.push({ loan, product, live, body, checked, existing, assigned: existing && String(live.agreementTemplateId) === String(existing._id) });
      /* eslint-enable no-await-in-loop */
    }

    const summary = plan.map((x) => ({
      loan: x.loan.label,
      template: `${x.loan.version} (English, ${x.checked.declarations.length} declarations)${x.existing ? ', already loaded' : ''}`,
      product: `${x.product.code} ${x.live.name}, live version ${x.live.version}${x.assigned ? ', already uses it' : ''}`,
    }));
    if (dryRun) return { target, dryRun: true, effectiveFrom, summary };

    const now = new Date();
    const done = [];
    for (const x of plan) {
      /* eslint-disable no-await-in-loop */
      let t = x.existing;
      if (!t) {
        t = await AgreementTemplate.create({
          version: x.loan.version,
          language: 'en',
          status: 'approved',
          body: x.body,
          sample: false,
          effectiveFrom: localMidnight(effectiveFrom),
          approvedBy: approver._id,
          approvedAt: now,
          note: `${x.loan.label} agreement loaded by scripts/load-agreement-templates.js; approved outside the system by ${approver.userName || approver.staffNo}.`,
        });
        await audit.record({ action: 'template.load', description: `Agreement template ${t.version} (${x.loan.label}, English) loaded by script as approved; approved outside the system by ${approver.userName || approver.staffNo}`, entity: 'AgreementTemplate', entityId: String(t._id), after: { version: t.version, language: 'en', status: 'approved', approvedBy: approver.staffNo, effectiveFrom, sampleSha256: x.checked.textSha256 } });
        done.push(`Loaded template ${t.version} for the ${x.loan.label}`);
      }
      if (String(x.live.agreementTemplateId) !== String(t._id)) {
        const copy = x.live.toObject();
        ['_id', 'createdAt', 'updatedAt', '__v', 'submittedAt', 'submittedBy', 'checkerId', 'decidedAt', 'rejectionReason'].forEach((k) => delete copy[k]);
        const last = await ProductVersion.findOne({ productId: x.product._id }).sort({ version: -1 }).select('version').lean();
        const next = await ProductVersion.create({
          ...copy,
          version: last.version + 1,
          state: 'approved_scheduled',
          changeType: 'change',
          basedOnVersionId: x.live._id,
          agreementTemplateId: t._id,
          effectiveFrom: localMidnight(localDay(now)),
          approvedAt: now,
          liveFrom: now,
          stage: null,
          approvals: [],
          editors: [],
          makerId: null,
          note: `Agreement ${t.version} assigned by scripts/load-agreement-templates.js; otherwise the same as version ${x.live.version}.`,
        });
        await refreshProduct(await Product.findById(x.product._id), { now: new Date() });
        await audit.record({ action: 'product.agreement_assign', description: `${x.live.name} (${x.product.code}) version ${next.version} uses agreement ${t.version}; assigned by script, approved outside the system by ${approver.userName || approver.staffNo}`, entity: 'ProductVersion', entityId: String(next._id), before: { version: x.live.version, agreementTemplateId: x.live.agreementTemplateId ? String(x.live.agreementTemplateId) : null }, after: { version: next.version, agreementTemplateId: String(t._id) } });
        done.push(`${x.product.code} ${x.live.name}: version ${next.version} uses agreement ${t.version}`);
      }
      /* eslint-enable no-await-in-loop */
    }
    return { target, dryRun: false, effectiveFrom, summary, done };
  } finally {
    if (ownConnection) await mongoose.disconnect();
  }
}

if (require.main === module) {
  run(argsOf(process.argv.slice(2)))
    .then((r) => {
      console.log(`Environment: NODE_ENV=${r.target.nodeEnv}; database "${r.target.db}" on ${r.target.host}:${r.target.port}`);
      console.log(`${r.dryRun ? 'Would load' : 'Plan'} (used from ${r.effectiveFrom}):`);
      r.summary.forEach((s) => console.log(`  ${s.loan}: template ${s.template} -> ${s.product}`));
      if (r.done) console.log(r.done.length ? `Done:\n  ${r.done.join('\n  ')}` : 'Nothing to change: already in place.');
    })
    .catch(async (err) => {
      console.error(`Stopped: ${err.message}`);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run, argsOf, LOANS };

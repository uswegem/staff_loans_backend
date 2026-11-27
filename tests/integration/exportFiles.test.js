'use strict';

// scripts/export-files.js: lists by default; with --out copies each file under its original
// name, checks it against its stored SHA-256, writes manifest.csv and audits the run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedAll, applyAndSign, signIn } = require('../flows');
const { run, argsOf, uniqueName } = require('../../scripts/export-files');
const Application = require('../../src/models/Application');
const AuditLog = require('../../src/models/AuditLog');
const StoredFile = require('../../src/models/StoredFile');
const { config } = require('../../src/config/env');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(120000);

let products;
let out;
beforeEach(async () => {
  ({ products } = await seedAll());
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'slas-export-'));
});
afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

async function submitted() {
  const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' });
  return Application.findById(id).lean();
}

describe('file export script', () => {
  it('reads its options', () => {
    expect(argsOf(['--by', 'grace', '--application', 'SL-2026-00001', '--kind', 'payslip', '--out', 'x', '--include-removed'])).toEqual({ by: 'grace', application: 'SL-2026-00001', from: undefined, to: undefined, kind: 'payslip', out: 'x', includeRemoved: true });
    const used = new Set();
    expect(['a.pdf', 'a.pdf', 'A.pdf'].map((n) => uniqueName(n, used))).toEqual(['a.pdf', 'a (2).pdf', 'A (3).pdf']);
  });

  it('refuses without who is exporting, a scope, or with a bad option', async () => {
    await expect(run({ application: 'SL-2026-00001' })).rejects.toThrow(/--by/);
    await expect(run({ by: 'LFB0051' })).rejects.toThrow(/Choose what to export/);
    await expect(run({ by: 'LFB0051', from: '01/11/2026' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(run({ by: 'LFB0051', application: 'SL-2026-00001', kind: 'salary' })).rejects.toThrow(/--kind/);
    await expect(run({ by: 'nobody', application: 'SL-2026-00001' })).rejects.toThrow(/No user/);
    await expect(run({ by: 'LFB0051', application: 'SL-1999-00001' })).rejects.toThrow(/No application/);
  });

  it('a dry run lists the files and copies nothing', async () => {
    const app = await submitted();
    const r = await run({ by: 'LFB0051', application: app.ref });
    expect(r).toMatchObject({ dryRun: true, exported: 0 });
    expect(r.rows.map((x) => x.kind).sort()).toEqual(['agreement_pdf', 'payslip']);
    expect(fs.readdirSync(out)).toEqual([]);
    expect(await AuditLog.countDocuments({ action: 'file.export' })).toBe(0);
  });

  it('exports under original names, checks each file, writes the manifest and audits', async () => {
    const app = await submitted();
    const r = await run({ by: 'LFB0051', application: app.ref, out });
    expect(r).toMatchObject({ dryRun: false, matched: 2, exported: 2, problems: [] });
    const files = await StoredFile.find({ applicationId: app._id }).lean();
    for (const f of files) {
      const copied = path.join(out, app.ref, f.kind, f.originalName);
      expect(fs.existsSync(copied)).toBe(true);
      expect(fs.readFileSync(copied).equals(fs.readFileSync(path.join(config.uploadDir, f.storageKey)))).toBe(true);
    }
    const manifest = fs.readFileSync(path.join(out, 'manifest.csv'), 'utf8').trim().split('\n');
    expect(manifest[0]).toBe('"File id","Application","Kind","Original name","Size (bytes)","Uploaded","Removed in app","SHA-256","Exported as","Status"');
    expect(manifest).toHaveLength(3);
    expect(manifest.slice(1).every((l) => l.endsWith('"exported"'))).toBe(true);
    const log = await AuditLog.findOne({ action: 'file.export' }).lean();
    expect(log).toMatchObject({ actorStaffNo: 'LFB0051', appRef: app.ref, after: { matched: 2, exported: 2, notExported: 0 } });
    expect(log.description).toMatch(new RegExp(`2 of 2 uploaded files exported by script \\(application ${app.ref}\\)`));

    // Exporting again into the same folder never overwrites: the copies get " (2)".
    const again = await run({ by: 'LFB0051', application: app.ref, kind: 'payslip', out });
    expect(again.rows[0].exportedAs).toMatch(/payslip\/.+ \(2\)\.pdf$/);
  });

  it('by date range and kind; removed files only with --include-removed', async () => {
    const app = await submitted();
    const payslip = await StoredFile.findOne({ applicationId: app._id, kind: 'payslip' });
    await StoredFile.updateOne({ _id: payslip._id }, { $set: { removedAt: new Date() } });
    const today = localDay();
    expect((await run({ by: 'LFB0051', from: today, to: today, kind: 'payslip' })).matched).toBe(0);
    expect((await run({ by: 'LFB0051', from: today, to: today, kind: 'payslip', includeRemoved: true })).rows[0]).toMatchObject({ kind: 'payslip', removed: 'yes' });
    expect((await run({ by: 'LFB0051', to: '2020-01-01' })).matched).toBe(0);
  });

  it('a file changed or missing on disk is reported and not copied', async () => {
    const app = await submitted();
    const [a, b] = await StoredFile.find({ applicationId: app._id }).sort({ kind: 1 }).lean();
    fs.appendFileSync(path.join(config.uploadDir, a.storageKey), 'tampered');
    fs.rmSync(path.join(config.uploadDir, b.storageKey));
    const r = await run({ by: 'LFB0051', application: app.ref, out });
    expect(r.exported).toBe(0);
    expect(r.rows.map((x) => x.status).sort()).toEqual(['checksum mismatch', 'missing on disk']);
    expect(r.problems).toHaveLength(2);
    expect((await AuditLog.findOne({ action: 'file.export' }).lean()).after).toMatchObject({ exported: 0, notExported: 2 });
  });
});

'use strict';

/* eslint-disable no-console */
// Exports uploaded files from UPLOAD_DIR to a folder, under their original names, for an
// audit request, a records transfer or a backup check. Server administrators only: it reads
// the files directly, outside the app's access checks, so every export run is recorded in
// the audit log (file.export) with who ran it and what was exported.
//
// Dry run by default: it lists the files that match and copies nothing. Give --out to copy.
//
//   npm run files:export -- --by <username> --application SL-2026-00031
//   npm run files:export -- --by <username> --from 2026-11-01 --to 2026-11-30 --out D:\export
//   npm run files:export -- --by <username> --application SL-2026-00031 --kind agreement_pdf --out D:\export
//
// Options
//   --by <username|staff no>   who is exporting (required; must be an active user)
//   --application <ref|id>     one application, by reference (SL-YYYY-NNNNN) or id
//   --from / --to YYYY-MM-DD   uploaded on or after / on or before these days (East Africa time)
//   --kind <kind>              document, payslip, crb_report, agreement_pdf or brand_logo
//   --include-removed          also files removed in the app (kept on disk)
//   --out <folder>             copy the files here (created if missing; nothing is overwritten)
//
// Layout: <out>/<application ref or "no-application">/<kind>/<original name>, with " (2)", " (3)"
// added when two files share a name, and <out>/manifest.csv listing every file with its
// SHA-256. Each copy is checked against the SHA-256 stored at upload; a file that is missing
// or does not match is reported and not copied.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const StoredFile = require('../src/models/StoredFile');
const Application = require('../src/models/Application');
const User = require('../src/models/User');
const audit = require('../src/services/audit/auditService');
const { localMidnight } = require('../src/utils/dates');

const KINDS = ['document', 'payslip', 'crb_report', 'agreement_pdf', 'brand_logo'];
const DAY = 24 * 3600 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function argsOf(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { by: value('--by'), application: value('--application'), from: value('--from'), to: value('--to'), kind: value('--kind'), out: value('--out'), includeRemoved: argv.includes('--include-removed') };
}

// Characters Windows and Linux do not allow in a file name, and control characters.
// eslint-disable-next-line no-control-regex
const safe = (name) => String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 180) || 'file';
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** A name not yet used in the folder: "a.pdf", then "a (2).pdf", "a (3).pdf". */
function uniqueName(name, used) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** opts: { by, application, from, to, kind, out, includeRemoved, uploadDir }. */
async function run(opts = {}) {
  if (!opts.by) throw new Error('Name who is exporting: --by <username or staff number>.');
  if (!opts.application && !opts.from && !opts.to) throw new Error('Choose what to export: --application <ref or id>, or a date range with --from and/or --to.');
  for (const [flag, v] of [['--from', opts.from], ['--to', opts.to]]) if (v && !DAY_RE.test(v)) throw new Error(`${flag} must be a date as YYYY-MM-DD.`);
  if (opts.kind && !KINDS.includes(opts.kind)) throw new Error(`--kind must be one of: ${KINDS.join(', ')}.`);

  const who = String(opts.by);
  const user = await User.findOne({ $or: [{ userName: who.toLowerCase() }, { staffNo: who.toUpperCase() }] });
  if (!user) throw new Error(`No user "${who}".`);
  if (user.status && user.status !== 'active') throw new Error(`User "${who}" is not active.`);

  const filter = {};
  let app = null;
  if (opts.application) {
    const key = String(opts.application).trim();
    app = await Application.findOne(mongoose.isValidObjectId(key) ? { _id: key } : { ref: key.toUpperCase() }).select('ref').lean();
    if (!app) throw new Error(`No application "${key}".`);
    filter.applicationId = app._id;
  }
  if (opts.from || opts.to) {
    filter.createdAt = {};
    if (opts.from) filter.createdAt.$gte = localMidnight(opts.from);
    if (opts.to) filter.createdAt.$lt = new Date(localMidnight(opts.to).getTime() + DAY);
  }
  if (opts.kind) filter.kind = opts.kind;
  if (!opts.includeRemoved) filter.removedAt = null;

  const files = await StoredFile.find(filter).sort({ createdAt: 1 }).lean();
  const refs = new Map((await Application.find({ _id: { $in: [...new Set(files.map((f) => String(f.applicationId)).filter((x) => x !== 'undefined'))] } }).select('ref').lean()).map((a) => [String(a._id), a.ref]));
  const refOf = (f) => (f.applicationId ? refs.get(String(f.applicationId)) || String(f.applicationId) : 'no-application');
  const out = { dryRun: !opts.out, matched: files.length, exported: 0, problems: [], rows: [] };

  const uploadDir = opts.uploadDir || config.uploadDir;
  const used = new Map();
  if (opts.out) await fs.mkdir(opts.out, { recursive: true });

  for (const f of files) {
    const row = { id: String(f._id), ref: refOf(f), kind: f.kind, originalName: f.originalName, size: f.size, uploadedAt: f.createdAt?.toISOString(), removed: f.removedAt ? 'yes' : '', sha256: f.sha256, exportedAs: '', status: 'listed' };
    out.rows.push(row);
    if (!opts.out) continue;
    let buffer;
    try {
      // eslint-disable-next-line no-await-in-loop
      buffer = await fs.readFile(path.join(uploadDir, f.storageKey));
    } catch {
      row.status = 'missing on disk';
      out.problems.push(`${row.ref} ${f.originalName}: missing on disk (${f.storageKey})`);
      continue;
    }
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== f.sha256) {
      row.status = 'checksum mismatch';
      out.problems.push(`${row.ref} ${f.originalName}: the file on disk does not match its stored SHA-256; not copied`);
      continue;
    }
    const dir = path.join(opts.out, safe(row.ref), f.kind);
    if (!used.has(dir)) {
      // Names already in the folder (an earlier export) count as used: nothing is overwritten.
      // eslint-disable-next-line no-await-in-loop
      const existing = await fs.readdir(dir).catch(() => []);
      used.set(dir, new Set(existing.map((n) => n.toLowerCase())));
    }
    const name = uniqueName(safe(f.originalName), used.get(dir));
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(dir, { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(path.join(dir, name), buffer, { flag: 'wx' }); // never overwrites
    row.exportedAs = path.relative(opts.out, path.join(dir, name)).split(path.sep).join('/');
    row.status = 'exported';
    out.exported += 1;
  }

  if (opts.out) {
    const head = ['File id', 'Application', 'Kind', 'Original name', 'Size (bytes)', 'Uploaded', 'Removed in app', 'SHA-256', 'Exported as', 'Status'];
    const lines = [head.map(csv).join(','), ...out.rows.map((r) => [r.id, r.ref, r.kind, r.originalName, r.size, r.uploadedAt, r.removed, r.sha256, r.exportedAs, r.status].map(csv).join(','))];
    await fs.writeFile(path.join(opts.out, 'manifest.csv'), `${lines.join('\n')}\n`, { flag: 'w' });
    const scope = [app ? `application ${app.ref}` : null, opts.from || opts.to ? `uploaded ${opts.from || '…'} to ${opts.to || '…'}` : null, opts.kind ? `kind ${opts.kind}` : null, opts.includeRemoved ? 'including removed files' : null].filter(Boolean).join(', ');
    await audit.record({
      actor: user,
      action: 'file.export',
      description: `${out.exported} of ${out.matched} uploaded files exported by script (${scope}) to ${path.resolve(opts.out)}${out.problems.length ? `; ${out.problems.length} not exported` : ''}`,
      entity: 'StoredFile',
      appRef: app?.ref,
      after: { scope, out: path.resolve(opts.out), matched: out.matched, exported: out.exported, notExported: out.problems.length, fileIds: out.rows.filter((r) => r.status === 'exported').map((r) => r.id) },
    });
  }
  return out;
}

if (require.main === module) {
  const opts = argsOf(process.argv.slice(2));
  connect(config.mongoUri)
    .then(() => run(opts))
    .then((r) => {
      console.log(r.dryRun ? 'DRY RUN: nothing is copied. Add --out <folder> to export.' : 'Export done.');
      r.rows.forEach((x) => console.log(`  ${x.ref}  ${x.kind.padEnd(13)}  ${x.originalName}${x.removed ? '  (removed in app)' : ''}${r.dryRun ? '' : `  -> ${x.exportedAs || x.status}`}`));
      console.log(`${r.matched} file(s) matched${r.dryRun ? '' : `; ${r.exported} exported; manifest.csv written`}.`);
      if (r.problems.length) {
        console.log('Not exported:');
        r.problems.forEach((p) => console.log(`  ${p}`));
      }
      return mongoose.disconnect().then(() => process.exit(r.problems.length ? 2 : 0));
    })
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run, argsOf, uniqueName };

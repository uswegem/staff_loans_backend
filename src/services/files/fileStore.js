'use strict';

// File storage for documents and agreement PDFs (BRD NFR-07, FR-09):
// - only PDF, JPG and PNG, recognised by their first bytes, not the name or browser type
// - stored under UPLOAD_DIR with a random name, never inside a web root
// - scanned before use through a malware-scanner interface (stub for now)

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const StoredFile = require('../../models/StoredFile');
const { config } = require('../../config/env');
const scanner = require('./malwareScanner');
const { badRequest } = require('../../utils/errors');

const SIGNATURES = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
];

function sniff(buffer) {
  const hit = SIGNATURES.find((s) => s.bytes.every((b, i) => buffer[i] === b));
  return hit ? hit.mime : null;
}

const safeName = (name) => String(name || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 200);

/**
 * Stores a file and creates its record. Refuses types other than PDF, JPG and PNG,
 * and files the scanner flags.
 */
async function store(buffer, { kind, originalName, label, documentCode, applicationId, ownerUserId, uploadedBy }, { session } = {}) {
  const mime = sniff(buffer);
  if (!mime) throw badRequest('Only PDF, JPG and PNG files can be uploaded.', { file: ['Only PDF, JPG and PNG files can be uploaded.'] }, 'FILE_TYPE');
  const scan = await scanner.scan(buffer, { originalName });
  if (scan.status !== 'clean') throw badRequest('This file did not pass the virus check.', { file: ['This file did not pass the virus check.'] }, 'FILE_INFECTED');

  const now = new Date();
  const storageKey = path.posix.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), crypto.randomBytes(16).toString('hex'));
  const full = path.join(config.uploadDir, storageKey);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer, { flag: 'wx' });
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const [doc] = await StoredFile.create(
    [{ kind, applicationId, ownerUserId, uploadedBy, label, documentCode, originalName: safeName(originalName), mime, size: buffer.length, sha256, storageKey, scan: { status: scan.status, at: now, engine: scan.engine } }],
    { session }
  );
  return doc;
}

async function read(file) {
  return fs.readFile(path.join(config.uploadDir, file.storageKey));
}

/** Streams a stored file as a download with safe headers. */
async function send(res, file, { inline = false } = {}) {
  const buffer = await read(file);
  res.set('Content-Type', file.mime);
  res.set('Content-Length', String(buffer.length));
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName(file.originalName).replace(/"/g, '')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buffer);
}

module.exports = { store, read, send, sniff };

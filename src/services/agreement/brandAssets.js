'use strict';

// The logo printed on agreements and repayment schedules (D-110). The default is the LFB
// artwork in assets/agreement/lfb-logo.png (the same as the web app's); a System
// Administrator may replace it under Settings (PNG or JPG, audited), or go back to it.

const fs = require('fs');
const path = require('path');
const Settings = require('../../models/Settings');
const StoredFile = require('../../models/StoredFile');
const fileStore = require('../files/fileStore');
const audit = require('../audit/auditService');
const { badRequest } = require('../../utils/errors');

const DEFAULT_LOGO = path.join(__dirname, '..', '..', '..', 'assets', 'agreement', 'lfb-logo.png');
let defaultBytes = null;
const MAX_BYTES = 1024 * 1024;

/** The logo bytes in use (PNG or JPG). */
async function logoBytes() {
  const s = await Settings.get();
  if (s.agreementLogoFileId) {
    const f = await StoredFile.findOne({ _id: s.agreementLogoFileId, removedAt: null });
    if (f) return fileStore.read(f);
  }
  defaultBytes = defaultBytes || fs.readFileSync(DEFAULT_LOGO);
  return defaultBytes;
}

/** { custom, fileId, originalName, uploadedAt } for the Settings screen. */
async function logoInfo() {
  const s = await Settings.get();
  const f = s.agreementLogoFileId ? await StoredFile.findById(s.agreementLogoFileId).lean() : null;
  return f ? { custom: true, fileId: String(f._id), originalName: f.originalName, uploadedAt: f.createdAt } : { custom: false, fileId: null, originalName: 'lfb-logo.png', uploadedAt: null };
}

/** Replaces the logo (System Administrator). */
async function replaceLogo(req, file) {
  if (!file?.buffer?.length) throw badRequest('Choose a file.', { file: ['Choose a file.'] }, 'FILE_REQUIRED');
  if (file.buffer.length > MAX_BYTES) throw badRequest('The logo must be 1 MB or smaller.', { file: ['The logo must be 1 MB or smaller.'] }, 'FILE_TOO_LARGE');
  const mime = fileStore.sniff(file.buffer);
  if (!['image/png', 'image/jpeg'].includes(mime)) throw badRequest('The logo must be a PNG or JPG image.', { file: ['The logo must be a PNG or JPG image.'] }, 'FILE_TYPE');
  const s = await Settings.get();
  const before = await logoInfo();
  const stored = await fileStore.store(file.buffer, { kind: 'brand_logo', originalName: file.originalname, uploadedBy: req.auth.user._id });
  if (s.agreementLogoFileId) await StoredFile.updateOne({ _id: s.agreementLogoFileId }, { $set: { removedAt: new Date(), removedBy: req.auth.user._id } });
  await Settings.updateOne({ _id: s._id }, { $set: { agreementLogoFileId: stored._id } });
  await audit.record({ req, action: 'settings.agreement_logo', description: `Agreement logo replaced with ${stored.originalName}`, entity: 'Settings', entityId: 'global', before, after: { fileId: String(stored._id), originalName: stored.originalName, sha256: stored.sha256 } });
  return logoInfo();
}

/** Goes back to the default LFB logo. */
async function resetLogo(req) {
  const s = await Settings.get();
  const before = await logoInfo();
  if (s.agreementLogoFileId) await StoredFile.updateOne({ _id: s.agreementLogoFileId }, { $set: { removedAt: new Date(), removedBy: req.auth.user._id } });
  await Settings.updateOne({ _id: s._id }, { $set: { agreementLogoFileId: null } });
  await audit.record({ req, action: 'settings.agreement_logo', description: 'Agreement logo set back to the default LFB logo', entity: 'Settings', entityId: 'global', before, after: { custom: false } });
  return logoInfo();
}

module.exports = { logoBytes, logoInfo, replaceLogo, resetLogo, DEFAULT_LOGO };

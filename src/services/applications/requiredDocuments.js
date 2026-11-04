'use strict';

const ProductVersion = require('../../models/ProductVersion');
const StoredFile = require('../../models/StoredFile');
const { badRequest } = require('../../utils/errors');

const extension = (mime) => ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' })[mime];
const applicable = (version) => (version.requiredDocuments || []).filter((d) => d.active !== false);

async function validateUpload(app, code, file, settings) {
  const version = await ProductVersion.findById(app.productVersionId).lean();
  if (!version) throw badRequest('The product configuration is unavailable.');
  const requirements = applicable(version);
  if (!requirements.length) {
    if (code) throw badRequest('This product does not define document categories.');
    return undefined;
  }
  const req = requirements.find((d) => d.code === code);
  if (!req) throw badRequest('Choose a valid document category.', { documentCode: ['Select a configured document category.'] });
  const type = extension(file.mimetype);
  if (!type || !req.allowedTypes.some((allowed) => allowed === type || (type === 'jpg' && allowed === 'jpeg'))) {
    throw badRequest('This file type is not allowed for the selected document category.');
  }
  if (file.size > Math.min(req.maxFileMb, settings.maxUploadMb) * 1024 * 1024) {
    throw badRequest('This file exceeds the category size limit.');
  }
  const files = await StoredFile.countDocuments({ applicationId: app._id, kind: 'document', documentCode: code, removedAt: null });
  if (files >= req.maxFiles) throw badRequest('Maximum files already uploaded for this category.');
  return code;
}

async function validateAttachments(app, version) {
  const required = applicable(version).filter((d) => d.mandatory);
  if (!required.length) return;
  const files = await StoredFile.find({ _id: { $in: app.documentIds }, applicationId: app._id, kind: 'document', removedAt: null }).lean();
  const missing = required.filter((d) => files.filter((f) => f.documentCode === d.code && f.size <= d.maxFileMb * 1024 * 1024 && d.allowedTypes.some((type) => type === extension(f.mime) || (type === 'jpeg' && extension(f.mime) === 'jpg')) && f.scan?.status !== 'infected').length < d.minFiles);
  if (missing.length) throw badRequest('Upload the required supporting documents before signing.', { documents: missing.map((d) => d.name) }, 'DOCUMENTS_REQUIRED');
}

module.exports = { validateUpload, validateAttachments };

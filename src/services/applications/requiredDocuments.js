'use strict';

const ProductVersion = require('../../models/ProductVersion');
const products = require('../products/productService');
const { sniff } = require('../files/fileStore');
const StoredFile = require('../../models/StoredFile');
const { badRequest } = require('../../utils/errors');

const normalize = (value) => String(value ?? '').trim().toLowerCase();
const extension = (mime) => ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' })[normalize(mime)];
const normalizedType = (type) => normalize(type) === 'jpeg' ? 'jpg' : normalize(type);
const applicable = (version) => (version.requiredDocuments || []).filter((d) => d.active !== false);

async function validateUpload(app, code, file, settings) {
  const current = ['draft', 'returned'].includes(app.status) ? await products.liveProductVersion(app.productId) : null;
  const version = current?.version || await ProductVersion.findById(app.productVersionId).lean();
  if (!version) throw badRequest('The product configuration is unavailable.');
  const requirements = applicable(version);
  if (!requirements.length) {
    if (code) throw badRequest('This product does not define document categories.');
    return undefined;
  }
  const req = requirements.find((d) => normalize(d.code) === normalize(code));
  if (!req) throw badRequest('Choose a valid document category.', { documentCode: ['Select a configured document category.'] });
  const type = extension(sniff(file.buffer));
  if (!type || !req.allowedTypes.some((allowed) => normalizedType(allowed) === type)) {
    throw badRequest('This file type is not allowed for the selected document category.');
  }
  if (file.size > Math.min(req.maxFileMb, settings.maxUploadMb) * 1024 * 1024) {
    throw badRequest('This file exceeds the category size limit.');
  }
  const files = await StoredFile.find({ _id: { $in: app.documentIds }, applicationId: app._id, kind: 'document', removedAt: null }).select('documentCode').lean();
  if (files.filter((f) => normalize(f.documentCode) === normalize(req.code)).length >= req.maxFiles) {
    throw badRequest('Maximum files already uploaded for this category.');
  }
  return req.code;
}

async function validateAttachments(app, version) {
  const required = applicable(version).filter((d) => d.mandatory);
  if (!required.length) return;
  const files = await StoredFile.find({ _id: { $in: app.documentIds }, applicationId: app._id, kind: 'document', removedAt: null }).lean();
  const missing = required.filter((d) => files.filter((f) =>
    normalize(f.documentCode) === normalize(d.code) &&
    f.size <= d.maxFileMb * 1024 * 1024 &&
    d.allowedTypes.some((type) => normalizedType(type) === extension(f.mime))
  ).length < d.minFiles);
  if (missing.length) throw badRequest('Upload the required supporting documents before submitting.', { documents: missing.map((d) => d.name) }, 'DOCUMENTS_REQUIRED');
}

module.exports = { validateUpload, validateAttachments };

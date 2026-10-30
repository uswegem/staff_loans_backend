'use strict';

// Applicant endpoints (BRD 9.2, 8). Every route checks that the application belongs
// to the signed-in staff member; reviewers' access arrives with milestone 5.

const Application = require('../models/Application');
const Agreement = require('../models/Agreement');
const StoredFile = require('../models/StoredFile');
const Settings = require('../models/Settings');
const ProductVersion = require('../models/ProductVersion');
const svc = require('../services/applications/applicationService');
const fileStore = require('../services/files/fileStore');
const audit = require('../services/audit/auditService');
const { STATUS, EDITABLE } = require('../constants/statuses');
const { withTransaction } = require('../config/db');
const { badRequest, conflict, notFound } = require('../utils/errors');
const workflow = require('../services/workflow/workflowService');

/**
 * Files and agreements: the applicant, or a reviewer with the full view. Never a
 * limited (FR-55) viewer: documents and the agreement are among the hidden fields.
 */
async function canSee(req, applicationId) {
  const app = await Application.findById(applicationId);
  if (!app) return null;
  if (String(app.applicantUserId) === String(req.auth.user._id)) return { app, as: 'applicant' };
  const access = await workflow.reviewAccess(req.auth, app);
  return access && !access.limited ? { app, as: 'reviewer' } : null;
}

const ApplicationController = {
  async list(req, res) {
    const apps = await Application.find({ applicantUserId: req.auth.user._id }).sort({ createdAt: -1 }).lean();
    const versions = await ProductVersion.find({ _id: { $in: apps.map((a) => a.productVersionId) } }).select('name').lean();
    const names = new Map(versions.map((v) => [String(v._id), v.name]));
    res.json({
      success: true,
      data: apps.map((a) => ({
        id: String(a._id),
        ref: a.ref,
        product: names.get(String(a.productVersionId)),
        amount: a.approved?.amount || a.amount || null,
        tenor: a.approved?.tenor || a.tenor || null,
        status: a.status,
        statusLabel: STATUS[a.status],
        currentStage: a.currentStage,
        route: a.route,
        stages: a.stages,
        stageDueAt: a.stageDueAt,
        submittedAt: a.submittedAt,
        updatedAt: a.updatedAt,
      })),
    });
  },

  async create(req, res) {
    const app = await svc.createDraft(req, req.body.productId);
    res.status(201).json({ success: true, data: await svc.view(req, app) });
  },

  async get(req, res) {
    res.json({ success: true, data: await svc.view(req, await svc.own(req, req.params.id)) });
  },

  async update(req, res) {
    const app = await svc.update(req, await svc.own(req, req.params.id), req.body);
    res.json({ success: true, data: await svc.view(req, app) });
  },

  async preview(req, res) {
    res.json({ success: true, data: await svc.preview(req, await svc.own(req, req.params.id)) });
  },

  async signAndSubmit(req, res) {
    const app = await svc.signAndSubmit(req, await svc.own(req, req.params.id), req.body);
    res.json({ success: true, data: await svc.view(req, app) });
  },

  async withdraw(req, res) {
    const app = await svc.withdraw(req, await svc.own(req, req.params.id), req.body.reason);
    res.json({ success: true, data: await svc.view(req, app) });
  },

  // ---------- documents (FR-09: optional; PDF, JPG, PNG) ----------

  async addDocument(req, res) {
    const app = await svc.own(req, req.params.id);
    if (!EDITABLE.includes(app.status)) throw conflict('Documents can be added while the application is a draft or returned to you.', 'NOT_EDITABLE');
    if (!req.file) throw badRequest('Choose a file.', { file: ['Choose a file.'] });
    const settings = await Settings.get();
    if (req.file.size > settings.maxUploadMb * 1024 * 1024) throw badRequest(`Files can be up to ${settings.maxUploadMb} MB.`, { file: [`Files can be up to ${settings.maxUploadMb} MB.`] }, 'FILE_TOO_LARGE');
    if (app.documentIds.length >= 20) throw badRequest('You can attach up to 20 documents.', undefined, 'TOO_MANY_FILES');
    const file = await withTransaction(async (session) => {
      const f = await fileStore.store(req.file.buffer, { kind: 'document', originalName: req.file.originalname, label: req.body.label, applicationId: app._id, ownerUserId: req.auth.user._id, uploadedBy: req.auth.user._id }, { session });
      await Application.updateOne({ _id: app._id }, { $push: { documentIds: f._id } }, { session });
      await audit.record({ req, action: 'document.upload', description: `${app.ref}: ${f.originalName} uploaded`, entity: 'Application', entityId: String(app._id), appRef: app.ref, after: { fileId: String(f._id), sha256: f.sha256, size: f.size } }, { session });
      return f;
    });
    res.status(201).json({ success: true, data: svc.DOC_VIEW(file) });
  },

  async removeDocument(req, res) {
    const app = await svc.own(req, req.params.id);
    if (!EDITABLE.includes(app.status)) throw conflict('Documents can be removed while the application is a draft or returned to you.', 'NOT_EDITABLE');
    const file = await StoredFile.findOne({ _id: req.params.fileId, applicationId: app._id, kind: 'document', removedAt: null });
    if (!file) throw notFound('Document not found.');
    await withTransaction(async (session) => {
      await StoredFile.updateOne({ _id: file._id }, { $set: { removedAt: new Date() } }, { session });
      await Application.updateOne({ _id: app._id }, { $pull: { documentIds: file._id } }, { session });
      await audit.record({ req, action: 'document.remove', description: `${app.ref}: ${file.originalName} removed`, entity: 'Application', entityId: String(app._id), appRef: app.ref, before: { fileId: String(file._id) } }, { session });
    });
    res.json({ success: true, message: 'Document removed.' });
  },

  /** Own documents and agreement PDFs only. Reviewer access joins in milestone 5. */
  async file(req, res) {
    const file = await StoredFile.findById(req.params.id);
    const own = file && String(file.ownerUserId) === String(req.auth.user._id) && file.kind !== 'crb_report';
    const uploader = file && file.kind === 'crb_report' && String(file.uploadedBy) === String(req.auth.user._id);
    // The applicant sees their own documents and agreement PDFs; the bureau report is
    // for reviewers only (and the Credit Analyst who attached it).
    const allowed = file && !file.removedAt && (own || uploader || (await canSee(req, file.applicationId))?.as === 'reviewer');
    if (!allowed) throw notFound('File not found.');
    await audit.record({ req, action: 'file.download', description: `${file.originalName} downloaded`, entity: 'StoredFile', entityId: String(file._id) });
    await fileStore.send(res, file);
  },

  // ---------- agreements (FR-25, FR-37) ----------

  async agreement(req, res) {
    const ag = await Agreement.findById(req.params.id).lean();
    const seen = ag && (await canSee(req, ag.applicationId));
    if (!seen) throw notFound('Agreement not found.');
    const { app } = seen;
    res.json({
      success: true,
      data: {
        id: String(ag._id),
        number: ag.number,
        applicationId: String(ag.applicationId),
        ref: app.ref,
        kind: ag.kind,
        status: ag.status,
        templateVersion: ag.templateVersion,
        terms: ag.terms,
        schedule: ag.schedule,
        text: ag.text,
        textSha256: ag.textSha256,
        acceptance: ag.acceptance,
        effectiveAt: ag.effectiveAt,
        voidAt: ag.voidAt,
        voidReason: ag.voidReason,
        approvals: ag.approvals || [],
      },
    });
  },

  async agreementPdf(req, res) {
    const ag = await Agreement.findById(req.params.id).lean();
    if (!ag || !(await canSee(req, ag.applicationId))) throw notFound('Agreement not found.');
    // Once in force, the PDF that lists the approvers (FR-36).
    const file = await StoredFile.findById(ag.inForcePdfFileId || ag.pdfFileId);
    await audit.record({ req, action: 'agreement.download', description: `Agreement ${ag.number} PDF downloaded`, entity: 'Agreement', entityId: String(ag._id) });
    await fileStore.send(res, file);
  },
};

module.exports = ApplicationController;

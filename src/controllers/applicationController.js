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
const rules = require('../services/applications/rules');
const { localDay } = require('../utils/dates');
const { withTransaction } = require('../config/db');
const { badRequest, conflict, notFound } = require('../utils/errors');
const workflow = require('../services/workflow/workflowService');
const payslipReader = require('../services/payslip/payslipReader');
const { productLabels, readerLabels } = require('../services/payslip/deductionLines');
const Staff = require('../models/Staff');

/**
 * Files and agreements: the applicant, or a reviewer with the full view. Never a
 * limited (FR-55) viewer: documents and the agreement are among the hidden fields.
 * OPS sees the agreement and documents of loans with them (FR-20), not the bureau report.
 */
async function canSee(req, applicationId) {
  const app = await Application.findById(applicationId);
  if (!app) return null;
  if (String(app.applicantUserId) === String(req.auth.user._id)) return { app, as: 'applicant' };
  const access = await workflow.reviewAccess(req.auth, app);
  if (access && !access.limited) return { app, as: 'reviewer' };
  if (req.auth.permissions.has('disb.confirm') && ['pending_disbursement', 'disbursed'].includes(app.status)) return { app, as: 'ops' };
  return null;
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
    const { validateUpload } = require('../services/applications/requiredDocuments');
    const documentCode = await validateUpload(app, req.body.documentCode, req.file, settings);
    const file = await withTransaction(async (session) => {
      const f = await fileStore.store(req.file.buffer, { kind: 'document', originalName: req.file.originalname, label: req.body.label, documentCode, applicationId: app._id, ownerUserId: req.auth.user._id, uploadedBy: req.auth.user._id }, { session });
      await Application.updateOne({ _id: app._id }, { $push: { documentIds: f._id } }, { session });
      await audit.record({ req, action: 'document.upload', description: `${app.ref}: ${f.originalName} uploaded`, entity: 'Application', entityId: String(app._id), appRef: app.ref, after: { fileId: String(f._id), sha256: f.sha256, size: f.size } }, { session });
      return f;
    });
    res.status(201).json({ success: true, data: svc.DOC_VIEW(file) });
  },

  /**
   * The latest payslip (D-79): a PDF from the payroll system. Basic Pay, LFB deductions
   * and the pay date are read from it; nothing is saved when they cannot be read. A new
   * payslip replaces the previous one.
   */
  async setPayslip(req, res) {
    const app = await svc.own(req, req.params.id);
    if (!EDITABLE.includes(app.status)) throw conflict('The payslip can be changed while the application is a draft or returned to you.', 'NOT_EDITABLE');
    if (!req.file) throw badRequest('Choose your payslip.', { payslip: ['Choose your payslip.'] });
    if (!/\.pdf$/i.test(req.file.originalname)) throw badRequest('Attach the payslip PDF from the payroll system. Photos and scans cannot be read.', { payslip: ['PDF only.'] }, 'PAYSLIP_NOT_PDF');
    const settings = await Settings.get();
    if (req.file.size > settings.maxUploadMb * 1024 * 1024) throw badRequest(`Files can be up to ${settings.maxUploadMb} MB.`, { payslip: [`Files can be up to ${settings.maxUploadMb} MB.`] }, 'FILE_TOO_LARGE');
    const staff = await Staff.findById(app.applicantStaffId).lean();
    // D-101: each product's payslip deduction label is read as its own line.
    const labels = readerLabels(await productLabels());
    const out = await payslipReader.read(req.file.buffer, { staff, rules: { ...payslipReader.rulesFrom(settings), productLabels: labels } });
    // A payslip older than the limit is refused at upload as well as at submission (D-79).
    const tooOld = !out.problem && rules.payslipProblem({ fileId: true, payDate: out.payDate }, settings, localDay());
    if (tooOld) out.problem = { code: 'PAYSLIP_TOO_OLD', message: tooOld };
    if (out.problem) {
      await audit.record({ req, action: 'payslip.unreadable', description: `${app.ref}: payslip ${req.file.originalname} not accepted (${out.problem.code})`, entity: 'Application', entityId: String(app._id), appRef: app.ref, status: 'failed' });
      throw badRequest(out.problem.message, { payslip: [out.problem.message] }, out.problem.code);
    }
    await withTransaction(async (session) => {
      const f = await fileStore.store(req.file.buffer, { kind: 'payslip', label: 'Latest payslip', originalName: req.file.originalname, applicationId: app._id, ownerUserId: req.auth.user._id, uploadedBy: req.auth.user._id }, { session });
      if (app.payslip?.fileId) await StoredFile.updateOne({ _id: app.payslip.fileId }, { $set: { removedAt: new Date() } }, { session });
      const payslip = { fileId: f._id, originalName: f.originalName, payDate: out.payDate, basic: out.basic, lfbDeductions: out.lfbDeductions, lfbLines: out.lfbLines, readAt: new Date() };
      await Application.updateOne({ _id: app._id }, { $set: { payslip } }, { session });
      await audit.record({ req, action: 'payslip.upload', description: `${app.ref}: payslip dated ${out.payDate} read (Basic Pay ${out.basic.toLocaleString('en-US')}, LFB deductions ${out.lfbDeductions.toLocaleString('en-US')})`, entity: 'Application', entityId: String(app._id), appRef: app.ref, before: app.payslip?.fileId ? { payDate: app.payslip.payDate, basic: app.payslip.basic, lfbDeductions: app.payslip.lfbDeductions } : undefined, after: { fileId: String(f._id), sha256: f.sha256, payDate: out.payDate, basic: out.basic, lfbDeductions: out.lfbDeductions } }, { session });
    });
    res.status(201).json({ success: true, data: await svc.view(req, await Application.findById(app._id)) });
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

  async file(req, res) {
    const file = await StoredFile.findById(req.params.id);
    const own = file && String(file.ownerUserId) === String(req.auth.user._id) && file.kind !== 'crb_report';
    const uploader = file && file.kind === 'crb_report' && String(file.uploadedBy) === String(req.auth.user._id);
    // The applicant sees their own documents and agreement PDFs; the bureau report is
    // for reviewers only (and the Credit Analyst who attached it).
    const seen = file && !own && !uploader ? (await canSee(req, file.applicationId))?.as : null;
    const allowed = file && !file.removedAt && (own || uploader || seen === 'reviewer' || (seen === 'ops' && file.kind !== 'crb_report'));
    if (!allowed) throw notFound('File not found.');
    const inline = req.query.preview === '1' && ['document', 'payslip'].includes(file.kind);
    await audit.record({ req, action: inline ? 'file.preview' : 'file.download', description: `${file.originalName} ${inline ? 'previewed' : 'downloaded'}`, entity: 'StoredFile', entityId: String(file._id) });
    await fileStore.send(res, file, { inline });
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

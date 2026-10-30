'use strict';

// Review queue, review screen and decisions (FR-13 to FR-19, FR-42, FR-54, FR-55),
// revised terms for the applicant, and delegation.

const Application = require('../models/Application');
const Decision = require('../models/Decision');
const workflow = require('../services/workflow/workflowService');
const review = require('../services/review/reviewService');
const { reviewView, queueRow, namesOf } = require('../services/review/reviewView');
const delegations = require('../services/review/delegationService');
const appSvc = require('../services/applications/applicationService');
const audit = require('../services/audit/auditService');
const { badRequest, forbidden, notFound } = require('../utils/errors');

async function loadForReview(req) {
  const app = await Application.findById(req.params.id);
  if (!app) throw notFound('Application not found.');
  if (String(app.applicantUserId) === String(req.auth.user._id)) throw forbidden('You cannot review your own application. It is routed to another approver.', 'SELF_REVIEW');
  const access = await workflow.reviewAccess(req.auth, app);
  if (!access) throw notFound('Application not found.');
  return { app, access };
}

const ReviewController = {
  async queue(req, res) {
    const tab = req.query.tab || 'waiting';
    const { items, perms } = await workflow.queueFor(req.auth);
    const names = await namesOf(items.map((i) => i.actor.onBehalfOf).filter(Boolean));
    const waiting = await Promise.all(items.map(({ app, actor }) => queueRow(app, { limited: workflow.isLimited(app, perms), actor, names })));
    let rows = waiting;
    if (tab === 'overdue') rows = waiting.filter((r) => r.due?.overdue);
    if (tab === 'handled') {
      const ids = await Decision.distinct('applicationId', { actorId: req.auth.user._id, stage: { $ne: null } });
      const apps = await Application.find({ _id: { $in: ids } }).sort({ updatedAt: -1 }).limit(100);
      rows = await Promise.all(apps.map((app) => queueRow(app, { limited: workflow.isLimited(app, perms), actor: null })));
    }
    const delegatedToMe = await workflow.delegatedTo(req.auth.user._id);
    const covering = await namesOf(delegatedToMe.map((d) => d.delegatorId));
    res.json({
      success: true,
      data: {
        tab,
        counts: { waiting: waiting.length, overdue: waiting.filter((r) => r.due?.overdue).length },
        items: rows,
        covering: delegatedToMe.map((d) => ({ name: covering.get(String(d.delegatorId))?.name, until: d.until, permissions: d.permissions })),
      },
    });
  },

  async get(req, res) {
    const { app, access } = await loadForReview(req);
    // Opening an application shows salary and personal data: audited (NFR-05).
    await audit.record({ req, action: 'review.view', description: `${app.ref} opened for review${access.limited ? ' (limited details)' : ''}`, entity: 'Application', entityId: String(app._id), appRef: app.ref, limited: access.limited });
    res.json({ success: true, data: await reviewView(req, app, access) });
  },

  async decide(req, res) {
    // FR-49: every decision needs a session opened with MFA, including a delegate's.
    if (!req.auth.session.mfaVerified) throw forbidden('Sign in again with your one-time code to record a decision.', 'MFA_STEP_UP');
    const { app } = await loadForReview(req);
    const { outcome, application } = await review.decide(req, app, req.body);
    const access = await workflow.reviewAccess(req.auth, application);
    res.json({ success: true, data: { outcome, application: access ? await reviewView(req, application, access) : { id: String(application._id), ref: application.ref } } });
  },

  async crbReport(req, res) {
    const { app } = await loadForReview(req);
    if (!req.file) throw badRequest('Choose the bureau report file.', { file: ['Choose a file.'] });
    const f = await review.uploadCrbReport(req, app, req.file);
    res.status(201).json({ success: true, data: appSvc.DOC_VIEW(f) });
  },

  // ---------- revised terms (applicant) ----------

  async revised(req, res) {
    res.json({ success: true, data: await review.revisedTerms(req, await appSvc.own(req, req.params.id)) });
  },

  async acceptRevised(req, res) {
    const app = await review.acceptRevised(req, await appSvc.own(req, req.params.id), req.body);
    res.json({ success: true, data: await appSvc.view(req, app) });
  },

  async declineRevised(req, res) {
    const app = await review.declineRevised(req, await appSvc.own(req, req.params.id), req.body.reason);
    res.json({ success: true, data: await appSvc.view(req, app) });
  },

  // ---------- delegation ----------

  async delegations(req, res) {
    res.json({ success: true, data: await delegations.list(req) });
  },
  async delegationCandidates(req, res) {
    res.json({ success: true, data: await delegations.candidates(req, req.query.q) });
  },
  async createDelegation(req, res) {
    res.status(201).json({ success: true, data: await delegations.create(req, req.body) });
  },
  async endDelegation(req, res) {
    res.json({ success: true, data: await delegations.end(req, req.params.id) });
  },
};

module.exports = ReviewController;

'use strict';

// Agreement template versions (FR-40, D-88): the Legal Officer uploads and edits
// (admin.templates); the Head of Legal approves or rejects (templates.approve).

const templates = require('../services/agreement/templateService');
const { notFound } = require('../utils/errors');

const view = (t) => ({ id: String(t._id), version: t.version, status: t.status });

const TemplateController = {
  async list(req, res) {
    res.json({ success: true, data: { items: await templates.list(), required: templates.REQUIRED } });
  },

  async get(req, res) {
    const t = await templates.get(req.params.id);
    if (!t) throw notFound('Template not found.');
    res.json({ success: true, data: t });
  },

  async preview(req, res) {
    res.json({ success: true, data: await templates.preview(req.body.body) });
  },

  async upload(req, res) {
    const t = await templates.upload(req, req.body);
    res.status(201).json({ success: true, message: `Version ${t.version} uploaded. It waits for the Head of Legal's approval.`, data: view(t) });
  },

  async edit(req, res) {
    const t = await templates.edit(req, req.params.id, req.body);
    res.json({ success: true, message: `Version ${t.version} saved. It waits for the Head of Legal's approval.`, data: view(t) });
  },

  async approve(req, res) {
    const t = await templates.approve(req, req.params.id);
    res.json({ success: true, message: `Version ${t.version} approved.`, data: view(t) });
  },

  async reject(req, res) {
    const t = await templates.reject(req, req.params.id, req.body.reason);
    res.json({ success: true, message: `Version ${t.version} rejected.`, data: view(t) });
  },
};

module.exports = TemplateController;

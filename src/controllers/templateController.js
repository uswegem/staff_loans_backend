'use strict';

// Agreement template versions (FR-40; admin.templates).

const templates = require('../services/agreement/templateService');
const { notFound } = require('../utils/errors');

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

  async load(req, res) {
    const t = await templates.load(req, req.body);
    res.status(201).json({ success: true, message: `Version ${t.version} loaded.`, data: { id: String(t._id), version: t.version } });
  },
};

module.exports = TemplateController;

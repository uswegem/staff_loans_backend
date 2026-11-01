'use strict';

// Workflow targets, working calendar and holidays (BRD 7.3, admin.workflow).

const Settings = require('../models/Settings');
const Holiday = require('../models/Holiday');
const audit = require('../services/audit/auditService');
const { badRequest, notFound } = require('../utils/errors');
const { ROUTES, STAGES } = require('../services/workflow/routes');

// The four routes are fixed by the BRD (7.3); shown read-only on the workflow screen.
const ROUTE_VIEW = Object.values(ROUTES).map((r) => ({ key: r.key, label: r.label, stages: r.stages.map((k) => STAGES[k].short || STAGES[k].label), limitedCredit: r.limitedCredit }));

const EDITABLE = ['stageTargetHours', 'ceoTargetHours', 'workingDays', 'dayStartMinutes', 'dayEndMinutes', 'revisedTermsExpiryDays', 'approvalSlaDays', 'probationMonths', 'maxUploadMb', 'firstDueDay', 'inactivityTimeoutMin', 'lockoutThreshold', 'payslipMaxAgeDays', 'retirementAge', 'retirementBufferDays', 'dobMinAge', 'dobMaxAge'];
const { rulesFrom: payslipRules } = require('../services/payslip/payslipReader');

function view(s) {
  const out = {};
  EDITABLE.forEach((k) => {
    out[k] = s[k];
  });
  out.payslipRules = payslipRules(s);
  out.version = s.version;
  out.updatedAt = s.updatedAt;
  return out;
}

const SettingsController = {
  async get(req, res) {
    const [s, holidays] = await Promise.all([Settings.get(), Holiday.find().sort({ date: 1 }).lean()]);
    res.json({ success: true, data: { settings: view(s), routes: ROUTE_VIEW, holidays: holidays.map((h) => ({ id: String(h._id), date: h.date, name: h.name })) } });
  },

  async update(req, res) {
    const s = await Settings.get();
    const before = view(s);
    const next = { ...before, ...req.body };
    if (next.dayEndMinutes <= next.dayStartMinutes) throw badRequest('The working day must end after it starts.', { dayEndMinutes: ['Must be after the start.'] });
    if (!next.workingDays.length) throw badRequest('Choose at least one working day.', { workingDays: ['Required.'] });
    if (next.dobMinAge >= next.dobMaxAge) throw badRequest('The youngest age must be below the oldest.', { dobMaxAge: ['Must be above the youngest age.'] });
    EDITABLE.forEach((k) => {
      if (req.body[k] !== undefined) s[k] = req.body[k];
    });
    if (req.body.payslipRules) s.payslipRules = { ...payslipRules(s), ...req.body.payslipRules };
    s.version += 1;
    s.updatedBy = req.auth.user._id;
    await s.save();
    await audit.record({ req, action: 'settings.update', description: `Workflow settings changed (version ${s.version})`, entity: 'Settings', entityId: 'global', before, after: view(s) });
    res.json({ success: true, data: view(s) });
  },

  async addHoliday(req, res) {
    const h = await Holiday.create(req.body);
    await audit.record({ req, action: 'holiday.add', description: `Holiday added: ${h.date} ${h.name}`, entity: 'Holiday', entityId: String(h._id), after: req.body });
    res.status(201).json({ success: true, data: { id: String(h._id), date: h.date, name: h.name } });
  },

  async removeHoliday(req, res) {
    const h = await Holiday.findById(req.params.id);
    if (!h) throw notFound('Holiday not found.');
    await Holiday.deleteOne({ _id: h._id });
    await audit.record({ req, action: 'holiday.remove', description: `Holiday removed: ${h.date} ${h.name}`, entity: 'Holiday', entityId: String(h._id), before: { date: h.date, name: h.name } });
    res.json({ success: true, message: 'Holiday removed.' });
  },
};

module.exports = SettingsController;

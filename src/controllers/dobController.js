'use strict';

// Date of birth verification (D-82): People and Culture's queue and decisions, a
// proposal from a staff record, and withdrawal by the submitter.

const dob = require('../services/staff/dobService');
const Staff = require('../models/Staff');
const { notFound } = require('../utils/errors');

const DobController = {
  async list(req, res) {
    res.json({ success: true, data: { items: await dob.list({ status: req.query.status }) } });
  },

  async approve(req, res) {
    const change = await dob.approve(req, req.params.id);
    res.json({ success: true, message: `Date of birth ${change.proposed} verified.`, data: { id: String(change._id), status: change.status } });
  },

  async reject(req, res) {
    const change = await dob.reject(req, req.params.id, req.body.reason);
    res.json({ success: true, message: 'Change rejected.', data: { id: String(change._id), status: change.status } });
  },

  async withdraw(req, res) {
    const change = await dob.withdraw(req, req.params.id);
    res.json({ success: true, message: 'Change withdrawn.', data: { id: String(change._id), status: change.status } });
  },

  /** People and Culture propose a date of birth on a staff record. */
  async proposeForStaff(req, res) {
    const staff = await Staff.findById(req.params.id);
    if (!staff) throw notFound('Staff record not found.');
    await dob.submit(req, staff._id, req.body.dob, 'staff_record');
    res.status(201).json({ success: true, message: 'Date of birth sent for verification.', data: await dob.statusOf(await Staff.findById(staff._id)) });
  },

  async statusForStaff(req, res) {
    const staff = await Staff.findById(req.params.id);
    if (!staff) throw notFound('Staff record not found.');
    res.json({ success: true, data: await dob.statusOf(staff) });
  },
};

module.exports = DobController;

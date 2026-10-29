'use strict';

// One or more roles per user, each with an optional end date (FR-46).
// endsOn is a calendar date (stored as UTC midnight); the role is held through that day.

const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true },
    endsOn: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

assignmentSchema.index({ userId: 1, revokedAt: 1 });
assignmentSchema.index({ roleId: 1, revokedAt: 1 });

module.exports = mongoose.model('RoleAssignment', assignmentSchema);

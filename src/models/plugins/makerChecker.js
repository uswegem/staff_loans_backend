'use strict';

// Fields shared by every record that changes through maker-checker (BRD 5.1,
// FR-58 to FR-63, decision 32): product versions and pricing versions.
//
// States (FR-63): draft, pending_approval, rejected, approved_scheduled, active,
// inactive (a live deactivation), plus superseded (an older approved version) and
// discarded (a draft the maker threw away; kept for the audit trail).
//
// effectiveFrom is the maker's date (local midnight). liveFrom is when the version
// actually takes effect: the later of effectiveFrom and the approval time, so an
// approval never applies retroactively (DECISIONS D-34).

const mongoose = require('mongoose');

const STATES = ['draft', 'pending_approval', 'rejected', 'approved_scheduled', 'active', 'inactive', 'superseded', 'discarded'];
const OPEN_STATES = ['draft', 'rejected', 'pending_approval'];
const EDITABLE_STATES = ['draft', 'rejected'];

module.exports = function makerChecker(schema) {
  schema.add({
    version: { type: Number, required: true, min: 1 },
    state: { type: String, enum: STATES, default: 'draft', index: true },
    changeType: { type: String, enum: ['create', 'change', 'deactivate'], default: 'change' },
    basedOnVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    effectiveFrom: { type: Date, required: true },
    liveFrom: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 1000 },
    editors: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    makerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: Date,
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    checkerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000 },
  });
  schema.index({ approvedAt: 1, liveFrom: -1, version: -1 });
};

module.exports.STATES = STATES;
module.exports.OPEN_STATES = OPEN_STATES;
module.exports.EDITABLE_STATES = EDITABLE_STATES;

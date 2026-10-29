'use strict';

// Roles are bundles of permissions maintained by administrators (FR-43, FR-45).

const mongoose = require('mongoose');
const { PERMISSION_IDS } = require('../constants/permissions');

const roleSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, match: /^[a-z][a-z0-9_]{1,39}$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 400 },
    system: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    permissions: { type: [{ type: String, enum: PERMISSION_IDS }], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);

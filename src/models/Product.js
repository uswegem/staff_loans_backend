'use strict';

// A loan product (BRD 5, decision 32). Products are data, not code: everything an
// application needs lives on the product's versions. The code is stable and only
// identifies the product; nothing in the application branches on it.
// status and liveVersionId are kept current by the promotion step and are for
// display and listing; the version resolver is the source of truth.

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, match: /^[A-Z][A-Z0-9]{1,9}$/ },
    status: { type: String, enum: ['not_live', 'active', 'inactive'], default: 'not_live', index: true },
    liveVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVersion', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);

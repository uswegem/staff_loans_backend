'use strict';

const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Holiday', holidaySchema);

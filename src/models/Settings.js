'use strict';

// Workflow, calendar and security settings (BRD 7.3, NFR-04). One document,
// versioned so changes can be audited with before/after values.

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    stageTargetHours: { type: Number, default: 8, min: 1 },
    ceoTargetHours: { type: Number, default: 48, min: 1 },
    workingDays: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0 = Sunday
    dayStartMinutes: { type: Number, default: 8 * 60, min: 0, max: 1439 },
    dayEndMinutes: { type: Number, default: 17 * 60, min: 1, max: 1440 },
    utcOffsetMinutes: { type: Number, default: 180 }, // Africa/Dar_es_Salaam, no DST (D-19)
    revisedTermsExpiryDays: { type: Number, default: 10, min: 1 }, // FR-39
    approvalSlaDays: { type: Number, default: 30, min: 1 }, // BR-13 flag only (Q3)
    probationMonths: { type: Number, default: 6, min: 0 }, // NS-01
    maxUploadMb: { type: Number, default: 10, min: 1, max: 50 },
    inactivityTimeoutMin: { type: Number, default: 15, min: 1 },
    lockoutThreshold: { type: Number, default: 5, min: 3, max: 10 },
    // Profile fields that must be filled before applying (decision 7, FR-05); keys from PROFILE_FIELDS.
    mandatoryProfileFields: { type: [String], default: undefined },
    version: { type: Number, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

settingsSchema.statics.get = async function get(session) {
  const doc = await this.findById('global').session(session || null);
  if (doc) return doc;
  return this.findOneAndUpdate({ _id: 'global' }, { $setOnInsert: { _id: 'global' } }, { upsert: true, new: true, session });
};

module.exports = mongoose.model('Settings', settingsSchema);

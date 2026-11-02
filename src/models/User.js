'use strict';

// Ported from Ess-Backend/src/models/User.js (commit 522bdbd), adapted for SLAS:
// - login identity only; staff master data lives in Staff (prompt 3a.6)
// - sign-in by staff number, not username/email (prompt 3a.1)
// - lockout and TOTP MFA fields (prompt 3a.2, 3a.3)
// - the single `role` field is replaced by RoleAssignment (prompt 3a.4)
// - password hashing moved to the credential provider; the hash never leaves toJSON

const mongoose = require('mongoose');

const { STAFF_NO } = require('../constants/staffNo');

const userSchema = new mongoose.Schema(
  {
    staffNo: { type: String, required: true, unique: true, uppercase: true, trim: true, match: STAFF_NO },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', required: true, unique: true },
    authProvider: { type: String, enum: ['local'], default: 'local' },
    passwordHash: { type: String, required: true },
    passwordHistory: { type: [String], default: [] },
    passwordChangedAt: Date,
    mustChangePassword: { type: Boolean, default: true },
    status: { type: String, enum: ['active', 'locked', 'deactivated'], default: 'active', index: true },
    failedAttempts: { type: Number, default: 0 },
    lockedAt: Date,
    mfa: {
      enabled: { type: Boolean, default: false },
      secretEnc: String,
      pendingSecretEnc: String,
      pendingJti: String,
      enrolledAt: Date,
      resetAt: Date,
      lastUsedStep: Number,
    },
    lastLoginAt: Date,
    // Interface language and theme (D-94), kept per user so they follow the person to any device.
    preferences: {
      language: { type: String, enum: ['en', 'sw'], default: 'en' },
      theme: { type: String, enum: ['light', 'dark'], default: 'light' },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

userSchema.methods.toJSON = function toJSON() {
  const o = this.toObject();
  delete o.passwordHash;
  delete o.passwordHistory;
  if (o.mfa) o.mfa = { enabled: o.mfa.enabled, enrolledAt: o.mfa.enrolledAt, resetAt: o.mfa.resetAt };
  delete o.__v;
  return o;
};

userSchema.statics.STAFF_NO = STAFF_NO;

module.exports = mongoose.model('User', userSchema);

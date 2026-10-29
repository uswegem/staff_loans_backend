'use strict';

// A signed-in session. Access tokens carry its id, so logout and admin actions
// (deactivate, lock, MFA reset) end access at once, and the inactivity timeout
// (BRD NFR-04) is enforced on the server.

const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lastActivityAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokedReason: String,
    // True when the session was opened with a TOTP code. Privileged permissions
    // need it even if the role was granted after sign-in (FR-49 with FR-51).
    mfaVerified: { type: Boolean, default: false },
    csrfHash: String,
    ip: String,
    userAgent: String,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

sessionSchema.statics.revokeAllForUser = function revokeAllForUser(userId, reason) {
  return this.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
};

module.exports = mongoose.model('Session', sessionSchema);

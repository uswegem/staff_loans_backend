'use strict';

// Ported from Ess-Backend/src/models/RefreshToken.js (commit 522bdbd), adapted for SLAS:
// - tenantId removed
// - tokens are 384-bit random values, so they are stored as an indexed SHA-256 hash;
//   the ESS bcrypt scan over the latest 200 tokens is gone
// - rotation chain per session; presenting a rotated token revokes the session (reuse detection)
// - TTL index removes expired rows

const crypto = require('crypto');
const mongoose = require('mongoose');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

const refreshTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    replacedByHash: String,
    ip: String,
    userAgent: String,
  },
  { timestamps: true }
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.methods.isUsable = function isUsable() {
  return !this.revokedAt && this.expiresAt > new Date();
};

refreshTokenSchema.statics.hash = sha256;

refreshTokenSchema.statics.issue = async function issue({ userId, sessionId, ttlSec, ip, userAgent }, session) {
  const rawToken = crypto.randomBytes(48).toString('base64url');
  const [record] = await this.create(
    [{ userId, sessionId, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + ttlSec * 1000), ip, userAgent }],
    { session }
  );
  return { rawToken, record };
};

refreshTokenSchema.statics.findByRawToken = function findByRawToken(rawToken) {
  return this.findOne({ tokenHash: sha256(rawToken) });
};

refreshTokenSchema.statics.revokeSession = function revokeSession(sessionId) {
  return this.updateMany({ sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } });
};

refreshTokenSchema.statics.revokeAllForUser = function revokeAllForUser(userId) {
  return this.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
};

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);

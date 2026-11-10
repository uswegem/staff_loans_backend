'use strict';

// TOTP MFA (FR-49, FR-53, DECISIONS D-18): RFC 6238, HMAC-SHA1, 30-second step,
// 6 digits, one step of clock drift either way. A code is accepted once only
// (the last used step is stored). Secrets are encrypted with AES-256-GCM.

const crypto = require('crypto');
const QRCode = require('qrcode');
const { config } = require('../../config/env');

const STEP_SEC = 30;
const DIGITS = 6;
const WINDOW = 1;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SEC);

/** Returns the matched step, or null. Refuses steps at or before lastUsedStep (replay). */
function verifyCode(secretB32, code, { lastUsedStep = -1, now = Date.now() } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const step = currentStep(now);
  for (let d = -WINDOW; d <= WINDOW; d += 1) {
    const s = step + d;
    if (s <= lastUsedStep) continue;
    const expected = hotp(secretB32, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(code)))) return s;
  }
  return null;
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.mfaEncKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.mfaEncKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** accountName is what the authenticator app shows under the issuer: the username. */
function otpauthUri(accountName, secretB32) {
  const issuer = encodeURIComponent(config.mfaIssuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(accountName)}?secret=${secretB32}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SEC}`;
}

/** SVG data URL: scales cleanly and avoids PNG encoding cost. */
async function qrDataUrl(uri) {
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1 });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

module.exports = { generateSecret, verifyCode, hotp, currentStep, encrypt, decrypt, otpauthUri, qrDataUrl, base32Encode, base32Decode };

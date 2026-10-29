'use strict';

process.env.MFA_ENC_KEY = process.env.MFA_ENC_KEY || 'a'.repeat(64);
const mfa = require('../../src/services/auth/mfaService');

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890" (last 6 digits of the 8-digit vectors).
const RFC_SECRET = mfa.base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('time %i gives %s', (t, code) => {
    expect(mfa.hotp(RFC_SECRET, Math.floor(t / 30))).toBe(code);
  });

  it('accepts one step of drift and refuses two', () => {
    const now = 1111111109 * 1000;
    expect(mfa.verifyCode(RFC_SECRET, '081804', { now: now + 30000 })).not.toBeNull();
    expect(mfa.verifyCode(RFC_SECRET, '081804', { now: now + 61000 })).toBeNull();
  });

  it('refuses a replayed code', () => {
    const now = 1111111109 * 1000;
    const step = mfa.verifyCode(RFC_SECRET, '081804', { now });
    expect(mfa.verifyCode(RFC_SECRET, '081804', { now, lastUsedStep: step })).toBeNull();
  });

  it('refuses malformed codes', () => {
    expect(mfa.verifyCode(RFC_SECRET, '12345')).toBeNull();
    expect(mfa.verifyCode(RFC_SECRET, 'abcdef')).toBeNull();
  });

  it('encrypts secrets and round-trips them', () => {
    const s = mfa.generateSecret();
    const enc = mfa.encrypt(s);
    expect(enc).not.toContain(s);
    expect(mfa.decrypt(enc)).toBe(s);
  });
});

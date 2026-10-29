'use strict';

const policy = require('../../src/services/auth/passwordPolicy');

describe('password policy (DECISIONS Q2)', () => {
  it('accepts 8 characters with three classes', () => {
    expect(policy.check('Mwanza#1')).toEqual([]);
    expect(policy.check('mwanza12!')).toEqual([]);
  });

  it('refuses fewer than 8 characters', () => {
    expect(policy.check('Mwan#1a')).toContain('Use at least 8 characters.');
  });

  it('refuses fewer than three character classes', () => {
    expect(policy.check('mwanzamwanza').length).toBeGreaterThan(0);
    expect(policy.check('Mwanzamwanza').length).toBeGreaterThan(0);
  });

  it('refuses a password containing the staff number', () => {
    expect(policy.check('Lfb0412#x', { staffNo: 'LFB0412' })).toContain('Do not include your staff number.');
  });
});

'use strict';

// Password policy (DECISIONS Q2, D-17): at least 8 characters, 3 of the 4
// character classes, and none of the last 5 passwords.

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const HISTORY = 5;

function classesIn(pw) {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
}

/** Returns a list of reasons the password is refused (empty when it passes). */
function check(password, { staffNo } = {}) {
  const errors = [];
  if (typeof password !== 'string' || password.length < MIN_LENGTH) errors.push(`Use at least ${MIN_LENGTH} characters.`);
  if (typeof password === 'string' && password.length > MAX_LENGTH) errors.push(`Use at most ${MAX_LENGTH} characters.`);
  if (typeof password === 'string' && classesIn(password) < 3) {
    errors.push('Use at least three of: lower-case letters, capital letters, numbers and symbols.');
  }
  if (staffNo && typeof password === 'string' && password.toUpperCase().includes(staffNo.toUpperCase())) {
    errors.push('Do not include your staff number.');
  }
  return errors;
}

module.exports = { check, MIN_LENGTH, HISTORY };

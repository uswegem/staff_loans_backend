'use strict';

// Formats shared by the API, the Staff model, the staff upload and the upgrade script,
// so a value is checked and stored the same way wherever it comes from (D-93). The web
// app has the same rules in src/lib/formats.js; keep the two in step.

/** NIDA number as stored: YYYYMMDD-XXXXX-XXXXX-XX. */
const NIDA = /^\d{8}-\d{5}-\d{5}-\d{2}$/;
const NIDA_MESSAGE = 'Enter the 20-digit NIDA number, for example 19800630-13140-00004-20.';

/** Tanzanian phone number as stored: +255 and nine digits, no spaces. */
const PHONE = /^\+255\d{9}$/;
const PHONE_MESSAGE = 'Enter nine digits after +255, for example +255 712 345 678.';

/** Bank account number: 6 to 20 digits; spaces and hyphens between groups are allowed. */
const ACCOUNT_NO = /^$|^(?=(?:\D*\d){6,20}\D*$)\d[\d -]*\d$/;
const ACCOUNT_NO_MESSAGE = 'Enter the account number: 6 to 20 digits.';
const BRANCH_MESSAGE = 'Enter the branch name, for example Mlimani City.';

/**
 * Any NIDA number with exactly 20 digits, with or without hyphens, in the stored
 * format; null when it does not have 20 digits or the first eight are not a real date.
 */
function normaliseNida(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!/^[\d\s-]+$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length !== 20) return null;
  const y = +digits.slice(0, 4);
  const m = +digits.slice(4, 6);
  const d = +digits.slice(6, 8);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${digits.slice(0, 8)}-${digits.slice(8, 13)}-${digits.slice(13, 18)}-${digits.slice(18)}`;
}

/**
 * A Tanzanian number in the stored format, from 0712345678, 255712345678, +255712345678
 * or the same with spaces, brackets or hyphens; null for anything else. It never
 * guesses: a number with too many or too few digits stays invalid.
 */
function normalisePhone(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!/^\+?[\d\s()-]+$/.test(t)) return null;
  let digits = t.replace(/\D/g, '');
  if (t.startsWith('+') && !digits.startsWith('255')) return null;
  if (digits.startsWith('255') && digits.length === 12) digits = digits.slice(3);
  else if (digits.startsWith('0') && digits.length === 10) digits = digits.slice(1);
  if (!/^[1-9]\d{8}$/.test(digits)) return null;
  return `+255${digits}`;
}

/** For a model setter: the stored format when the value normalises, otherwise as given. */
const phoneOrRaw = (v) => (v ? normalisePhone(v) || v : v);
const nidaOrRaw = (v) => (v ? normaliseNida(v) || v : v);

module.exports = { NIDA, NIDA_MESSAGE, PHONE, PHONE_MESSAGE, ACCOUNT_NO, ACCOUNT_NO_MESSAGE, BRANCH_MESSAGE, normaliseNida, normalisePhone, phoneOrRaw, nidaOrRaw };

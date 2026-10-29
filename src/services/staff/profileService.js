'use strict';

// Staff profile completeness gate (decision 7, FR-05, BR-01) and NIDA handling.
// The catalogue lists every profile field the gate can require; settings choose
// which are mandatory (default: all, as in the prototype).

const Settings = require('../../models/Settings');

/** [key, label, tab] — tabs match the prototype profile (personal, bank, kin, pay). */
const PROFILE_FIELDS = Object.freeze([
  ['personal.maritalStatus', 'Marital status', 'personal'],
  ['personal.dob', 'Date of birth', 'personal'],
  ['personal.nida', 'NIDA number', 'personal'],
  ['personal.nationality', 'Nationality', 'personal'],
  ['personal.mobile', 'Mobile phone', 'personal'],
  ['personal.poBox', 'P.O. Box', 'personal'],
  ['personal.residence', 'Residence (village/street)', 'personal'],
  ['bank.bank', 'Bank', 'bank'],
  ['bank.branch', 'Branch', 'bank'],
  ['bank.accountName', 'Account name', 'bank'],
  ['bank.accountNo', 'Account number', 'bank'],
  ['nextOfKin.0.name', 'Next of kin name', 'kin'],
  ['nextOfKin.0.relationship', 'Relationship', 'kin'],
  ['nextOfKin.0.phone', 'Next of kin phone', 'kin'],
  ['nextOfKin.0.address', 'Next of kin address', 'kin'],
  ['payDeclaredAt', 'Confirm deductions and other loans', 'pay'],
]);
const PROFILE_KEYS = PROFILE_FIELDS.map((f) => f[0]);

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const filled = (v) => !(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''));

async function mandatoryKeys(session) {
  const s = await Settings.get(session);
  return s.mandatoryProfileFields?.length ? s.mandatoryProfileFields.filter((k) => PROFILE_KEYS.includes(k)) : PROFILE_KEYS;
}

/** { complete, done, total, missing: [{ key, label, tab }] } */
async function completeness(staff, session) {
  const keys = await mandatoryKeys(session);
  const doc = typeof staff.toObject === 'function' ? staff.toObject() : staff;
  const required = PROFILE_FIELDS.filter(([k]) => keys.includes(k));
  const missing = required.filter(([k]) => !filled(getPath(doc, k))).map(([key, label, tab]) => ({ key, label, tab }));
  return { complete: missing.length === 0, done: required.length - missing.length, total: required.length, missing };
}

/**
 * NIDA: 20 digits, format YYYYMMDD-XXXXX-XXXXX-XX, with or without dashes (decision 7).
 * Returns the 20 digits, or null when the value is not a valid NIDA number.
 */
function normaliseNida(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!/^\d{8}-?\d{5}-?\d{5}-?\d{2}$/.test(t)) return null;
  const digits = t.replace(/-/g, '');
  const y = +digits.slice(0, 4);
  const m = +digits.slice(4, 6);
  const d = +digits.slice(6, 8);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return digits;
}

const formatNida = (digits) => (digits ? `${digits.slice(0, 8)}-${digits.slice(8, 13)}-${digits.slice(13, 18)}-${digits.slice(18)}` : null);

module.exports = { PROFILE_FIELDS, PROFILE_KEYS, completeness, normaliseNida, formatNida, mandatoryKeys };

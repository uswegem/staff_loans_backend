'use strict';

// Staff profile completeness gate (decision 7, FR-05, BR-01) and NIDA handling.
// The catalogue lists every profile field the gate can require; settings choose
// which are mandatory (default: all, as in the prototype).

const Settings = require('../../models/Settings');
const { NIDA, PHONE, normaliseNida } = require('../../utils/formats');
const { normaliseCountry } = require('../../constants/countries');

/**
 * [key, label, tab] — tabs match the prototype profile (personal, bank, kin, pay).
 * P.O. Box and the free-text residence are no longer asked for (D-93): the address is
 * region, district, ward and street; house or plot number is optional and not listed.
 */
const PROFILE_FIELDS = Object.freeze([
  ['personal.maritalStatus', 'Marital status', 'personal'],
  ['personal.dob', 'Date of birth', 'personal'],
  ['personal.nida', 'NIDA number', 'personal'],
  ['personal.nationality', 'Nationality', 'personal'],
  ['personal.mobile', 'Mobile phone', 'personal'],
  ['personal.address.region', 'Region', 'personal'],
  ['personal.address.district', 'District', 'personal'],
  ['personal.address.ward', 'Ward', 'personal'],
  ['personal.address.street', 'Street', 'personal'],
  ['bank.bank', 'Bank', 'bank'],
  ['bank.branch', 'Branch', 'bank'],
  ['bank.accountName', 'Account name', 'bank'],
  ['bank.accountNo', 'Account number', 'bank'],
  ['nextOfKin.0.firstName', 'Next of kin first name', 'kin'],
  ['nextOfKin.0.lastName', 'Next of kin surname', 'kin'],
  ['nextOfKin.0.relationship', 'Relationship', 'kin'],
  ['nextOfKin.0.phone', 'Next of kin phone', 'kin'],
  ['nextOfKin.0.address', 'Next of kin address', 'kin'],
]);
const PROFILE_KEYS = PROFILE_FIELDS.map((f) => f[0]);

/**
 * Fields with a format: a value in the wrong format (an earlier entry the upgrade could
 * not normalise) counts as missing, so the staff member corrects it before applying.
 */
const FORMAT_CHECKS = Object.freeze({
  'personal.nida': (v) => NIDA.test(v),
  'personal.mobile': (v) => PHONE.test(v),
  'personal.nationality': (v) => normaliseCountry(v) === v,
  'nextOfKin.0.phone': (v) => PHONE.test(v),
});

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const filled = (v) => !(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''));

async function mandatoryKeys(session) {
  const s = await Settings.get(session);
  return s.mandatoryProfileFields?.length ? s.mandatoryProfileFields.filter((k) => PROFILE_KEYS.includes(k)) : PROFILE_KEYS;
}

/** { complete, done, total, required: [keys], missing: [{ key, label, tab, invalid? }] } */
async function completeness(staff, session) {
  const keys = await mandatoryKeys(session);
  const doc = typeof staff.toObject === 'function' ? staff.toObject() : staff;
  const required = PROFILE_FIELDS.filter(([k]) => keys.includes(k));
  // D-82: a date of birth counts as given once it is verified or waiting for verification;
  // whether it is verified is a separate rule with its own message.
  const value = (k) => (k === 'personal.dob' ? doc.dateOfBirth?.value || doc.dateOfBirth?.pending?.proposed : getPath(doc, k));
  const missing = required
    .map(([key, label, tab]) => {
      const v = value(key);
      if (!filled(v)) return { key, label, tab };
      if (FORMAT_CHECKS[key] && !FORMAT_CHECKS[key](v)) return { key, label, tab, invalid: true };
      return null;
    })
    .filter(Boolean);
  return { complete: missing.length === 0, done: required.length - missing.length, total: required.length, required: required.map(([k]) => k), missing };
}

/** The stored NIDA format for display; values that do not normalise are shown as stored. */
const formatNida = (value) => (value ? normaliseNida(value) || value : null);

module.exports = { PROFILE_FIELDS, PROFILE_KEYS, completeness, normaliseNida, formatNida, mandatoryKeys };

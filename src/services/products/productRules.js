'use strict';

// Business validation and field-by-field comparison for product versions (FR-57, FR-58).
// Joi checks shapes at the route; this checks values against each other.

const { FIELD_TYPES } = require('../../models/ProductVersion');

/** Editable product parameters, with the labels the comparison shows (FR-58, FR-59). */
const PRODUCT_FIELDS = [
  ['name', 'Name'],
  ['description', 'Description'],
  ['minAmount', 'Minimum amount (TZS)'],
  ['maxAmount', 'Maximum amount (TZS)'],
  ['minTenor', 'Minimum tenor (months)'],
  ['maxTenor', 'Maximum tenor (months)'],
  ['minServiceMonths', 'Minimum service (months)'],
  ['maxConcurrent', 'Running loans allowed'],
  ['topUpAllowed', 'Top-up allowed'],
  ['payslipLabel', 'Payslip deduction label'],
  ['contractStaffAllowed', 'Contract staff allowed'],
  ['eligibleCategories', 'Eligible employee categories'],
  ['fields', 'Application fields'],
  ['requiredDocuments', 'Required documents'],
  ['reapplyCoolingMonths', 'Minimum number of Months Before Applying for Topup'],
  ['agreementTemplateId', 'Agreement template'],
];

const add = (errors, field, msg) => {
  (errors[field] = errors[field] || []).push(msg);
};

/** Returns { field: [messages] }; empty when valid. */
function validateProduct(v) {
  const errors = {};
  const posInt = (f, label, min = 1) => {
    if (!Number.isInteger(v[f]) || v[f] < min) add(errors, f, `${label} must be a whole number of at least ${min}.`);
  };
  posInt('minAmount', 'Minimum amount');
  posInt('maxAmount', 'Maximum amount');
  if (Number.isInteger(v.minAmount) && Number.isInteger(v.maxAmount) && v.minAmount >= v.maxAmount) add(errors, 'maxAmount', 'The maximum amount must be above the minimum.');
  posInt('minTenor', 'Minimum tenor');
  posInt('maxTenor', 'Maximum tenor');
  if (Number.isInteger(v.minTenor) && Number.isInteger(v.maxTenor) && v.minTenor > v.maxTenor) add(errors, 'maxTenor', 'The maximum tenor must not be below the minimum.');
  if (v.maxTenor > 600) add(errors, 'maxTenor', 'The maximum tenor cannot exceed 600 months.');
  posInt('minServiceMonths', 'Minimum service', 0);
  posInt('maxConcurrent', 'Running loans allowed');
  posInt('reapplyCoolingMonths', 'Minimum number of months before applying for a top-up', 0);
  if (!v.eligibleCategories?.length) add(errors, 'eligibleCategories', 'Choose at least one employee category.');
  // D-101: a top-up is matched to its payslip line by this label.
  if (v.topUpAllowed && !String(v.payslipLabel || '').trim()) add(errors, 'payslipLabel', 'Enter the payslip deduction label: a top-up is matched to its payslip line by it.');
  if (v.payslipLabel && !/[A-Za-z]/.test(v.payslipLabel)) add(errors, 'payslipLabel', 'The payslip deduction label needs letters, as printed on the payslip.');

  const keys = new Set();
  (v.fields || []).forEach((f, i) => {
    if (keys.has(f.key)) add(errors, `fields.${i}.key`, `The key ${f.key} is used twice.`);
    keys.add(f.key);
    if (!FIELD_TYPES.includes(f.type)) add(errors, `fields.${i}.type`, 'Unknown field type.');
    if (f.type === 'select' && (!f.options || f.options.length < 2)) add(errors, `fields.${i}.options`, 'A choice list needs at least two options.');
    if (f.type !== 'select' && f.options?.length) add(errors, `fields.${i}.options`, 'Only choice lists have options.');
  });
  const documentCodes = new Set();
  (v.requiredDocuments || []).forEach((d, i) => {
    if (documentCodes.has(d.code)) add(errors, `requiredDocuments.${i}.code`, 'Document codes must be unique.');
    documentCodes.add(d.code);
    if (!Number.isInteger(d.minFiles) || d.minFiles < 0) add(errors, `requiredDocuments.${i}.minFiles`, 'Minimum files must be zero or greater.');
    if (!Number.isInteger(d.maxFiles) || d.maxFiles < 1 || d.maxFiles > 20 || d.maxFiles < d.minFiles) add(errors, `requiredDocuments.${i}.maxFiles`, 'Maximum must be between the minimum and 20.');
    if (d.active !== false && d.mandatory && d.minFiles < 1) add(errors, `requiredDocuments.${i}.minFiles`, 'Mandatory documents require at least one file.');
    if (!d.allowedTypes?.length || d.allowedTypes.some((t) => !['pdf', 'jpg', 'jpeg', 'png'].includes(t))) add(errors, `requiredDocuments.${i}.allowedTypes`, 'Choose supported file types.');
  });
  const minTotal = (v.requiredDocuments || []).filter((d) => d.active !== false && d.mandatory).reduce((sum, d) => sum + (d.minFiles || 0), 0);
  if (minTotal > 20) add(errors, 'requiredDocuments', 'Total mandatory files cannot exceed the application limit of 20.');
  return errors;
}

const canon = (value) => {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(canon);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value._bsontype === 'ObjectId') return String(value);
  if (typeof value === 'object') {
    const src = typeof value.toObject === 'function' ? value.toObject() : value;
    return Object.fromEntries(Object.keys(src).sort().filter((k) => k !== '_id').map((k) => [k, canon(src[k])]));
  }
  return value;
};

/** Field-by-field comparison: [{ field, label, before, after }] for fields that differ. */
function diff(fields, before, after) {
  return fields
    .map(([field, label]) => ({ field, label, before: canon(before ? before[field] : null), after: canon(after[field]) }))
    // An empty text and a field an older version never had are the same (D-101: payslipLabel).
    .filter((d) => JSON.stringify(d.before ?? '') !== JSON.stringify(d.after ?? ''));
}

const pick = (fields, doc) => Object.fromEntries(fields.map(([f]) => [f, doc[f]]));

module.exports = { PRODUCT_FIELDS, validateProduct, diff, pick, canon };

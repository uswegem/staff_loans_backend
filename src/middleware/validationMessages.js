'use strict';

// Plain-language validation messages. Joi's own messages name the field by its key
// ("staffNo is not allowed to be empty"); people see "Enter the staff number." instead.
// Messages written into a schema with .messages() are already plain and are kept.
// Each sentence has a Swahili pattern in src/i18n/sw.js, and each label below a
// Swahili entry, so a Swahili request gets the message in Swahili.

const LABELS = {
  staffNo: 'staff number',
  lineManagerStaffNo: 'line manager staff number',
  userName: 'username',
  username: 'username',
  firstName: 'first name',
  middleName: 'middle name',
  lastName: 'surname',
  title: 'job title',
  station: 'work station',
  department: 'department',
  category: 'employee category',
  employmentType: 'employment type',
  dateJoined: 'date joined',
  contractEndDate: 'contract end date',
  dateOfBirth: 'date of birth',
  email: 'email',
  mobile: 'mobile phone',
  workPhone: 'work phone',
  password: 'password',
  newPassword: 'new password',
  currentPassword: 'current password',
  amount: 'amount',
  tenor: 'tenor',
  purpose: 'purpose',
  reason: 'reason',
  comment: 'comment',
  note: 'note',
  effectiveFrom: 'effective date',
  name: 'name',
  date: 'date',
  from: 'start date',
  until: 'end date',
  to: 'end date',
  reportDate: 'report date',
  outcome: 'outcome',
  transactionRef: 'transaction reference',
  delegateId: 'delegate',
};

const DATE_TYPES = new Set(['date.base', 'date.format', 'string.isoDate']);

/** A readable label for a field path: "requiredDocuments.0.maxFiles" → "max files". */
function labelOf(path) {
  const key = [...path].reverse().find((p) => typeof p === 'string') || '';
  if (LABELS[key]) return LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').toLowerCase().trim();
  return words.replace(/^max /, 'maximum ').replace(/^min /, 'minimum ') || 'value';
}

/** The message for one Joi error detail. */
function friendly(detail) {
  const raw = String(detail.message || '').replace(/"/g, '');
  const ctxLabel = detail.context?.label;
  // A schema's own .messages() text does not start with the field key: keep it.
  if (!ctxLabel || !raw.startsWith(String(ctxLabel))) return raw;
  const label = labelOf(detail.path || []);
  // Dates are chosen, other values entered. Judged by the key (dateJoined, effectiveFrom,
  // disbursedOn), not the label: "work station" must not read as a date.
  const key = [...(detail.path || [])].reverse().find((p) => typeof p === 'string') || '';
  const isDate = /^(date|from|until|to)$|(Date|Joined|On|From|Until)$/.test(key) || DATE_TYPES.has(detail.type);
  const { limit } = detail.context || {};
  switch (detail.type) {
    case 'any.required':
    case 'string.empty':
    case 'any.empty':
      return isDate ? `Choose the ${label}.` : `Enter the ${label}.`;
    case 'string.max':
      return `Use ${limit} characters or fewer for the ${label}.`;
    case 'string.min':
      return `Use at least ${limit} characters for the ${label}.`;
    case 'string.email':
      return 'Enter a valid email address.';
    case 'number.base':
      return `Enter a number for the ${label}.`;
    case 'number.integer':
      return `Enter a whole number for the ${label}.`;
    case 'number.min':
      return `The ${label} must be ${limit} or more.`;
    case 'number.max':
      return `The ${label} must be ${limit} or less.`;
    case 'any.only':
      return `Choose one of the options for the ${label}.`;
    default:
      return isDate ? `Enter a valid ${label}.` : `Check the ${label}.`;
  }
}

module.exports = { friendly, labelOf, LABELS };

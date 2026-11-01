'use strict';

// Staff numbers are Payroll's employee codes, as printed on the payslip (for example
// AT637), unique per staff member (DECISIONS C-07, confirmed 31 Oct 2026). Stored in
// upper case. One definition for the models, the API and the Excel upload.

const STAFF_NO = /^[A-Z][A-Z0-9]{1,11}$/;
const STAFF_NO_MESSAGE = 'Enter the staff number as on the payslip (employee code), for example AT637.';

module.exports = { STAFF_NO, STAFF_NO_MESSAGE };

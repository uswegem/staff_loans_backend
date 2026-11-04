'use strict';

// Credit bureau outcomes the Credit Analyst records (D-99). Applications decided before
// D-99 keep their outcome as recorded (Clear, Adverse: minor, Adverse: serious, No record
// found): it is shown as stored and never migrated.

const CRB_OUTCOMES = Object.freeze(['Low Risk', 'Average Risk', 'High Risk', 'No Record Found']);

module.exports = { CRB_OUTCOMES };

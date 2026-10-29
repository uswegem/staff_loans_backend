'use strict';

// Application statuses (BRD 7.4; "Pending P&C Manager Review" per DECISIONS D-02).

const STATUS = Object.freeze({
  draft: 'Draft',
  pending_credit: 'Pending Credit Review',
  pending_pcm: 'Pending P&C Manager Review',
  pending_hr: 'Pending HR Review',
  pending_ceo: 'Pending CEO Approval',
  returned: 'Returned for Correction',
  rejected: 'Rejected',
  pending_reaccept: 'Approved – Revised Terms to Accept',
  declined: 'Declined by Applicant',
  pending_disbursement: 'Pending Disbursement',
  disbursed: 'Disbursed',
  withdrawn: 'Withdrawn',
});

const STATUSES = Object.keys(STATUS);
const PENDING_STAGE = ['pending_credit', 'pending_pcm', 'pending_hr', 'pending_ceo'];
/** Open applications count for BR-08 (one open application per product). */
const OPEN = ['draft', ...PENDING_STAGE, 'returned', 'pending_reaccept', 'pending_disbursement'];
/** The applicant may change the request in these. */
const EDITABLE = ['draft', 'returned'];
/** The applicant may withdraw before final approval (FR-11). */
const WITHDRAWABLE = ['draft', ...PENDING_STAGE, 'returned'];

module.exports = { STATUS, STATUSES, PENDING_STAGE, OPEN, EDITABLE, WITHDRAWABLE };

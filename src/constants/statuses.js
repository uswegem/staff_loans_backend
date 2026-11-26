'use strict';

// Application statuses (BRD 7.4; "Pending P&C Manager Review" per DECISIONS D-02;
// "Pending People and Culture Review" per D-103: either the P&C Manager or the Head of P&C).

const STATUS = Object.freeze({
  draft: 'Draft',
  pending_credit: 'Pending Credit Underwriting', // D-113
  pending_pcm: 'Pending P&C Manager Review',
  pending_hr: 'Pending HR Review',
  pending_pc: 'Pending People and Culture Review',
  pending_ceo: 'Pending CEO Approval',
  returned: 'Returned for Correction',
  rejected: 'Rejected',
  pending_reaccept: 'Approved – Revised Terms to Accept',
  declined: 'Declined by Applicant',
  pending_booking: 'Pending Booking', // D-107: People and Culture book it in core banking
  pending_disbursement: 'Pending Disbursement',
  disbursed: 'Disbursed',
  withdrawn: 'Withdrawn',
});

const STATUSES = Object.keys(STATUS);
const PENDING_STAGE = ['pending_credit', 'pending_pcm', 'pending_hr', 'pending_pc', 'pending_ceo'];
/** Open applications count for BR-08 (one open application per product). */
const OPEN = ['draft', ...PENDING_STAGE, 'returned', 'pending_reaccept', 'pending_booking', 'pending_disbursement'];
/** Finally approved and in force (D-107): being booked, waiting for OPS, or disbursed. */
const APPROVED_LOAN = ['pending_booking', 'pending_disbursement', 'disbursed'];
/** The applicant may change the request in these. */
const EDITABLE = ['draft', 'returned'];
/** The applicant may withdraw before final approval (FR-11). */
const WITHDRAWABLE = ['draft', ...PENDING_STAGE, 'returned'];

module.exports = { STATUS, STATUSES, PENDING_STAGE, OPEN, APPROVED_LOAN, EDITABLE, WITHDRAWABLE };

'use strict';

// A staff loan application (BRD 6, 7, 9.2). Amounts are integer TZS. The product and
// pricing versions are pinned at submission (FR-61, DECISIONS D-06) and the route is
// fixed at the first submission (BRD 7.3).

const mongoose = require('mongoose');
const { STATUSES } = require('../constants/statuses');

const { Schema } = mongoose;

const applicationSchema = new Schema(
  {
    ref: { type: String, required: true, unique: true }, // SL-YYYY-NNNNN (FR-12)
    applicantUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    applicantStaffId: { type: Schema.Types.ObjectId, ref: 'Staff', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productVersionId: { type: Schema.Types.ObjectId, ref: 'ProductVersion', required: true },
    pricingVersionId: { type: Schema.Types.ObjectId, ref: 'PricingVersion' },
    route: { type: String, enum: ['nonmgmt', 'mgmt', 'ceo', 'hrhead', null], default: null },
    stages: { type: [String], default: [] },
    status: { type: String, enum: STATUSES, default: 'draft' },
    currentStage: { type: String, default: null },
    stageEnteredAt: Date,
    stageDueAt: Date,
    cycle: { type: Number, default: 0 }, // submissions so far
    submittedAt: Date, // first submission
    lastSubmittedAt: Date,

    amount: { type: Number, min: 0 },
    tenor: { type: Number, min: 0 },
    purpose: { type: String, trim: true, maxlength: 500 },
    productFields: { type: Schema.Types.Mixed, default: {} },
    repayment: {
      method: { type: String, enum: ['payroll'], default: 'payroll' }, // salary deduction only (D-84)
      bank: String,
      branch: String,
      accountName: String,
      accountNo: String,
    },
    topUp: {
      on: { type: Boolean, default: false },
      // Whether the staff member ticked or unticked top-up themselves. Until they do, the
      // web app ticks it when the payslip shows this product's deduction; after, it keeps their choice.
      chosen: { type: Boolean, default: false },
      applicationId: { type: Schema.Types.ObjectId, ref: 'Application' }, // the SLAS loan topped up, when there is one (D-87, D-101)
      payslipLine: { label: String, amount: Number }, // the payslip deduction topped up (D-101)
      loanRef: String,
      instalment: { type: Number, min: 0 },
      outstanding: { type: Number, min: 0 }, // confirmed by OPS from core banking (BR-09)
    },
    probation: { onProbation: Boolean, reason: String, verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' }, verifiedAt: Date }, // NS-01
    consents: {
      truth: Boolean,
      deduct: Boolean,
      crb: Boolean,
      sms: Boolean,
      declarations: { type: [String], default: undefined },
      at: Date,
      // D-108: the data protection notice ticked before signing, in the language shown.
      dataProtection: { accepted: Boolean, version: String, language: String, at: Date, _id: false },
    },
    documentIds: { type: [{ type: Schema.Types.ObjectId, ref: 'StoredFile' }], default: [] },
    // The latest payslip and the figures read from it (D-78, D-79). Only the reader sets them.
    payslip: {
      fileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
      originalName: String,
      payDate: String, // YYYY-MM-DD
      basic: Number,
      lfbDeductions: Number,
      lfbLines: { type: [{ _id: false, label: String, amount: Number }], default: undefined },
      readAt: Date,
    },

    // Review (M5)
    // Credit bureau check (D-105): every report file the Credit Analyst attached. fileId is the
    // single file kept before D-105; scripts/migrate-2026-12.js moves it into fileIds.
    crb: { outcome: String, reportDate: Date, fileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' }, fileIds: { type: [{ type: Schema.Types.ObjectId, ref: 'StoredFile' }], default: undefined } },
    appraisalNote: String,
    arrearsNote: String,
    recommended: { amount: Number, tenor: Number, reason: String, by: { type: Schema.Types.ObjectId, ref: 'User' } },
    // D-113: Credit Underwriting recommends; People and Culture or the CEO decides. The latest
    // recommendation only (a new cycle overwrites it); every one stays in Decision.
    creditRecommendation: {
      outcome: { type: String, enum: ['approve', 'reject'] },
      reason: String,
      crbOutcome: String,
      by: { type: Schema.Types.ObjectId, ref: 'User' },
      onBehalfOf: { type: Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      cycle: Number,
    },
    hrChecks: { employment: Boolean, category: Boolean, salary: Boolean, probationReasonVerified: Boolean },
    approved: { amount: Number, tenor: Number, instalment: Number },
    finalApprovedAt: Date,
    schedule: { type: Array, default: undefined }, // regenerated at final approval and disbursement (FR-21, FR-24)
    scheduleBasis: { type: String, enum: ['final_approval', 'disbursement', null], default: null },
    revisedExpiresAt: Date, // FR-39
    outsideSla: { type: Boolean, default: false },
    // Set on a loan when a top-up of it is disbursed: its deduction stops (D-87).
    settledByTopUp: { applicationId: { type: Schema.Types.ObjectId, ref: 'Application' }, ref: String, at: Date }, // Q3: Pending Disbursement past approvalSlaDays (flag only)
    overdueNotifiedAt: Date, // stage-overdue reminder sent for the current stage (BRD 12)

    // D-107: People and Culture book the loan in core banking before OPS disburses it.
    booking: {
      loanAccountNumber: String,
      date: Date, // local midnight of the booking date
      note: String,
      bookedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      bookedAt: Date,
    },

    // OPS confirmation (FR-20 to FR-22)
    disbursement: {
      date: Date, // local midnight of the disbursement date
      transactionRef: String,
      comment: String,
      conditions: { type: [{ _id: false, text: String, ticked: Boolean }], default: undefined },
      topUpSettled: Boolean,
      confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      confirmedAt: Date,
    },

    applicantSnapshot: Schema.Types.Mixed, // staff and salary in force at submission (FR-03)
    calcSnapshot: Schema.Types.Mixed, // the full quote at submission (BRD 10)
    ruleFlags: { type: [String], default: [] }, // soft rules for reviewers
    currentAgreementId: { type: Schema.Types.ObjectId, ref: 'Agreement', default: null },
    agreementLanguage: { type: String, enum: ['en', 'sw'] }, // D-109: the language the applicant signed in
    closedAtStage: String,
    closedReason: String,
    closedAt: Date,
  },
  { timestamps: true }
);

applicationSchema.index({ applicantUserId: 1, createdAt: -1 });
applicationSchema.index({ applicantUserId: 1, productId: 1, status: 1 });
applicationSchema.index({ status: 1, currentStage: 1 });
applicationSchema.index({ status: 1, 'disbursement.date': -1 });

module.exports = mongoose.model('Application', applicationSchema);

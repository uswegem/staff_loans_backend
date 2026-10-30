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
      method: { type: String, enum: ['payroll', 'account'], default: 'payroll' },
      bank: String,
      branch: String,
      accountName: String,
      accountNo: String,
    },
    topUp: {
      on: { type: Boolean, default: false },
      loanRef: String,
      instalment: { type: Number, min: 0 },
      outstanding: { type: Number, min: 0 }, // confirmed by OPS from core banking (BR-09)
    },
    probation: { onProbation: Boolean, reason: String, verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' }, verifiedAt: Date }, // NS-01
    consents: { truth: Boolean, deduct: Boolean, crb: Boolean, sms: Boolean, at: Date },
    documentIds: { type: [{ type: Schema.Types.ObjectId, ref: 'StoredFile' }], default: [] },

    // Review (M5)
    crb: { outcome: String, reportDate: Date, fileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' } },
    appraisalNote: String,
    arrearsNote: String,
    recommended: { amount: Number, tenor: Number, reason: String, by: { type: Schema.Types.ObjectId, ref: 'User' } },
    hrChecks: { employment: Boolean, category: Boolean, salary: Boolean, probationReasonVerified: Boolean },
    approved: { amount: Number, tenor: Number, instalment: Number },
    finalApprovedAt: Date,
    schedule: { type: Array, default: undefined }, // regenerated at final approval and disbursement (FR-21, FR-24)
    scheduleBasis: { type: String, enum: ['final_approval', 'disbursement', null], default: null },
    revisedExpiresAt: Date, // FR-39
    outsideSla: { type: Boolean, default: false },

    applicantSnapshot: Schema.Types.Mixed, // staff and salary in force at submission (FR-03)
    calcSnapshot: Schema.Types.Mixed, // the full quote at submission (BRD 10)
    ruleFlags: { type: [String], default: [] }, // soft rules for reviewers
    currentAgreementId: { type: Schema.Types.ObjectId, ref: 'Agreement', default: null },
    closedAtStage: String,
    closedReason: String,
    closedAt: Date,
  },
  { timestamps: true }
);

applicationSchema.index({ applicantUserId: 1, createdAt: -1 });
applicationSchema.index({ applicantUserId: 1, productId: 1, status: 1 });
applicationSchema.index({ status: 1, currentStage: 1 });

module.exports = mongoose.model('Application', applicationSchema);

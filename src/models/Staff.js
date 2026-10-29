'use strict';

// Staff master data maintained by People and Culture (BRD 9.1, FR-01).
// Kept apart from the login identity in User (prompt 3a.6).

const mongoose = require('mongoose');

const { Schema } = mongoose;

const kinSchema = new Schema(
  { name: String, relationship: String, address: String, phone: String, employer: String },
  { _id: false }
);

const otherLoanSchema = new Schema(
  { lender: String, type: { type: String, enum: ['personal', 'mortgage', 'vehicle', 'other'] }, instalment: { type: Number, min: 0 } },
  { _id: false }
);

// Declared existing LFB loans (decision 19). productId/disbursedOn are optional and
// only used for the reapply cooling period (NS-02, DECISIONS C-03).
const lfbLoanSchema = new Schema(
  {
    ref: String,
    instalment: { type: Number, min: 0 },
    outstanding: { type: Number, min: 0 },
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    disbursedOn: Date,
  },
  { _id: false }
);

// NS-02: the last successful application per product.
const loanHistorySchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application' },
    ref: String,
    appliedAt: Date,
    approvedAt: Date,
    disbursedAt: Date,
  },
  { _id: false }
);

const staffSchema = new Schema(
  {
    staffNo: { type: String, required: true, unique: true, uppercase: true, trim: true, match: /^LFB\d{4}$/ },
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, required: true, trim: true },
    title: String,
    department: { type: String, index: true },
    station: String,
    stationHead: { name: String, phone: String },
    lineManagerId: { type: Schema.Types.ObjectId, ref: 'Staff' },
    category: { type: String, enum: ['Management', 'Non-management'], required: true, index: true },
    employmentType: { type: String, enum: ['Permanent', 'Probation', 'Contract'], required: true },
    dateJoined: { type: Date, required: true },
    probationEndDate: Date,
    contractEndDate: Date,
    retirementDate: Date,
    incomeClass: { type: String, enum: ['fixed', 'commission'], default: 'fixed' },
    email: { type: String, lowercase: true, trim: true },
    workPhone: String,
    status: { type: String, enum: ['active', 'exited', 'deactivated'], default: 'active', index: true },
    exitDate: Date,
    personal: {
      maritalStatus: String,
      dob: Date,
      nida: { type: String, match: /^\d{20}$/ },
      nationality: String,
      mobile: String,
      homePhone: String,
      poBox: String,
      residence: String,
    },
    bank: { bank: String, branch: String, accountName: String, accountNo: String },
    nextOfKin: { type: [kinSchema], default: [] },
    deductions: { medical: { type: Number, default: 0, min: 0 }, other: { type: Number, default: 0, min: 0 } },
    otherLoans: { type: [otherLoanSchema], default: [] },
    existingLfbLoans: { type: [lfbLoanSchema], default: [] },
    payDeclaredAt: Date,
    loanHistory: { type: [loanHistorySchema], default: [] },
    lastAppliedAt: Date,
  },
  { timestamps: true }
);

staffSchema.virtual('fullName').get(function fullName() {
  return [this.firstName, this.middleName, this.lastName].filter(Boolean).join(' ');
});
staffSchema.set('toJSON', { virtuals: true });
staffSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Staff', staffSchema);

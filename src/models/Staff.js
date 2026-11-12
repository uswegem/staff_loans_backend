'use strict';

// Staff master data maintained by People and Culture (BRD 9.1, FR-01).
// Kept apart from the login identity in User (prompt 3a.6).

const mongoose = require('mongoose');
const { STAFF_NO } = require('../constants/staffNo');
const { phoneOrRaw, nidaOrRaw } = require('../utils/formats');

const { Schema } = mongoose;

// Phone numbers and NIDA are kept in one format (D-93): a value that normalises is
// stored normalised; anything else is kept as given so the owner sees it as invalid.
const phone = { type: String, set: phoneOrRaw };

const kinSchema = new Schema(
  // First name and surname (D-85); `name` is the pre-D-85 full name, split by scripts/split-names.js.
  { firstName: String, lastName: String, name: String, relationship: String, address: String, phone, employer: String },
  { _id: false }
);

const otherLoanSchema = new Schema(
  { lender: String, type: { type: String, enum: ['personal', 'mortgage', 'vehicle', 'other'] }, instalment: { type: Number, min: 0 } },
  { _id: false }
);

// Existing LFB staff loans from before SLAS, declared by the staff member (decision 19).
// productId and disbursedOn are optional; when both are given the loan starts the
// reapply cooling period for that product (NS-02, DECISIONS C-03).
const lfbLoanSchema = new Schema(
  {
    description: { type: String, trim: true },
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
    staffNo: { type: String, required: true, unique: true, uppercase: true, trim: true, match: STAFF_NO }, // employee code (C-07)
    userName: { type: String, trim: true, lowercase: true, match: /^[a-z][a-z0-9._-]{2,63}$/ },
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, required: true, trim: true }, // the surname (D-85)
    title: String,
    department: { type: String, index: true },
    station: String,
    stationHead: { name: String, phone },
    lineManagerId: { type: Schema.Types.ObjectId, ref: 'Staff' },
    category: { type: String, enum: ['Management', 'Non-management'], required: true, index: true },
    // People and Culture complete these; until then the staff member cannot apply (D-91).
    employmentType: { type: String, enum: ['Permanent', 'Probation', 'Contract'] },
    dateJoined: { type: Date },
    gender: { type: String, enum: ['Male', 'Female'] },
    probationEndDate: Date,
    contractEndDate: Date,
    // No longer entered (D-98): the retirement date is worked out from the verified date of
    // birth (services/staff/retirement.js). Earlier values are kept and not used.
    retirementDate: Date,
    incomeClass: { type: String, enum: ['fixed', 'commission'], default: 'fixed' },
    email: { type: String, lowercase: true, trim: true },
    lfbAccountNo: { type: String, trim: true }, // maintained by People and Culture (FR-01); pre-fills the profile bank details
    workPhone: phone,
    status: { type: String, enum: ['active', 'exited', 'deactivated'], default: 'active', index: true },
    exitDate: Date,
    // The HR-verified date of birth: the only one loan rules may use (D-82). It changes
    // only when People and Culture approve a DobChange; pending is that open change.
    dateOfBirth: {
      value: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      verifiedAt: Date,
      verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      changeId: { type: Schema.Types.ObjectId, ref: 'DobChange' },
      pending: { changeId: { type: Schema.Types.ObjectId, ref: 'DobChange' }, proposed: String, submittedAt: Date, submittedBy: { type: Schema.Types.ObjectId, ref: 'User' } },
    },
    personal: {
      maritalStatus: String,
      dob: Date, // mirrors the verified date of birth; not edited directly since D-82
      nida: { type: String, set: nidaOrRaw }, // YYYYMMDD-XXXXX-XXXXX-XX (D-93)
      nationality: String,
      mobile: phone,
      homePhone: phone,
      // No longer asked for (D-93); earlier answers are kept and may be empty.
      poBox: { type: String, default: null },
      residence: { type: String, default: null },
      // Structured address (D-93): region, district and ward from the location list.
      address: { region: String, district: String, ward: String, street: String, house: String },
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

staffSchema.index({ userName: 1 }, { unique: true, partialFilterExpression: { userName: { $type: 'string' } } });

staffSchema.virtual('fullName').get(function fullName() {
  return [this.firstName, this.middleName, this.lastName].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
});
staffSchema.set('toJSON', { virtuals: true });
staffSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Staff', staffSchema);

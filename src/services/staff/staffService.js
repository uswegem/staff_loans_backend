'use strict';

// Staff master data maintained by People and Culture (BRD 9.1, FR-01, FR-03, FR-04).
// Used by the staff records screens and by the bulk upload, so both apply the same
// rules and write the same audit entries (NFR-05).

const Staff = require('../../models/Staff');
const Salary = require('../../models/Salary');
const User = require('../../models/User');
const Session = require('../../models/Session');
const RefreshToken = require('../../models/RefreshToken');
const Settings = require('../../models/Settings');
const audit = require('../audit/auditService');
const { addMonths, localDay } = require('../../utils/dates');

const LFB_BANK = 'Letshego Faidika Bank';

// Fields People and Culture maintain (FR-01). Personal, bank, next-of-kin and pay
// declarations belong to the staff member's profile.
const HR_FIELDS = ['firstName', 'middleName', 'lastName', 'title', 'department', 'station', 'stationHead', 'lineManagerId', 'category', 'employmentType', 'dateJoined', 'probationEndDate', 'contractEndDate', 'retirementDate', 'email', 'workPhone', 'lfbAccountNo', 'incomeClass'];

const fullName = (s) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

function hrSnapshot(s) {
  if (!s) return null;
  const o = typeof s.toObject === 'function' ? s.toObject() : s;
  const out = {};
  [...HR_FIELDS, 'status', 'exitDate'].forEach((k) => {
    out[k] = o[k] && o[k]._bsontype === 'ObjectId' ? String(o[k]) : o[k];
  });
  return out;
}

/** NS-01: on probation until the later of date joined + probation months and the HR end date. */
function probationInfo(staff, probationMonths, now = new Date()) {
  const byRule = staff.dateJoined ? addMonths(staff.dateJoined, probationMonths) : null;
  const byHr = staff.probationEndDate || null;
  const endsOn = [byRule, byHr].filter(Boolean).sort((a, b) => b - a)[0] || null;
  return { onProbation: !!endsOn && now < endsOn, endsOn: endsOn ? localDay(endsOn) : null };
}

async function probationFor(staff, now) {
  const s = await Settings.get();
  return probationInfo(staff, s.probationMonths, now);
}

/** Ends every session of the staff member's sign-in (FR-04: exited staff cannot log in). */
async function endSignIns(staffId, reason, session) {
  const user = await User.findOne({ staffId }).session(session || null);
  if (!user) return;
  await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } }, { session });
  await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
}

/**
 * Creates or updates a staff record. fields are HR fields; extra = { mobile, status,
 * exitDate, salary: { basic, allowances, commission, gross, net, effectiveFrom } }.
 */
async function saveStaff(req, existing, staffNo, fields, extra = {}, { session, source = 'manual' } = {}) {
  const before = hrSnapshot(existing);
  let staff = existing;
  if (!staff) {
    staff = new Staff({
      staffNo,
      ...fields,
      status: extra.status || 'active',
      personal: { mobile: extra.mobile || undefined },
      bank: { bank: LFB_BANK, branch: '', accountName: fullName(fields), accountNo: fields.lfbAccountNo || '' },
      nextOfKin: [],
    });
  } else {
    HR_FIELDS.forEach((k) => {
      if (fields[k] !== undefined) staff[k] = fields[k];
    });
    if (extra.mobile && !staff.personal?.mobile) staff.set('personal.mobile', extra.mobile);
    if (fields.lfbAccountNo && !staff.bank?.accountNo) staff.set('bank.accountNo', fields.lfbAccountNo);
    if (extra.status && extra.status !== staff.status) {
      staff.status = extra.status;
      staff.exitDate = extra.status === 'exited' ? extra.exitDate || new Date() : staff.exitDate;
    }
  }
  await staff.save({ session });
  if (staff.status !== 'active' && (!before || before.status === 'active')) await endSignIns(staff._id, staff.status, session);

  let salary = null;
  if (extra.salary) {
    const s = extra.salary;
    [salary] = await Salary.create([{ staffId: staff._id, basic: s.basic, allowances: s.allowances || 0, commission: s.commission || 0, gross: s.gross ?? null, net: s.net ?? null, effectiveFrom: s.effectiveFrom, source, recordedBy: req.auth.user._id }], { session });
  }
  await audit.record(
    {
      req,
      action: existing ? 'staff.update' : 'staff.create',
      description: `Staff record ${existing ? 'updated' : 'created'}: ${staffNo} ${fullName(staff)}${source !== 'manual' ? ` (${source})` : ''}`,
      entity: 'Staff',
      entityId: String(staff._id),
      before,
      after: { ...hrSnapshot(staff), ...(salary ? { salary: { basic: salary.basic, allowances: salary.allowances, effectiveFrom: salary.effectiveFrom } } : {}) },
    },
    { session }
  );
  return staff;
}

async function addSalary(req, staff, s, { session } = {}) {
  const [salary] = await Salary.create([{ staffId: staff._id, ...s, recordedBy: req.auth.user._id, source: 'manual' }], { session });
  const prev = await Salary.findOne({ staffId: staff._id, effectiveFrom: { $lt: s.effectiveFrom } }).sort({ effectiveFrom: -1 }).session(session || null);
  await audit.record(
    { req, action: 'staff.salary_add', description: `Salary from ${localDay(s.effectiveFrom)} recorded for ${staff.staffNo}`, entity: 'Staff', entityId: String(staff._id), before: prev ? { basic: prev.basic, allowances: prev.allowances, effectiveFrom: prev.effectiveFrom } : null, after: { basic: salary.basic, allowances: salary.allowances, effectiveFrom: salary.effectiveFrom } },
    { session }
  );
  return salary;
}

module.exports = { HR_FIELDS, saveStaff, addSalary, endSignIns, probationInfo, probationFor, hrSnapshot, fullName, LFB_BANK };

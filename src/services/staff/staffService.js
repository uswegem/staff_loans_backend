'use strict';

// Staff master data maintained by People and Culture (BRD 9.1, FR-01, FR-03, FR-04).
// Used by the staff records screens and by the bulk upload, so both apply the same
// rules and write the same audit entries (NFR-05).

const Staff = require('../../models/Staff');
const User = require('../../models/User');
const Session = require('../../models/Session');
const RefreshToken = require('../../models/RefreshToken');
const Settings = require('../../models/Settings');
const audit = require('../audit/auditService');
const { addMonths, localDay } = require('../../utils/dates');

const LFB_BANK = 'Letshego Faidika Bank';

// Fields People and Culture maintain (FR-01). Personal, bank, next-of-kin and pay
// declarations belong to the staff member's profile. The probation end date is worked out
// (D-100): earlier stored values are kept but no longer written or used.
const HR_FIELDS = ['userName', 'firstName', 'middleName', 'lastName', 'gender', 'title', 'department', 'station', 'stationHead', 'lineManagerId', 'category', 'employmentType', 'dateJoined', 'contractEndDate', 'email', 'workPhone', 'lfbAccountNo', 'incomeClass'];

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

/**
 * NS-01, D-100: on probation until date joined + the probation months in the settings. A
 * probation end date entered before D-100 is kept on the record but no longer counts.
 */
function probationInfo(staff, probationMonths, now = new Date()) {
  const endsOn = staff.dateJoined ? addMonths(staff.dateJoined, probationMonths) : null;
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
 * Creates or updates a staff record. fields are HR fields; extra = { mobile, nida, status,
 * exitDate }. No salary is recorded (D-100): affordability comes from the payslip.
 */
async function saveStaff(req, existing, staffNo, fields, extra = {}, { session, source = 'manual' } = {}) {
  const before = hrSnapshot(existing);
  let staff = existing;
  if (!staff) {
    staff = new Staff({
      staffNo,
      ...fields,
      gender: fields.gender || undefined,
      status: extra.status || 'active',
      personal: { mobile: extra.mobile || undefined, nida: extra.nida || undefined },
      bank: { bank: LFB_BANK, branch: '', accountName: fullName(fields), accountNo: fields.lfbAccountNo || '' },
      nextOfKin: [],
    });
  } else {
    HR_FIELDS.forEach((k) => {
      if (fields[k] !== undefined) staff[k] = fields[k] === '' && k === 'gender' ? undefined : fields[k];
    });
    if (extra.mobile && !staff.personal?.mobile) staff.set('personal.mobile', extra.mobile);
    if (extra.nida) staff.set('personal.nida', extra.nida);
    if (fields.lfbAccountNo && !staff.bank?.accountNo) staff.set('bank.accountNo', fields.lfbAccountNo);
    if (extra.status && extra.status !== staff.status) {
      staff.status = extra.status;
      staff.exitDate = extra.status === 'exited' ? extra.exitDate || new Date() : staff.exitDate;
    }
  }
  await staff.save({ session });
  // Preserve Staff/User login consistency when HR corrects a username.
  if (staff.userName && staff.userName !== before?.userName) {
    await User.updateOne({ staffId: staff._id }, { $set: { userName: staff.userName } }, { session });
  }
  if (staff.status !== 'active' && (!before || before.status === 'active')) await endSignIns(staff._id, staff.status, session);

  await audit.record(
    {
      req,
      action: existing ? 'staff.update' : 'staff.create',
      description: `Staff record ${existing ? 'updated' : 'created'}: ${staffNo} ${fullName(staff)}${source !== 'manual' ? ` (${source})` : ''}`,
      entity: 'Staff',
      entityId: String(staff._id),
      before: before && { ...before, nida: existing.personal?.nida || null },
      after: { ...hrSnapshot(staff), nida: staff.personal?.nida || null },
    },
    { session }
  );
  return staff;
}

module.exports = { HR_FIELDS, saveStaff, endSignIns, probationInfo, probationFor, hrSnapshot, fullName, LFB_BANK };

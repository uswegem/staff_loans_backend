'use strict';

// The signed-in staff member's own profile (BRD 6, decision 7, FR-05). Employment and
// salary are read-only here; People and Culture maintain them. Each section is saved
// on its own, as in the prototype's tabs, and every save is audited (NFR-05).

const Staff = require('../models/Staff');
const Salary = require('../models/Salary');
const audit = require('../services/audit/auditService');
const dobService = require('../services/staff/dobService');
const Settings = require('../models/Settings');
const { cutoffFor, retirementDateFor } = require('../services/staff/retirement');
const { completeness, formatNida } = require('../services/staff/profileService');
const { checkAddress } = require('../services/reference/locationService');
const { eligibilityFor, applyBlockers } = require('../services/staff/eligibilityService');
const { probationFor, fullName } = require('../services/staff/staffService');
const { routeFor, describeRoute } = require('../services/workflow/routes');
const { localDay, localMidnight } = require('../utils/dates');
const { badRequest, notFound } = require('../utils/errors');

async function ownStaff(req) {
  const staff = await Staff.findById(req.auth.user.staffId);
  if (!staff) throw notFound('Your staff record was not found. Contact People and Culture.');
  return staff;
}

const day = (d) => (d ? localDay(d) : null);

async function view(req, staff) {
  const [salary, probation, profile, dateOfBirth, settings] = await Promise.all([Salary.inForce(staff._id), probationFor(staff), completeness(staff), dobService.statusOf(staff), Settings.get()]);
  const route = routeFor(req.auth.permissions, staff);
  const o = staff.toObject();
  return {
    staffNo: o.staffNo,
    fullName: fullName(o),
    firstName: o.firstName,
    lastName: o.lastName, // the surname (D-85)
    gender: o.gender || null,
    // personal.dob is the verified date of birth only; a proposed one is in dateOfBirth.pending (D-82).
    personal: { ...o.personal, dob: o.dateOfBirth?.value || null, nida: formatNida(o.personal?.nida) },
    dateOfBirth,
    retirement: { cutoff: cutoffFor(o, settings), age: settings.retirementAge, bufferDays: settings.retirementBufferDays },
    workPhone: o.workPhone || '',
    bank: o.bank || {},
    nextOfKin: o.nextOfKin || [],
    deductions: o.deductions || { medical: 0, other: 0 },
    otherLoans: o.otherLoans || [],
    existingLfbLoans: (o.existingLfbLoans || []).map((l) => ({ ...l, productId: l.productId ? String(l.productId) : null, disbursedOn: day(l.disbursedOn) })),
    payDeclaredAt: o.payDeclaredAt || null,
    employment: {
      title: o.title,
      department: o.department,
      station: o.station,
      stationHead: o.stationHead,
      category: o.category,
      employmentType: o.employmentType,
      dateJoined: day(o.dateJoined),
      retirementDate: retirementDateFor(o, settings), // from the verified date of birth (D-98)
      contractEndDate: day(o.contractEndDate),
      probation,
    },
    salary: salary ? { basic: salary.basic, allowances: salary.allowances, commission: salary.commission, effectiveFrom: day(salary.effectiveFrom) } : null,
    route: { key: route.key, label: route.label, description: describeRoute(route), limitedCredit: route.limitedCredit },
    completeness: profile,
    // What stops applying once the profile is complete: date of birth not verified, or no
    // employment record or salary from People and Culture (D-97).
    applyBlockers: applyBlockers(o, salary),
  };
}

const pickKeys = (staff, keys) => Object.fromEntries(keys.map((k) => [k, staff.toObject()[k]]));

async function saveSection(req, res, section, apply) {
  const staff = await ownStaff(req);
  const before = pickKeys(staff, section.keys);
  apply(staff);
  await staff.save();
  await audit.record({ req, action: `profile.${section.name}`, description: `${staff.staffNo} updated ${section.label}`, entity: 'Staff', entityId: String(staff._id), before, after: pickKeys(staff, section.keys) });
  res.json({ success: true, data: await view(req, staff) });
}

const ProfileController = {
  async get(req, res) {
    res.json({ success: true, data: await view(req, await ownStaff(req)) });
  },

  async completeness(req, res) {
    res.json({ success: true, data: await completeness(await ownStaff(req)) });
  },

  async eligibility(req, res) {
    const staff = await ownStaff(req);
    res.json({ success: true, data: await eligibilityFor(staff) });
  },

  async personal(req, res) {
    // Phone numbers, NIDA and nationality arrive normalised by the route (D-93).
    const b = req.body;
    if (b.address) {
      const problems = await checkAddress(b.address);
      if (Object.keys(problems).length) throw badRequest('Check the highlighted fields.', Object.fromEntries(Object.entries(problems).map(([k, v]) => [`address.${k}`, v])));
    }
    // D-82: a new date of birth is proposed for verification; the verified one stays in force.
    const current = await ownStaff(req);
    if (b.dob && b.dob !== current.dateOfBirth?.value && b.dob !== current.dateOfBirth?.pending?.proposed) {
      await dobService.submit(req, current._id, b.dob, 'profile');
    }
    await saveSection(req, res, { keys: ['personal', 'workPhone'], name: 'personal', label: 'personal details' }, (staff) => {
      ['maritalStatus', 'nationality', 'mobile', 'homePhone'].forEach((k) => {
        if (b[k] !== undefined) staff.set(`personal.${k}`, b[k]);
      });
      if (b.nida !== undefined) staff.set('personal.nida', b.nida || undefined);
      if (b.address !== undefined) staff.set('personal.address', { ...b.address });
      if (b.workPhone !== undefined) staff.workPhone = b.workPhone;
    });
  },

  async bank(req, res) {
    await saveSection(req, res, { keys: ['bank'], name: 'bank', label: 'bank details' }, (staff) => {
      staff.bank = { ...staff.toObject().bank, ...req.body };
    });
  },

  async kin(req, res) {
    await saveSection(req, res, { keys: ['nextOfKin'], name: 'kin', label: 'next of kin' }, (staff) => {
      staff.nextOfKin = req.body.nextOfKin;
    });
  },

  /**
   * Existing staff loans taken outside SLAS (decision 19). They count towards the running
   * loans per product (BR-07) and start the reapply wait (NS-02). Affordability reads the
   * LFB deductions from the payslip instead (D-78, D-80).
   */
  async pay(req, res) {
    const b = req.body;
    await saveSection(req, res, { keys: ['existingLfbLoans'], name: 'pay', label: 'existing staff loans' }, (staff) => {
      staff.existingLfbLoans = b.existingLfbLoans.map((l) => ({ ...l, disbursedOn: l.disbursedOn ? localMidnight(l.disbursedOn) : undefined }));
    });
  },
};

module.exports = ProfileController;

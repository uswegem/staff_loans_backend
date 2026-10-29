'use strict';

// Staff records for People and Culture (BRD 9.1: FR-01 to FR-04) and the Excel bulk
// upload (FR-02). staff.view reads; staff.manage changes.

const Staff = require('../models/Staff');
const Salary = require('../models/Salary');
const User = require('../models/User');
const StaffImport = require('../models/StaffImport');
const audit = require('../services/audit/auditService');
const staffSvc = require('../services/staff/staffService');
const importSvc = require('../services/staff/staffImportService');
const { completeness, formatNida } = require('../services/staff/profileService');
const { withTransaction } = require('../config/db');
const { localDay, localMidnight } = require('../utils/dates');
const { badRequest, notFound, conflict } = require('../utils/errors');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const day = (d) => (d ? localDay(d) : null);
const DATE_FIELDS = ['dateJoined', 'probationEndDate', 'contractEndDate', 'retirementDate'];

async function load(id) {
  const s = await Staff.findById(id);
  if (!s) throw notFound('Staff record not found.');
  return s;
}

async function lineManagerId(staffNo, selfNo) {
  if (staffNo === undefined) return undefined;
  if (!staffNo) return null;
  if (staffNo === selfNo) throw badRequest('Check the highlighted fields.', { lineManagerStaffNo: ['A staff member cannot be their own line manager.'] });
  const lm = await Staff.findOne({ staffNo }).select('_id');
  if (!lm) throw badRequest('Check the highlighted fields.', { lineManagerStaffNo: [`${staffNo} is not on file.`] });
  return lm._id;
}

/** Cross-field rules shared by create and update (the same as the bulk upload). */
function checkHr(f) {
  const errors = {};
  const add = (k, m) => (errors[k] = errors[k] || []).push(m);
  const d = (k) => (f[k] ? localDay(f[k]) : null);
  if (d('dateJoined') && d('dateJoined') > localDay()) add('dateJoined', 'Date joined cannot be in the future.');
  if (d('retirementDate') && d('dateJoined') && d('retirementDate') <= d('dateJoined')) add('retirementDate', 'Retirement date must be after the date joined.');
  if (d('probationEndDate') && d('dateJoined') && d('probationEndDate') < d('dateJoined')) add('probationEndDate', 'Probation end date must not be before the date joined.');
  if (f.employmentType === 'Contract' && !f.contractEndDate) add('contractEndDate', 'Contract end date is required for contract staff.');
  if (d('contractEndDate') && d('dateJoined') && d('contractEndDate') <= d('dateJoined')) add('contractEndDate', 'Contract end date must be after the date joined.');
  if (Object.keys(errors).length) throw badRequest('Check the highlighted fields.', errors);
}

function hrFields(body) {
  const out = {};
  staffSvc.HR_FIELDS.forEach((k) => {
    if (body[k] !== undefined) out[k] = DATE_FIELDS.includes(k) ? (body[k] ? localMidnight(body[k]) : null) : body[k];
  });
  return out;
}

async function detail(staff) {
  const [salaries, user, profile, probation, lm] = await Promise.all([
    Salary.find({ staffId: staff._id }).sort({ effectiveFrom: -1 }).lean(),
    User.findOne({ staffId: staff._id }).select('status lastLoginAt').lean(),
    completeness(staff),
    staffSvc.probationFor(staff),
    staff.lineManagerId ? Staff.findById(staff.lineManagerId).select('staffNo firstName middleName lastName').lean() : null,
  ]);
  const o = staff.toObject();
  const today = new Date();
  const inForce = salaries.find((s) => s.effectiveFrom <= today) || null;
  return {
    id: String(o._id),
    staffNo: o.staffNo,
    fullName: staffSvc.fullName(o),
    ...Object.fromEntries(staffSvc.HR_FIELDS.map((k) => [k, DATE_FIELDS.includes(k) ? day(o[k]) : o[k] ?? null])),
    lineManagerId: undefined,
    lineManager: lm ? { staffNo: lm.staffNo, fullName: staffSvc.fullName(lm) } : null,
    status: o.status,
    exitDate: day(o.exitDate),
    probation,
    salary: inForce ? { basic: inForce.basic, allowances: inForce.allowances, effectiveFrom: day(inForce.effectiveFrom) } : null,
    salaries: salaries.map((s) => ({ id: String(s._id), basic: s.basic, allowances: s.allowances, commission: s.commission, gross: s.gross, net: s.net, effectiveFrom: day(s.effectiveFrom), source: s.source, recordedAt: s.createdAt })),
    profile: {
      completeness: profile,
      personal: { ...o.personal, dob: day(o.personal?.dob), nida: formatNida(o.personal?.nida) },
      bank: o.bank,
      nextOfKin: o.nextOfKin,
      payDeclaredAt: o.payDeclaredAt,
    },
    signIn: user ? { status: user.status, lastLoginAt: user.lastLoginAt } : null,
  };
}

function importView(imp) {
  return {
    id: String(imp._id),
    fileName: imp.fileName,
    status: imp.status,
    summary: imp.summary,
    result: imp.result,
    createdAt: imp.createdAt,
    rows: imp.rows.map((r) => ({ rowNo: r.rowNo, staffNo: r.staffNo, name: r.name, outcome: r.outcome, problems: r.problems, changes: r.changes })),
  };
}

const StaffController = {
  async list(req, res) {
    const { q, status, category, department, page, limit } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (department) filter.department = department;
    if (q) {
      const re = new RegExp(escapeRe(q), 'i');
      filter.$or = [{ firstName: re }, { lastName: re }, { staffNo: re }, { title: re }, { station: re }];
    }
    const [total, rows] = await Promise.all([Staff.countDocuments(filter), Staff.find(filter).sort({ staffNo: 1 }).skip((page - 1) * limit).limit(limit)]);
    const ids = rows.map((r) => r._id);
    const [salaries, users] = await Promise.all([
      Salary.find({ staffId: { $in: ids }, effectiveFrom: { $lte: new Date() } }).sort({ effectiveFrom: -1 }).lean(),
      User.find({ staffId: { $in: ids } }).select('staffId status').lean(),
    ]);
    const basicBy = new Map();
    salaries.forEach((s) => {
      if (!basicBy.has(String(s.staffId))) basicBy.set(String(s.staffId), s.basic);
    });
    const userBy = new Map(users.map((u) => [String(u.staffId), u.status]));
    const items = await Promise.all(
      rows.map(async (s) => {
        const c = await completeness(s);
        return {
          id: String(s._id),
          staffNo: s.staffNo,
          fullName: staffSvc.fullName(s),
          title: s.title,
          station: s.station,
          department: s.department,
          category: s.category,
          employmentType: s.employmentType,
          status: s.status,
          basic: basicBy.get(String(s._id)) ?? null,
          profile: { complete: c.complete, done: c.done, total: c.total },
          signIn: userBy.get(String(s._id)) || null,
        };
      })
    );
    res.json({ success: true, data: { items, total, page, limit } });
  },

  async get(req, res) {
    const staff = await load(req.params.id);
    // Viewing salary and personal data is audited (NFR-05).
    await audit.record({ req, action: 'staff.view', description: `Staff record viewed: ${staff.staffNo}`, entity: 'Staff', entityId: String(staff._id) });
    res.json({ success: true, data: await detail(staff) });
  },

  async create(req, res) {
    const b = req.body;
    if (await Staff.exists({ staffNo: b.staffNo })) throw conflict(`${b.staffNo} is already on file.`, 'DUPLICATE_STAFF_NO');
    const fields = hrFields(b);
    checkHr(fields);
    if (localDay(localMidnight(b.salary.effectiveFrom)) < localDay(fields.dateJoined)) throw badRequest('Check the highlighted fields.', { 'salary.effectiveFrom': ['Salary effective from must not be before the date joined.'] });
    fields.lineManagerId = await lineManagerId(b.lineManagerStaffNo, b.staffNo);
    const staff = await withTransaction((session) =>
      staffSvc.saveStaff(req, null, b.staffNo, fields, { mobile: b.mobile, salary: { ...b.salary, effectiveFrom: localMidnight(b.salary.effectiveFrom) } }, { session })
    );
    res.status(201).json({ success: true, data: await detail(staff) });
  },

  async update(req, res) {
    const staff = await load(req.params.id);
    const fields = hrFields(req.body);
    checkHr({ ...staff.toObject(), ...fields });
    const lm = await lineManagerId(req.body.lineManagerStaffNo, staff.staffNo);
    if (lm !== undefined) fields.lineManagerId = lm;
    const saved = await withTransaction((session) => staffSvc.saveStaff(req, staff, staff.staffNo, fields, {}, { session }));
    res.json({ success: true, data: await detail(saved) });
  },

  async setStatus(req, res) {
    const staff = await load(req.params.id);
    const { status, exitDate, reason } = req.body;
    if (status === staff.status) throw conflict(`This staff record is already ${status}.`, 'SAME_STATUS');
    const saved = await withTransaction(async (session) => {
      const s = await staffSvc.saveStaff(req, staff, staff.staffNo, {}, { status, exitDate: exitDate ? localMidnight(exitDate) : undefined }, { session });
      await audit.record({ req, action: 'staff.status', description: `${staff.staffNo} set to ${status}${reason ? `: ${reason}` : ''}`, entity: 'Staff', entityId: String(staff._id), before: { status: staff.status }, after: { status, exitDate, reason } }, { session });
      return s;
    });
    res.json({ success: true, data: await detail(saved) });
  },

  async addSalary(req, res) {
    const staff = await load(req.params.id);
    const effectiveFrom = localMidnight(req.body.effectiveFrom);
    if (req.body.effectiveFrom < localDay(staff.dateJoined)) throw badRequest('Check the highlighted fields.', { effectiveFrom: ['Salary effective from must not be before the date joined.'] });
    if (await Salary.exists({ staffId: staff._id, effectiveFrom })) throw conflict('A salary already starts on that date. Choose another date.', 'DUPLICATE_SALARY_DATE');
    await withTransaction((session) => staffSvc.addSalary(req, staff, { ...req.body, effectiveFrom }, { session }));
    res.status(201).json({ success: true, data: await detail(staff) });
  },

  // ---------- bulk upload (FR-02) ----------

  async template(req, res) {
    await audit.record({ req, action: 'staff.template_download', description: 'Staff records Excel template downloaded' });
    res.set('Content-Disposition', 'attachment; filename="LFB_staff_records_template.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(importSvc.templateWorkbook());
  },

  async upload(req, res) {
    if (!req.file) throw badRequest('Choose an Excel or CSV file.', { file: ['Choose an Excel or CSV file.'] });
    let parsed;
    try {
      parsed = importSvc.parseFile(req.file.buffer);
    } catch (err) {
      if (err instanceof importSvc.ImportFileError) throw badRequest(err.message, { file: [err.message] }, 'FILE_UNREADABLE');
      throw err;
    }
    if (!parsed.length) throw badRequest('The sheet has no rows under the headings.', { file: ['The sheet has no rows under the headings.'] }, 'FILE_UNREADABLE');
    const rows = await importSvc.checkRows(parsed);
    const imp = await StaffImport.create({
      fileName: req.file.originalname.slice(0, 200),
      uploadedBy: req.auth.user._id,
      rows: rows.map((r) => ({ rowNo: r.rowNo, raw: r.raw, staffNo: r.staffNo, name: r.name, outcome: r.outcome, problems: r.problems, changes: r.changes })),
      summary: importSvc.summarise(rows),
    });
    await audit.record({ req, action: 'staff.import_upload', description: `Staff upload checked: ${imp.fileName} (${imp.summary.new} new, ${imp.summary.update} updates, ${imp.summary.error} errors)`, entity: 'StaffImport', entityId: String(imp._id), after: imp.summary });
    res.status(201).json({ success: true, data: importView(imp) });
  },

  async getImport(req, res) {
    const imp = await StaffImport.findById(req.params.id);
    if (!imp) throw notFound('Upload not found.');
    res.json({ success: true, data: importView(imp) });
  },

  async importErrors(req, res) {
    const imp = await StaffImport.findById(req.params.id);
    if (!imp) throw notFound('Upload not found.');
    const errors = imp.rows.filter((r) => r.outcome === 'error');
    res.set('Content-Disposition', `attachment; filename="staff_records_errors_${localDay()}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(importSvc.errorWorkbook(errors));
  },

  /** Applies the valid rows. Rows are checked again against the records as they are now. */
  async commit(req, res) {
    const imp = await StaffImport.findById(req.params.id);
    if (!imp) throw notFound('Upload not found.');
    if (imp.status !== 'previewed') throw conflict(`This upload was already ${imp.status}.`, 'IMPORT_CLOSED');
    const result = await withTransaction(async (session) => {
      const fresh = await importSvc.checkRows(imp.rows.map((r) => ({ rowNo: r.rowNo, raw: r.raw })), session);
      const apply = fresh.filter((r) => r.outcome === 'new' || r.outcome === 'update');
      const saved = new Map();
      for (const r of apply.sort((a, b) => (a.outcome === 'new' ? -1 : 1) - (b.outcome === 'new' ? -1 : 1))) {
        const { lineManagerStaffNo, ...fields } = r.record;
        // eslint-disable-next-line no-await-in-loop
        const existing = r.existing ? await Staff.findById(r.existing._id).session(session) : null;
        // eslint-disable-next-line no-await-in-loop
        const s = await staffSvc.saveStaff(req, existing, r.staffNo, fields, { mobile: r.mobile, status: r.status, salary: r.salary ? { ...r.salary, effectiveFrom: localMidnight(r.salary.effectiveFrom) } : null }, { session, source: `upload ${imp.fileName}` });
        saved.set(r.staffNo, { staff: s, lineManagerStaffNo });
      }
      // Line managers last, so a manager added in the same file can be linked.
      for (const { staff, lineManagerStaffNo } of saved.values()) {
        if (lineManagerStaffNo) {
          // eslint-disable-next-line no-await-in-loop
          const lm = await Staff.findOne({ staffNo: lineManagerStaffNo }).select('_id').session(session);
          // eslint-disable-next-line no-await-in-loop
          if (lm) await Staff.updateOne({ _id: staff._id }, { $set: { lineManagerId: lm._id } }, { session });
        }
      }
      const out = { created: apply.filter((r) => r.outcome === 'new').length, updated: apply.filter((r) => r.outcome === 'update').length, skipped: fresh.length - apply.length };
      imp.status = 'committed';
      imp.committedAt = new Date();
      imp.committedBy = req.auth.user._id;
      imp.result = out;
      imp.rows = fresh.map((r) => ({ rowNo: r.rowNo, raw: r.raw, staffNo: r.staffNo, name: r.name, outcome: r.outcome, problems: r.problems, changes: r.changes }));
      imp.summary = importSvc.summarise(fresh);
      await imp.save({ session });
      await audit.record({ req, action: 'staff.import_commit', description: `Staff upload applied: ${imp.fileName} (${out.created} new, ${out.updated} updated, ${out.skipped} skipped)`, entity: 'StaffImport', entityId: String(imp._id), after: out }, { session });
      return out;
    });
    res.json({ success: true, data: { ...importView(imp), result } });
  },

  async discardImport(req, res) {
    const imp = await StaffImport.findOneAndUpdate({ _id: req.params.id, status: 'previewed' }, { $set: { status: 'discarded' } }, { new: true });
    if (!imp) throw conflict('This upload is no longer open.', 'IMPORT_CLOSED');
    await audit.record({ req, action: 'staff.import_discard', description: `Staff upload discarded: ${imp.fileName}`, entity: 'StaffImport', entityId: String(imp._id) });
    res.json({ success: true, data: importView(imp) });
  },
};

module.exports = StaffController;

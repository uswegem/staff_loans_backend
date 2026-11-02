'use strict';

// Reports (BRD 12: RP-01 to RP-07, RP-10). Each report is built once as
// { columns, rows } and the same object feeds the screen and every export, so the
// limited-details rule (FR-55) applied here holds everywhere (prompt 4).
//
// FR-55 for reports (DECISIONS D-71): a viewer whose review access is Credit Analyst
// only sees, for applications on the management, CEO and Head of P&C routes, the
// reference, applicant name, status and dates; terms, product, staff number,
// department, category, comments and agreements are withheld. When such a viewer
// filters by product, department, branch or category, those applications are left
// out altogether, so a filter cannot reveal a hidden field.

const Application = require('../../models/Application');
const Agreement = require('../../models/Agreement');
const Decision = require('../../models/Decision');
const Staff = require('../../models/Staff');
const User = require('../../models/User');
const Role = require('../../models/Role');
const RoleAssignment = require('../../models/RoleAssignment');
const ProductVersion = require('../../models/ProductVersion');
const Product = require('../../models/Product');
const AuditLog = require('../../models/AuditLog');
const Settings = require('../../models/Settings');
const workflow = require('../workflow/workflowService');
const calendar = require('../calendar/calendarService');
const workingTime = require('../calendar/workingTime');
const { STAGES } = require('../workflow/routes');
const { fullName, stageName } = require('../review/reviewView');
const { STATUS, PENDING_STAGE } = require('../../constants/statuses');
const { permById, requiresMfa } = require('../../constants/permissions');
const { localDay, localMidnight, OFFSET_MIN } = require('../../utils/dates');
const { forbidden, notFound } = require('../../utils/errors');

const DAY = 24 * 3600 * 1000;
const SCREEN_ROWS = 500;
const EXPORT_ROWS = 50000;
const LIMITED = 'Limited details';
const NOT_LIMITED_BY = ['disb.confirm', 'staff.manage', 'audit.view'];

const day = (d) => (d ? localDay(d) : '');
const dateTime = (d) => (d ? new Date(new Date(d).getTime() + OFFSET_MIN * 60000).toISOString().slice(0, 16).replace('T', ' ') : '');
const col = (label, type = 'text') => ({ label, type });

// ---------- who is looking ----------

async function viewerOf(req) {
  const perms = await workflow.reviewPermissions(req.auth);
  const creditOnly = perms.has('review.credit') && !NOT_LIMITED_BY.some((p) => perms.has(p));
  return { userId: String(req.auth.user._id), perms, creditOnly };
}

const limitedFor = (viewer, app) => viewer.creditOnly && String(app.applicantUserId) !== viewer.userId && workflow.isLimited(app, viewer.perms);

// ---------- loading applications with filters ----------

/**
 * filters: { from, to, productId, department, station, category, status }.
 * dateField: which date the range applies to.
 */
async function loadApps(viewer, f, { dateField = 'submittedAt', extra = {} } = {}) {
  const q = { cycle: { $gt: 0 }, ...extra };
  if (f.from || f.to) q[dateField] = { ...(f.from && { $gte: localMidnight(f.from) }), ...(f.to && { $lt: new Date(localMidnight(f.to).getTime() + DAY) }) };
  if (f.productId) q.productId = f.productId;
  if (f.status) q.status = f.status;
  let apps = await Application.find(q).sort({ submittedAt: -1 }).lean();

  const staffIds = [...new Set(apps.map((a) => String(a.applicantStaffId)))];
  const staff = new Map((await Staff.find({ _id: { $in: staffIds } }).lean()).map((s) => [String(s._id), s]));
  const staffOf = (a) => staff.get(String(a.applicantStaffId)) || {};
  if (f.department) apps = apps.filter((a) => staffOf(a).department === f.department);
  if (f.station) apps = apps.filter((a) => staffOf(a).station === f.station);
  if (f.category) apps = apps.filter((a) => staffOf(a).category === f.category);

  const filteredByHidden = !!(f.productId || f.department || f.station || f.category);
  let excluded = 0;
  if (viewer.creditOnly && filteredByHidden) {
    const before = apps.length;
    apps = apps.filter((a) => !limitedFor(viewer, a));
    excluded = before - apps.length;
  }
  const versions = new Map((await ProductVersion.find({ _id: { $in: apps.map((a) => a.productVersionId) } }).select('name').lean()).map((v) => [String(v._id), v.name]));
  return { apps, staffOf, productOf: (a) => versions.get(String(a.productVersionId)) || '', excluded };
}

// ---------- RP-01 application register ----------

async function register(viewer, f) {
  const settings = await Settings.get();
  const { apps, staffOf, productOf, excluded } = await loadApps(viewer, f);
  let limitedCount = 0;
  const now = Date.now();
  const rows = apps.map((a) => {
    const s = staffOf(a);
    const outside = a.status === 'pending_disbursement' && a.stageEnteredAt && now - a.stageEnteredAt >= settings.approvalSlaDays * DAY ? 'Yes' : '';
    const common = [STATUS[a.status], a.currentStage ? stageName(a.currentStage) : '', day(a.submittedAt), Math.floor((now - new Date(a.submittedAt)) / DAY), outside];
    if (limitedFor(viewer, a)) {
      limitedCount += 1;
      return [a.ref, '', fullName(s), '', '', '', LIMITED, '', '', ...common];
    }
    return [a.ref, s.staffNo, fullName(s), s.department || '', s.station || '', s.category || '', productOf(a), a.approved?.amount || a.amount, a.approved?.tenor || a.tenor, ...common];
  });
  return {
    columns: [col('Reference'), col('Staff number'), col('Applicant'), col('Department'), col('Branch'), col('Category'), col('Product'), col('Amount', 'money'), col('Tenor', 'number'), col('Status'), col('Stage'), col('Submitted', 'date'), col('Age (days)', 'number'), col('Outside SLA')],
    rows,
    limitedCount,
    excluded,
  };
}

// ---------- decisions per application, with the time each stage took ----------

async function stageDecisions(apps) {
  const decisions = await Decision.find({ applicationId: { $in: apps.map((a) => a._id) } }).sort({ at: 1 }).lean();
  const byApp = new Map();
  decisions.forEach((d) => {
    const k = String(d.applicationId);
    if (!byApp.has(k)) byApp.set(k, []);
    byApp.get(k).push(d);
  });
  const out = [];
  byApp.forEach((list) => {
    list.forEach((d, i) => {
      if (d.stage && i > 0) out.push({ ...d, enteredAt: list[i - 1].at });
    });
  });
  return out;
}

async function names(ids) {
  const users = await User.find({ _id: { $in: [...new Set(ids.filter(Boolean).map(String))] } }).select('staffId').lean();
  const staff = new Map((await Staff.find({ _id: { $in: users.map((u) => u.staffId) } }).lean()).map((s) => [String(s._id), s]));
  return new Map(users.map((u) => [String(u._id), fullName(staff.get(String(u.staffId)))]));
}

const inRange = (at, f) => (!f.from || at >= localMidnight(f.from)) && (!f.to || at < new Date(localMidnight(f.to).getTime() + DAY));

// ---------- RP-02 turnaround by stage and approver ----------

async function turnaround(viewer, f) {
  const { apps } = await loadApps(viewer, { ...f, from: undefined, to: undefined });
  const cal = await calendar.load();
  const rows = (await stageDecisions(apps)).filter((d) => inRange(d.at, f));
  const who = await names(rows.map((d) => d.actorId));
  const groups = new Map();
  rows.forEach((d) => {
    const key = `${d.stage}|${d.actorId}`;
    if (!groups.has(key)) groups.set(key, { stage: d.stage, actor: who.get(String(d.actorId)) || '', hours: [] });
    groups.get(key).hours.push(workingTime.workingHoursBetween(cal, d.enteredAt, d.at));
  });
  const order = Object.keys(STAGES);
  const target = (stage) => (STAGES[stage]?.target === 'ceo' ? cal.ceoTargetHours : cal.stageTargetHours);
  const out = [...groups.values()]
    .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || a.actor.localeCompare(b.actor))
    .map((g) => [stageName(g.stage), g.actor, g.hours.length, round1(avg(g.hours)), round1(Math.max(...g.hours)), target(g.stage), g.hours.filter((h) => h > target(g.stage)).length]);
  return { columns: [col('Stage'), col('Approver'), col('Decisions', 'number'), col('Average (working hours)', 'number'), col('Longest (working hours)', 'number'), col('Target (working hours)', 'number'), col('Over target', 'number')], rows: out };
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const round1 = (x) => Math.round(x * 10) / 10;

// ---------- RP-03 approvals, rejections and returns ----------

const DECISION_LABEL = { approve: 'Approved', return: 'Returned', reject: 'Rejected' };

async function decisions(viewer, f) {
  const { apps, staffOf } = await loadApps(viewer, { ...f, from: undefined, to: undefined });
  const byId = new Map(apps.map((a) => [String(a._id), a]));
  const rows = (await stageDecisions(apps)).filter((d) => inRange(d.at, f)).sort((a, b) => b.at - a.at);
  const who = await names(rows.flatMap((d) => [d.actorId, d.onBehalfOfId]));
  let limitedCount = 0;
  const out = rows.map((d) => {
    const a = byId.get(String(d.applicationId));
    const lim = limitedFor(viewer, a);
    if (lim) limitedCount += 1;
    const comment = lim && String(d.actorId) !== viewer.userId ? LIMITED : d.comment || '';
    return [a.ref, fullName(staffOf(a)), stageName(d.stage), DECISION_LABEL[d.action] || d.action, who.get(String(d.actorId)) || '', d.onBehalfOfId ? who.get(String(d.onBehalfOfId)) || '' : '', dateTime(d.at), comment];
  });
  return { columns: [col('Reference'), col('Applicant'), col('Stage'), col('Decision'), col('By'), col('On behalf of'), col('When', 'datetime'), col('Comment')], rows: out, limitedCount };
}

// ---------- RP-04 disbursed loans register (FR-26) ----------

async function disbursed(viewer, f) {
  const { apps, staffOf, productOf, excluded } = await loadApps(viewer, f, { dateField: 'disbursement.date', extra: { status: 'disbursed' } });
  apps.sort((a, b) => b.disbursement.date - a.disbursement.date);
  const ags = new Map((await Agreement.find({ _id: { $in: apps.map((a) => a.currentAgreementId) } }).select('number terms').lean()).map((g) => [String(g._id), g]));
  let limitedCount = 0;
  const rows = apps.map((a) => {
    const s = staffOf(a);
    const g = ags.get(String(a.currentAgreementId)) || { terms: {} };
    if (limitedFor(viewer, a)) {
      limitedCount += 1;
      return [a.ref, '', fullName(s), '', LIMITED, '', '', '', '', '', '', '', day(a.disbursement.date), '', ''];
    }
    return [
      a.ref, s.staffNo, fullName(s), s.department || '', productOf(a), a.approved.amount, g.terms.processingFee || 0, g.terms.insuranceFee || 0, a.approved.instalment, a.approved.tenor,
      'Salary deduction', // the only repayment method (D-84)
      a.schedule?.[0]?.due || '', day(a.disbursement.date), a.disbursement.transactionRef || '', g.number || '',
    ];
  });
  return {
    columns: [col('Reference'), col('Staff number'), col('Staff'), col('Department'), col('Product'), col('Amount', 'money'), col('Processing fee', 'money'), col('Insurance', 'money'), col('Instalment', 'money'), col('Tenor', 'number'), col('Repayment method'), col('First due date', 'date'), col('Disbursed', 'date'), col('Transaction ref'), col('Agreement')],
    rows,
    limitedCount,
    excluded,
  };
}

// ---------- RP-05 approved and disbursed by product, branch or category ----------

const GROUPS = { product: 'Product', branch: 'Branch', category: 'Category' };

async function summary(viewer, f) {
  const by = GROUPS[f.groupBy] ? f.groupBy : 'product';
  const { apps, staffOf, productOf } = await loadApps(viewer, f, { dateField: 'finalApprovedAt', extra: { status: { $in: ['pending_disbursement', 'disbursed'] } } });
  const visible = apps.filter((a) => !limitedFor(viewer, a));
  const keyOf = (a) => (by === 'product' ? productOf(a) : by === 'branch' ? staffOf(a).station || '—' : staffOf(a).category || '—');
  const groups = new Map();
  visible.forEach((a) => {
    const k = keyOf(a);
    if (!groups.has(k)) groups.set(k, [k, 0, 0, 0, 0]);
    const g = groups.get(k);
    g[1] += 1;
    g[2] += a.approved?.amount || 0;
    if (a.status === 'disbursed') {
      g[3] += 1;
      g[4] += a.approved?.amount || 0;
    }
  });
  const rows = [...groups.values()].sort((a, b) => b[2] - a[2]);
  if (rows.length) rows.push(['Total', ...[1, 2, 3, 4].map((i) => rows.reduce((s, r) => s + r[i], 0))]);
  return {
    columns: [col(GROUPS[by]), col('Approved', 'number'), col('Approved amount', 'money'), col('Disbursed', 'number'), col('Disbursed amount', 'money')],
    rows,
    excluded: apps.length - visible.length,
    groupBy: by,
  };
}

// ---------- RP-06 agreement register (FR-41) ----------

const AGREEMENT_STATUS = { signed: 'Signed, awaiting approval', in_force: 'In force', void: 'Void' };

async function agreements(viewer, f) {
  const { apps, staffOf } = await loadApps(viewer, { ...f, from: undefined, to: undefined });
  const visible = apps.filter((a) => !limitedFor(viewer, a));
  const byId = new Map(visible.map((a) => [String(a._id), a]));
  const list = (await Agreement.find({ applicationId: { $in: visible.map((a) => a._id) } }).select('-text -schedule').sort({ number: -1 }).lean()).filter((g) => inRange(g.acceptance?.at || g.createdAt, f));
  const rows = list.map((g) => {
    const a = byId.get(String(g.applicationId));
    return [g.number, a.ref, fullName(staffOf(a)), g.kind === 'revised' ? 'Revised' : 'Original', g.terms?.amount, g.terms?.tenor, g.templateVersion, dateTime(g.acceptance?.at), g.status === 'void' ? `Void: ${g.voidReason || ''}` : AGREEMENT_STATUS[g.status], dateTime(g.effectiveAt), g.textSha256];
  });
  return {
    columns: [col('Agreement'), col('Reference'), col('Staff'), col('Kind'), col('Amount', 'money'), col('Tenor', 'number'), col('Template'), col('Signed', 'datetime'), col('Status'), col('In force from', 'datetime'), col('Fingerprint (SHA-256)')],
    rows,
    excluded: apps.length - visible.length,
  };
}

// ---------- RP-07 users, roles and permissions (access review) ----------

async function access() {
  const [assignments, users] = await Promise.all([RoleAssignment.find().sort({ assignedAt: 1 }).lean(), User.find().select('staffNo staffId status').lean()]);
  const roles = new Map((await Role.find().lean()).map((r) => [String(r._id), r]));
  const staff = new Map((await Staff.find({ _id: { $in: users.map((u) => u.staffId) } }).select('firstName lastName title').lean()).map((s) => [String(s._id), s]));
  const today = localMidnight(localDay());
  const isActive = (x) => !x.revokedAt && (!x.endsOn || x.endsOn >= today);
  const activePerms = new Map();
  assignments.filter(isActive).forEach((x) => {
    const r = roles.get(String(x.roleId));
    if (!r?.active) return;
    const k = String(x.userId);
    if (!activePerms.has(k)) activePerms.set(k, new Set());
    r.permissions.forEach((p) => activePerms.get(k).add(p));
  });
  const byUser = new Map(users.map((u) => [String(u._id), u]));
  const rows = assignments
    .map((x) => {
      const u = byUser.get(String(x.userId));
      const r = roles.get(String(x.roleId));
      if (!u || !r) return null;
      const s = staff.get(String(u.staffId)) || {};
      const status = x.revokedAt ? `Removed ${day(x.revokedAt)}` : !isActive(x) ? 'Ended' : !r.active ? 'Role inactive' : u.status !== 'active' ? `User ${u.status}` : 'Active';
      return [u.staffNo, fullName(s), s.title || '', r.name, status, x.endsOn ? day(x.endsOn) : '', day(x.assignedAt), r.permissions.map((p) => permById(p)?.label || p).join('; '), requiresMfa([...(activePerms.get(String(u._id)) || [])]) ? 'Yes' : 'No'];
    })
    .filter(Boolean)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[3].localeCompare(b[3]));
  return { columns: [col('Staff number'), col('Name'), col('Title'), col('Role'), col('Status'), col('Ends', 'date'), col('Assigned', 'date'), col('Permissions from this role'), col('MFA required')], rows };
}

// ---------- RP-10 audit log extract ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function auditExtract(viewer, f, { max }) {
  const q = {};
  if (f.from || f.to) q.at = { ...(f.from && { $gte: localMidnight(f.from) }), ...(f.to && { $lt: new Date(localMidnight(f.to).getTime() + DAY) }) };
  if (f.action) q.action = new RegExp(`^${escapeRe(f.action)}`);
  if (f.q) {
    const re = new RegExp(escapeRe(f.q), 'i');
    q.$or = [{ description: re }, { action: re }, { actorStaffNo: re }, { appRef: re }];
  }
  const [total, items] = await Promise.all([AuditLog.countDocuments(q), AuditLog.find(q).sort({ at: -1 }).limit(max).lean()]);
  return {
    columns: [col('When', 'datetime'), col('Staff number'), col('Action'), col('Description'), col('Reference'), col('IP address'), col('Result')],
    rows: items.map((e) => [dateTime(e.at), e.actorStaffNo || '', e.action, e.description, e.appRef || '', e.ip || '', e.status]),
    total,
  };
}

// ---------- catalogue ----------

const REPORTS = {
  register: { id: 'RP-01', name: 'Application register', view: ['reports.view'], build: register, filters: ['dates', 'product', 'department', 'branch', 'category', 'status'] },
  turnaround: { id: 'RP-02', name: 'Turnaround by stage and approver', view: ['reports.view'], build: turnaround, filters: ['dates', 'product', 'department', 'branch', 'category'] },
  decisions: { id: 'RP-03', name: 'Approvals, returns and rejections', view: ['reports.view'], build: decisions, filters: ['dates', 'product', 'department', 'branch', 'category'] },
  disbursed: { id: 'RP-04', name: 'Disbursed loans register', view: ['reports.view', 'disb.confirm'], export: ['reports.export', 'disb.confirm'], build: disbursed, filters: ['dates', 'product', 'department', 'branch', 'category'] },
  summary: { id: 'RP-05', name: 'Report Filter', view: ['reports.view'], build: summary, filters: ['dates', 'groupBy', 'product', 'department', 'branch', 'category'] },
  agreements: { id: 'RP-06', name: 'Agreement register', view: ['reports.view'], build: agreements, filters: ['dates', 'product', 'department', 'branch', 'category'] },
  access: { id: 'RP-07', name: 'Users, roles and permissions', view: ['admin.users', 'admin.roles', 'audit.view'], export: ['admin.users', 'admin.roles', 'audit.view'], build: access, filters: [] },
  audit: { id: 'RP-10', name: 'Audit log extract', view: ['audit.view'], export: ['audit.view'], build: auditExtract, filters: ['dates', 'q', 'action'] },
};

const holds = (req, perms) => perms.some((p) => req.auth.permissions.has(p));

/** Reports this user may open, for the tabs. */
function catalogue(req) {
  return Object.entries(REPORTS)
    .filter(([, r]) => holds(req, r.view))
    .map(([key, r]) => ({ key, id: r.id, name: r.name, filters: r.filters, canExport: holds(req, r.export || ['reports.export']) }));
}

const FILTER_LABELS = { from: 'From', to: 'To', status: 'Status', department: 'Department', station: 'Branch', category: 'Category', groupBy: 'Grouped by', q: 'Search', action: 'Action' };

async function build(req, key, f = {}, { forExport = false } = {}) {
  const def = REPORTS[key];
  if (!def) throw notFound('Report not found.');
  if (!holds(req, def.view)) throw forbidden('You cannot open this report.');
  if (forExport && !holds(req, def.export || ['reports.export'])) throw forbidden('You need the permission to export reports.');
  const viewer = await viewerOf(req);
  const max = forExport ? EXPORT_ROWS : SCREEN_ROWS;
  const out = await def.build(viewer, f, { max });
  const total = out.total ?? out.rows.length;
  const product = f.productId ? (await filterOptions()).products.find((p) => p.id === String(f.productId))?.name : null;
  const filters = Object.fromEntries(Object.entries(FILTER_LABELS).map(([k, label]) => [label, f[k] ? String(f[k]) : null]).filter(([, v]) => v));
  if (product) filters.Product = product;
  return {
    key,
    id: def.id,
    name: def.name,
    columns: out.columns,
    rows: out.rows.slice(0, max),
    total,
    truncated: total > max,
    limitedCount: out.limitedCount || 0,
    excluded: out.excluded || 0,
    filters,
    generatedAt: new Date(),
  };
}

// ---------- overview dashboard ----------

async function overview(req) {
  const viewer = await viewerOf(req);
  const [settings, cal] = await Promise.all([Settings.get(), calendar.load()]);
  const open = await Application.find({ status: { $in: PENDING_STAGE } }).select('stageDueAt').lean();
  const now = new Date();
  const pending = await Application.find({ status: 'pending_disbursement' }).select('stageEnteredAt').lean();
  const { apps, productOf } = await loadApps(viewer, {});
  const visible = apps.filter((a) => !limitedFor(viewer, a));
  const disbursedApps = visible.filter((a) => a.status === 'disbursed');

  const since = new Date(now.getTime() - 90 * DAY);
  const recent = (await stageDecisions(apps)).filter((d) => d.at >= since);
  const stages = ['credit', 'pcm', 'hr', 'ceo'].map((k) => {
    const hours = recent.filter((d) => d.stage === k).map((d) => workingTime.workingHoursBetween(cal, d.enteredAt, d.at));
    return { stage: k, label: stageName(k), average: round1(avg(hours)), decisions: hours.length, target: STAGES[k].target === 'ceo' ? cal.ceoTargetHours : cal.stageTargetHours };
  });
  const byProduct = new Map();
  disbursedApps.forEach((a) => {
    const k = productOf(a);
    byProduct.set(k, (byProduct.get(k) || 0) + (a.approved?.amount || 0));
  });
  return {
    inReview: open.length,
    overdue: open.filter((a) => a.stageDueAt && a.stageDueAt < now).length,
    pendingDisbursement: pending.length,
    outsideSla: pending.filter((a) => now - a.stageEnteredAt >= settings.approvalSlaDays * DAY).length,
    disbursedCount: disbursedApps.length,
    disbursedAmount: disbursedApps.reduce((s, a) => s + (a.approved?.amount || 0), 0),
    stages,
    stagesSince: day(since),
    disbursedByProduct: [...byProduct.entries()].map(([product, amount]) => ({ product, amount })).sort((a, b) => b.amount - a.amount),
    limitedExcluded: apps.length - visible.length,
  };
}

/** Values for the filter drop-downs. */
async function filterOptions() {
  const [products, departments, stations] = await Promise.all([
    Product.find().select('code').lean(),
    Staff.distinct('department'),
    Staff.distinct('station'),
  ]);
  const versions = await ProductVersion.find({ productId: { $in: products.map((p) => p._id) } }).sort({ createdAt: -1 }).select('productId name').lean();
  const nameOf = (id) => versions.find((v) => String(v.productId) === String(id))?.name;
  return {
    products: products.map((p) => ({ id: String(p._id), name: nameOf(p._id) || p.code })).sort((a, b) => a.name.localeCompare(b.name)),
    departments: departments.filter(Boolean).sort(),
    branches: stations.filter(Boolean).sort(),
    categories: ['Management', 'Non-management'],
    statuses: Object.entries(STATUS).filter(([k]) => k !== 'draft').map(([value, label]) => ({ value, label })),
  };
}

module.exports = { build, catalogue, overview, filterOptions, REPORTS, viewerOf, limitedFor };

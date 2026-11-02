'use strict';

// Reports and exports (BRD 12: RP-01 to RP-07, RP-10; prompt 4: the limited-details
// rule applies to every report and export).

const XLSX = require('xlsx');
const { api, seedAll, signIn } = require('../flows');
const { seedSampleApplications } = require('../fixtures/applications');
const Application = require('../../src/models/Application');
const AuditLog = require('../../src/models/AuditLog');
const { csvCell } = require('../../src/services/reports/exporters');
const { request, app, authed } = require('../helpers');

jest.setTimeout(120000);

let seeded;
beforeEach(async () => {
  seeded = await seedAll();
  await seedSampleApplications(seeded);
});

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const download = (token, url) => request(app()).get(`/api/v1${url}`).set(authed(token)).buffer(true).parse(binary);

// The management sample on a limited route: Daniel Mrema's Home Equity request.
const DANIEL = { ref: 'SL-2026-00028', amount: 35000000, purpose: 'Construction of family home', product: 'Housing / Education Loan', staffNo: 'LFB0067' };
const REPORT_KEYS = ['register', 'turnaround', 'decisions', 'disbursed', 'summary', 'agreements'];

describe('catalogue and access', () => {
  it('lists only the reports each person may open', async () => {
    const keys = async (staffNo) => (await api((await signIn(staffNo)).token).get('/reports')).body.data?.reports.map((r) => r.key);
    expect(await keys('LFB0051')).toEqual(['register', 'turnaround', 'decisions', 'disbursed', 'summary', 'agreements']);
    expect(await keys('LFB0274')).toEqual(['register', 'turnaround', 'decisions', 'disbursed', 'summary', 'agreements', 'access', 'audit']);
    expect(await keys('LFB0318')).toEqual(['register', 'turnaround', 'decisions', 'disbursed', 'summary', 'agreements']);
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).get('/reports')).status).toBe(403);
    expect((await api(neema.token).get('/reports/register')).status).toBe(403);
  });

  it('exports need reports.export; the system administrator can view but not export loan reports', async () => {
    const peter = await signIn('LFB0274');
    expect((await api(peter.token).get('/reports/register')).status).toBe(200);
    const res = await api(peter.token).get('/reports/register/export/csv');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('You need the permission to export reports.');
    expect((await download(peter.token, '/reports/access/export/csv')).status).toBe(200);
  });
});

describe('RP-01 application register', () => {
  it('shows status, stage, age and Outside SLA, with filters', async () => {
    const grace = await signIn('LFB0051');
    const r = await api(grace.token).get('/reports/register');
    expect(r.body.data.columns.map((c) => c.label)).toEqual(['Reference', 'Staff number', 'Applicant', 'Department', 'Branch', 'Category', 'Product', 'Amount', 'Tenor', 'Status', 'Stage', 'Submitted', 'Age (days)', 'Outside SLA']);
    expect(r.body.data.total).toBe(12);
    const daniel = r.body.data.rows.find((x) => x[0] === DANIEL.ref);
    expect(daniel).toEqual(expect.arrayContaining([DANIEL.staffNo, 'Daniel Mrema', DANIEL.product, DANIEL.amount, 'Pending Credit Review', 'Credit Analyst']));

    const mgmt = await api(grace.token).get('/reports/register?category=Management');
    expect(mgmt.body.data.rows.every((x) => x[5] === 'Management')).toBe(true);
    expect(mgmt.body.data.filters).toEqual({ Category: 'Management' });
    const disbursed = await api(grace.token).get('/reports/register?status=disbursed');
    expect(disbursed.body.data.rows.map((x) => x[0])).toEqual(['SL-2026-00015']);
    expect((await api(grace.token).get('/reports/register?from=2026-13-01')).status).toBe(400);
  });
});

describe('FR-55 in every report and export', () => {
  const hidden = (text) => {
    expect(text).not.toContain(DANIEL.purpose);
    expect(text).not.toContain(DANIEL.product);
    expect(text).not.toContain(String(DANIEL.amount));
    expect(text).not.toContain(DANIEL.amount.toLocaleString('en-US'));
    expect(text).not.toContain(DANIEL.staffNo);
  };

  it('the Credit Analyst sees name only for limited applications, on screen and in CSV, Excel and PDF', async () => {
    const juma = await signIn('LFB0233');
    const reg = await api(juma.token).get('/reports/register');
    const row = reg.body.data.rows.find((x) => x[0] === DANIEL.ref);
    expect(row.slice(0, 9)).toEqual([DANIEL.ref, '', 'Daniel Mrema', '', '', '', 'Limited details', '', '']);
    expect(reg.body.data.limitedCount).toBeGreaterThanOrEqual(1);

    for (const key of REPORT_KEYS) {
      // eslint-disable-next-line no-await-in-loop
      const screen = await api(juma.token).get(`/reports/${key}`);
      const rows = screen.body.data.rows.filter((x) => x.includes(DANIEL.ref) || x.includes('Daniel Mrema'));
      hidden(JSON.stringify(rows));
      // eslint-disable-next-line no-await-in-loop
      const csv = await download(juma.token, `/reports/${key}/export/csv`);
      expect(csv.status).toBe(200);
      const lines = csv.body.toString('utf8').split('\r\n').filter((l) => l.includes(DANIEL.ref) || l.includes('Daniel Mrema'));
      hidden(lines.join('\n'));
      // eslint-disable-next-line no-await-in-loop
      const xlsx = await download(juma.token, `/reports/${key}/export/xlsx`);
      const sheet = XLSX.read(xlsx.body).Sheets[XLSX.read(xlsx.body).SheetNames[0]];
      const xrows = XLSX.utils.sheet_to_json(sheet, { header: 1 }).filter((r) => r.includes(DANIEL.ref) || r.includes('Daniel Mrema'));
      hidden(JSON.stringify(xrows));
    }
    const pdf = await download(juma.token, '/reports/register/export/pdf');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('a filter on a hidden field leaves limited applications out instead of revealing them', async () => {
    const juma = await signIn('LFB0233');
    const he = (await Application.findOne({ ref: DANIEL.ref })).productId;
    const r = await api(juma.token).get(`/reports/register?productId=${he}`);
    expect(r.body.data.rows.map((x) => x[0])).not.toContain(DANIEL.ref);
    expect(r.body.data.excluded).toBeGreaterThanOrEqual(1);
    const cat = await api(juma.token).get('/reports/register?category=Management');
    expect(cat.body.data.rows.map((x) => x[0])).not.toContain(DANIEL.ref);
  });

  it('comments by others on limited applications are withheld in RP-03', async () => {
    const juma = await signIn('LFB0233');
    const r = await api(juma.token).get('/reports/decisions');
    // SL-2026-00025 is the CEO's own application (CEO route, limited); Juma approved its credit stage.
    const ceoApp = r.body.data.rows.filter((x) => x[0] === 'SL-2026-00025');
    expect(ceoApp.length).toBeGreaterThan(0);
    expect(ceoApp.every((x) => x[1] === 'Joseph Mwakalinga')).toBe(true);
    const grace = await signIn('LFB0051');
    const full = (await api(grace.token).get('/reports/decisions')).body.data.rows.filter((x) => x[0] === 'SL-2026-00025');
    expect(full[0][7]).toBe('Credit bureau clear.');
  });
});

describe('RP-02 to RP-07 and RP-10', () => {
  it('RP-02 turnaround per stage and approver in working hours', async () => {
    const r = await api((await signIn('LFB0051')).token).get('/reports/turnaround');
    expect(r.body.data.columns.map((c) => c.label)).toEqual(['Stage', 'Approver', 'Decisions', 'Average (working hours)', 'Longest (working hours)', 'Target (working hours)', 'Over target']);
    const credit = r.body.data.rows.find((x) => x[0] === 'Credit Analyst' && x[1] === 'Juma Kassim');
    expect(credit[2]).toBeGreaterThanOrEqual(5);
    expect(credit[5]).toBe(8);
    expect(r.body.data.rows.find((x) => x[0] === 'CEO')[5]).toBe(48);
  });

  it('RP-04 disbursed register, RP-05 summary and RP-06 agreement register', async () => {
    const grace = await signIn('LFB0051');
    const d = await api(grace.token).get('/reports/disbursed');
    expect(d.body.data.rows).toHaveLength(1);
    expect(d.body.data.rows[0]).toEqual(expect.arrayContaining(['SL-2026-00015', 'LFB0412', 'Neema Mushi', 'Salary Advance', 500000, 'FT26223XK9']));

    const s = await api(grace.token).get('/reports/summary?groupBy=product');
    expect(s.body.data.columns[0].label).toBe('Product');
    const sa = s.body.data.rows.find((x) => x[0] === 'Salary Advance');
    expect(sa).toEqual(['Salary Advance', 2, 1300000, 1, 500000]);
    expect(s.body.data.rows.at(-1)[0]).toBe('Total');
    expect((await api(grace.token).get('/reports/summary?groupBy=category')).body.data.columns[0].label).toBe('Category');

    const a = await api(grace.token).get('/reports/agreements');
    expect(a.body.data.rows.length).toBeGreaterThanOrEqual(12);
    expect(a.body.data.rows.find((x) => x[1] === 'SL-2026-00015')[8]).toBe('In force');
    expect(a.body.data.rows[0][10]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('RP-07 access review lists every assignment with MFA', async () => {
    const r = await api((await signIn('LFB0274')).token).get('/reports/access');
    const juma = r.body.data.rows.filter((x) => x[0] === 'LFB0233');
    expect(juma.map((x) => x[3]).sort()).toEqual(['Credit Analyst', 'Staff']);
    expect(juma.every((x) => x[8] === 'Yes' && x[4] === 'Active')).toBe(true);
    expect(r.body.data.rows.find((x) => x[0] === 'LFB0412')[8]).toBe('No');
  });

  it('RP-10 audit extract with filters; exports are themselves audited', async () => {
    const peter = await signIn('LFB0274');
    const r = await api(peter.token).get('/reports/audit?action=auth.login');
    expect(r.body.data.rows.length).toBeGreaterThan(0);
    expect(r.body.data.rows.every((x) => x[2] === 'auth.login')).toBe(true);
    const x = await download(peter.token, '/reports/audit/export/xlsx');
    expect(x.status).toBe(200);
    const book = XLSX.read(x.body);
    expect(book.SheetNames).toEqual(['Audit log extract', 'About']);
    expect(await AuditLog.countDocuments({ action: 'report.export', entityId: 'audit' })).toBe(1);
  });
});

describe('exports are safe and consistent', () => {
  it('neutralises spreadsheet formulas but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('the CSV carries the same rows as the screen', async () => {
    const grace = await signIn('LFB0051');
    const screen = await api(grace.token).get('/reports/register');
    const csv = await download(grace.token, '/reports/register/export/csv');
    const lines = csv.body.toString('utf8').slice(1).split('\r\n');
    expect(lines).toHaveLength(screen.body.data.rows.length + 1);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="register-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('overview figures for the dashboard', async () => {
    const r = await api((await signIn('LFB0002')).token).get('/reports/overview');
    expect(r.body.data).toMatchObject({ pendingDisbursement: 1, disbursedCount: 1, disbursedAmount: 500000 });
    expect(r.body.data.inReview).toBeGreaterThanOrEqual(7);
    expect(r.body.data.stages.map((s) => s.label)).toEqual(['Credit Analyst', 'P&C Manager', 'Head of HR', 'CEO']);
  });
});

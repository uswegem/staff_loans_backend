'use strict';

// The agreement PDF (FR-37) and the repayment schedule PDF (D-110), laid out by pdfLayout:
// the LFB letterhead and logo, Source Sans 3, numbered clauses with hanging indents, the
// Loan Details as a two-column table, declarations shown ticked with the time they were
// accepted, the data protection notice (D-108) and a signature and acceptance page. Every
// word the PDF adds around the agreement is in the agreement's language (D-109).
//
// The agreement text is printed from the blocks stored with it. Agreements signed before
// blocks were stored print from their canonical text (textBlocks); the schedule table of
// an agreement signed before D-110 prints as it was signed.

const { Layout, WIDTH, BODY, LEADING, COLOR, wrap } = require('./pdfLayout');
const brand = require('./brandAssets');
const sw = require('./swahili');
const en = require('./english');
const { localDay } = require('../../utils/dates');

const plain = (parts) => parts.map((p) => p.text).join('');

/** D-109: the words the PDF adds, in the agreement's language. */
const PDF_TEXT = {
  sw: {
    agreement: 'Mkataba', application: 'Maombi', header: 'Mkataba wa Mkopo wa Mwajiriwa', scheduleHeader: 'Jedwali la Marejesho',
    signatures: 'Sahihi na ushahidi wa kukubali', forBank: 'Kwa niaba ya Benki', employee: 'Mwajiriwa',
    awaiting: 'Inasubiri idhini ya mwisho ya Benki. Idhini zitakazorekodiwa kwenye Mfumo zitasimama kama saini ya Benki.',
    approvedBy: (a) => `${a.name}${a.title ? `, ${a.title}` : ''}${a.onBehalfOf ? ` (kwa niaba ya ${a.onBehalfOf})` : ''}: ${a.stage}, ${a.when}`,
    name: 'Jina', staffNo: 'Namba ya mfanyakazi', signedAt: 'Saini ya kielektroniki', ip: 'Anwani ya IP',
    record: 'Kumbukumbu za mkataba', number: 'Namba ya mkataba', template: 'Toleo la mkataba', fingerprint: 'Alama ya maandishi (SHA-256)', inForce: 'Unaanza kutumika',
    verify: 'Mkataba huu ulisainiwa kielektroniki katika Mfumo wa Mikopo ya Wafanyakazi. Uhalali wa maandishi yake unathibitishwa kwa kukokotoa upya alama ya SHA-256 iliyo hapo juu kutoka kwenye nakala iliyohifadhiwa katika Mfumo.',
    ticked: (when) => `Kauli zote zimewekwa alama na Mwajiriwa tarehe ${when}.`,
    consents: 'Idhini', consentsValue: 'Taarifa ni sahihi; makato; ofisi za kumbukumbu za mikopo; SMS',
    at: (d, t) => `${d}, saa ${t} EAT`,
    // schedule
    scheduleTitle: 'JEDWALI LA MAREJESHO', staff: 'Mwajiriwa', amount: 'Kiasi cha mkopo', rate: 'Riba', period: 'Muda', firstDue: 'Awamu ya kwanza',
    months: (n) => `miezi ${n}`, perYear: (r) => `${r} kwa mwaka, kwa salio linalopungua`,
    head: ['Na.', 'Tarehe', 'Awamu', 'Mtaji', 'Riba', 'Salio'], total: 'Jumla',
    scheduleNote: 'Jedwali hili limetolewa kwa ombi. Halibadilishi masharti ya mkataba.',
    date: sw.dateSw,
  },
  en: {
    agreement: 'Agreement', application: 'Application', header: 'Staff Loan Agreement', scheduleHeader: 'Repayment Schedule',
    signatures: 'Signatures and acceptance', forBank: 'For the Bank', employee: 'The Employee',
    awaiting: "Awaiting the Bank's final approval. The approvals recorded in the System stand as the Bank's signature.",
    approvedBy: (a) => `${a.name}${a.title ? `, ${a.title}` : ''}${a.onBehalfOf ? ` (on behalf of ${a.onBehalfOf})` : ''}: ${a.stage}, ${a.when}`,
    name: 'Name', staffNo: 'Staff number', signedAt: 'Electronic signature', ip: 'IP address',
    record: 'Agreement record', number: 'Agreement number', template: 'Template version', fingerprint: 'Text fingerprint (SHA-256)', inForce: 'In force from',
    verify: 'This Agreement was signed electronically in the Staff Loans System. Its text can be verified by recomputing the SHA-256 fingerprint above from the copy held in the System.',
    ticked: (when) => `All declarations ticked by the Employee on ${when}.`,
    consents: 'Consents', consentsValue: 'Information is correct; deductions; credit reference bureaus; SMS',
    at: (d, t) => `${d}, ${t} EAT`,
    scheduleTitle: 'REPAYMENT SCHEDULE', staff: 'Employee', amount: 'Loan amount', rate: 'Interest rate', period: 'Period', firstDue: 'First instalment',
    months: (n) => `${n} months`, perYear: (r) => `${r} per annum, on the reducing balance`,
    head: ['No.', 'Due date', 'Instalment', 'Principal', 'Interest', 'Balance'], total: 'Total',
    scheduleNote: 'This schedule is given on request. It does not change the terms of the agreement.',
    date: en.dateEn,
  },
};
const pdfText = (language) => PDF_TEXT[language === 'en' ? 'en' : 'sw'];

const timeEat = (at) => new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Africa/Dar_es_Salaam', hour: '2-digit', minute: '2-digit', hour12: false });
const when = (L, at) => L.at(L.date(localDay(new Date(at))), timeEat(at));
const money = (n) => Math.round(n).toLocaleString('en-US');

// Columns (points from the left margin): the number sits in its own column and wrapped lines
// align with the clause text; sub-clauses one level further in.
const COL = { num: 0, text: 30, subNum: 30, subText: 54, bullet0: 8, bulletText0: 20, bullet1: 38, bulletText1: 50 };

function addBlocks(lay, blocks, { language, acceptedAt }) {
  const L = pdfText(language);
  const f = lay.fonts;
  const lastDeclaration = blocks.map((b) => b.type).lastIndexOf('declaration');
  blocks.forEach((b, i) => {
    if (b.type === 'h1') {
      lay.add({ lines: lay.textLines(b.parts, { size: 15, bold: true, center: true, leading: 20 }), after: 2, keepWithNext: true });
    } else if (b.type === 'note') {
      lay.add({ lines: lay.textLines(b.parts, { size: 8.5, center: true, color: COLOR.muted, leading: 11.5 }), after: 6 });
    } else if (b.type === 'h2') {
      const lines = b.number
        ? lay.textLines(b.parts, { size: 11, bold: true, x: COL.text, color: COLOR.heading, leading: 15, first: (page, y, base) => page.drawText(b.number, { x: lay.margin + COL.num, y: base, size: 11, font: f.bold, color: COLOR.heading }) })
        : lay.textLines(b.parts, { size: 11, bold: true, color: COLOR.heading, leading: 15 });
      lay.add({ lines, before: 10, after: 3, keepWithNext: true });
    } else if (b.type === 'clause' || b.type === 'sub') {
      const sub = b.type === 'sub';
      const lines = lay.textLines(b.parts, {
        x: sub ? COL.subText : COL.text,
        leading: LEADING,
        first: (page, y, base) => page.drawText(b.number, { x: lay.margin + (sub ? COL.subNum : COL.num), y: base, size: BODY, font: sub ? f.regular : f.semibold, color: COLOR.ink }),
      });
      lay.add({ lines, before: sub ? 1 : 4 });
    } else if (b.type === 'p') {
      lay.add({ lines: lay.textLines(b.parts, { leading: LEADING }), before: 4 });
    } else if (b.type === 'ul' || b.type === 'ol') {
      const level = b.level || 0;
      b.items.forEach((it, k) => {
        const mark = b.type === 'ol' ? `${k + 1}.` : '•';
        const bx = level ? COL.bullet1 : COL.bullet0;
        lay.add({ lines: lay.textLines(it, { x: level ? COL.bulletText1 : COL.bulletText0, leading: LEADING, first: (page, y, base) => page.drawText(mark, { x: lay.margin + bx, y: base, size: BODY, font: f.regular, color: COLOR.ink }) }), before: 2 });
      });
    } else if (b.type === 'details') {
      lay.add({ lines: detailRows(lay, b.rows), before: 6, after: 4, rows: true });
    } else if (b.type === 'declaration') {
      // Printed ticked: the PDF is made only once every declaration was ticked.
      const lines = lay.textLines(b.parts, { x: 18, leading: LEADING, first: (page, y, base) => tickBox(page, lay.margin, base) });
      lay.add({ lines, before: 4 });
      if (i === lastDeclaration && acceptedAt) lay.add({ lines: lay.textLines([{ text: L.ticked(when(L, acceptedAt)) }], { size: 9, color: COLOR.muted, leading: 12 }), before: 4 });
    } else if (b.type === 'table') {
      addTable(lay, b.head, b.rows, [0.1, 0.22, 0.17, 0.17, 0.15, 0.19], { size: 8 });
    }
  });
}

function tickBox(page, x, base) {
  const s = 8.5;
  const y = base - 1;
  page.drawRectangle({ x, y, width: s, height: s, borderWidth: 0.8, borderColor: COLOR.ink });
  page.drawLine({ start: { x: x + 1.8, y: y + 4.3 }, end: { x: x + 3.6, y: y + 2 }, thickness: 1.2, color: COLOR.ink });
  page.drawLine({ start: { x: x + 3.6, y: y + 2 }, end: { x: x + 7, y: y + 7 }, thickness: 1.2, color: COLOR.ink });
}

/** The Loan Details: label | value, with light shading on alternate rows. */
function detailRows(lay, rows, { size = BODY, leading = LEADING, padY = 6 } = {}) {
  const labelW = WIDTH * 0.32;
  const pad = 5;
  return rows.map((r, i) => {
    // Labels in semibold, measured in the font they are drawn in.
    const label = wrap(r.label.map((x) => ({ ...x, semibold: true, strong: false })), lay.fonts, size, labelW - pad * 2);
    const value = wrap(r.value, lay.fonts, size, WIDTH - labelW - pad * 2);
    const n = Math.max(label.length, value.length);
    const h = n * leading + padY;
    return {
      h,
      draw: (page, yTop) => {
        if (i % 2 === 0) page.drawRectangle({ x: lay.margin, y: yTop - h, width: WIDTH, height: h, color: COLOR.shade });
        page.drawLine({ start: { x: lay.margin, y: yTop - h }, end: { x: lay.margin + WIDTH, y: yTop - h }, thickness: 0.4, color: COLOR.line });
        const put = (lines, x, font) => lines.forEach((segs, k) => {
          const base = yTop - padY / 2 - (k + 1) * leading + (leading - size) / 2 + size * 0.22;
          segs.forEach((s) => page.drawText(s.text, { x: x + s.dx, y: base, size, font: font || s.font, color: COLOR.ink }));
        });
        put(label, lay.margin + pad);
        put(value, lay.margin + labelW + pad);
      },
    };
  });
}

/** A table with its header repeated on each page, right-aligned money and an optional totals row. */
function addTable(lay, head, rows, widths, { size = 8.5, total, alignLeft = [0, 1] } = {}) {
  const rowH = size + 6;
  const line = (cells, { bold = false, shade = false, rule = false } = {}) => ({
    h: rowH,
    draw: (page, yTop) => {
      if (shade) page.drawRectangle({ x: lay.margin, y: yTop - rowH, width: WIDTH, height: rowH, color: COLOR.shade });
      if (rule) page.drawLine({ start: { x: lay.margin, y: yTop - rowH }, end: { x: lay.margin + WIDTH, y: yTop - rowH }, thickness: 0.6, color: COLOR.ink });
      let x = lay.margin;
      cells.forEach((c, i) => {
        const font = bold ? lay.fonts.bold : lay.fonts.regular;
        const t = String(c ?? '');
        const w = widths[i] * WIDTH;
        const tx = alignLeft.includes(i) ? x + 3 : x + w - font.widthOfTextAtSize(t, size) - 3;
        page.drawText(t, { x: tx, y: yTop - rowH + 4, size, font, color: COLOR.ink });
        x += w;
      });
    },
  });
  const header = [line(head, { bold: true, shade: true, rule: true })];
  const body = rows.map((r) => line(r));
  if (total) body.push(line(total, { bold: true, shade: true }));
  lay.add({ lines: [...header, ...body], header, before: 6, after: 6, rows: true });
}

function addDataProtection(lay, dp) {
  if (!dp) return;
  lay.add({ lines: lay.textLines([{ text: dp.title }], { size: 11, bold: true, color: COLOR.heading, leading: 15 }), before: 12, after: 3, keepWithNext: true });
  lay.add({ lines: lay.textLines([{ text: dp.body }], { leading: LEADING }), before: 2 });
  lay.add({ lines: lay.textLines([{ text: dp.accepted }], { x: 18, leading: LEADING, first: (page, y, base) => tickBox(page, lay.margin, base) }), before: 4 });
}

/** The signature and acceptance page, in the agreement's language only. */
function addSignatures(lay, a, L) {
  const kv = (k, v) => lay.add({ lines: lay.textLines([{ text: `${k}: `, semibold: true }, { text: v }], { x: COL.text, leading: LEADING }), before: 2 });
  const sub = (t) => lay.add({ lines: lay.textLines([{ text: t }], { bold: true, leading: LEADING }), before: 10, keepWithNext: true });
  lay.add({ pageBreak: true, lines: [] });
  lay.add({ lines: lay.textLines([{ text: L.signatures }], { size: 11, bold: true, color: COLOR.heading, leading: 15 }), after: 2, keepWithNext: true });
  sub(L.forBank);
  if (a.approvals?.length) a.approvals.forEach((ap) => lay.add({ lines: lay.textLines([{ text: L.approvedBy({ ...ap, when: when(L, ap.at) }) }], { x: COL.text, leading: LEADING }), before: 2 }));
  else lay.add({ lines: lay.textLines([{ text: L.awaiting }], { x: COL.text, leading: LEADING }), before: 2 });
  sub(L.employee);
  kv(L.name, a.acceptance.fullName);
  kv(L.staffNo, a.acceptance.staffNo);
  kv(L.signedAt, when(L, a.acceptance.at));
  if (a.acceptance.ip) kv(L.ip, a.acceptance.ip);
  if (a.consents) kv(L.consents, L.consentsValue);
  sub(L.record);
  kv(L.number, a.agreementNumber);
  kv(L.application, a.ref);
  kv(L.template, a.templateVersion);
  if (a.inForceAt) kv(L.inForce, when(L, a.inForceAt));
  lay.add({ lines: lay.textLines([{ text: `${L.fingerprint}:`, semibold: true }], { x: COL.text, leading: LEADING }), before: 4 });
  lay.add({ lines: lay.textLines([{ text: a.textSha256 }], { x: COL.text, size: 9, leading: 12 }) });
  lay.add({ lines: lay.textLines([{ text: L.verify }], { size: 9, color: COLOR.muted, leading: 12 }), before: 10 });
}

/**
 * The agreement PDF. a: { blocks, language, agreementNumber, ref, templateVersion, textSha256,
 * acceptance: { fullName, staffNo, at, ip }, approvals?, inForceAt?, dataProtection?, consents? }.
 * The same agreement always lays out the same way (the creation date is the signing time).
 */
async function agreementPdf(a) {
  const language = a.language === 'en' ? 'en' : 'sw';
  const L = pdfText(language);
  const lay = await Layout.create({
    language,
    title: `${L.agreement} ${a.agreementNumber} (${a.ref})`,
    header: L.header,
    footerLeft: `${L.agreement} ${a.agreementNumber} · ${L.application} ${a.ref}`,
    logo: await brand.logoBytes(),
    createdAt: a.inForceAt || a.acceptance?.at,
  });
  addBlocks(lay, a.blocks, { language, acceptedAt: a.acceptance?.at });
  addDataProtection(lay, a.dataProtection);
  addSignatures(lay, a, L);
  lay.flow();
  return lay.save();
}

/**
 * The repayment schedule on request (D-110), for OPS and Credit. s: { language, staff: { name, staffNo },
 * ref, agreementNumber, amount, interestRate, tenor, rows: [{ n, due, payment, principal, interest, balance }] }.
 */
async function schedulePdf(s) {
  const language = s.language === 'en' ? 'en' : 'sw';
  const L = pdfText(language);
  const lay = await Layout.create({
    language,
    title: `${L.scheduleHeader} ${s.ref}`,
    header: L.scheduleHeader,
    footerLeft: `${L.scheduleHeader} · ${L.application} ${s.ref}${s.agreementNumber ? ` · ${L.agreement} ${s.agreementNumber}` : ''}`,
    logo: await brand.logoBytes(),
    createdAt: s.at,
  });
  lay.add({ lines: lay.textLines([{ text: L.scheduleTitle }], { size: 15, bold: true, center: true, leading: 20 }), after: 6 });
  const details = [
    [L.staff, `${s.staff.name}, ${s.staff.staffNo}`],
    [L.application, s.ref],
    ...(s.agreementNumber ? [[L.number, s.agreementNumber]] : []),
    [L.amount, `TZS ${money(s.amount)}`],
    [L.rate, L.perYear(s.interestRate)],
    [L.period, L.months(s.tenor)],
    [L.firstDue, s.rows[0] ? L.date(s.rows[0].due) : '—'],
  ];
  lay.add({ lines: detailRows(lay, details.map(([k, v]) => ({ label: [{ text: k }], value: [{ text: v }] }))), before: 4, after: 8, rows: true });
  const sum = (k) => s.rows.reduce((t, r) => t + (r[k] ?? (k === 'payment' ? r.instalment : 0) ?? 0), 0);
  addTable(
    lay,
    L.head,
    s.rows.map((r) => [String(r.n), L.date(r.due), money(r.payment ?? r.instalment), money(r.principal ?? 0), money(r.interest ?? 0), money(r.balance ?? 0)]),
    [0.08, 0.26, 0.17, 0.17, 0.15, 0.17],
    { total: [L.total, '', money(sum('payment')), money(sum('principal')), money(sum('interest')), ''] }
  );
  lay.add({ lines: lay.textLines([{ text: L.scheduleNote }], { size: 9, color: COLOR.muted, leading: 12 }), before: 6 });
  lay.flow();
  return lay.save();
}

// ---------- Loan Summary (D-112) ----------

const SUMMARY_TEXT = {
  en: {
    title: 'LOAN SUMMARY', header: 'Loan Summary', loan: 'Loan', staff: 'Staff member', terms: 'Approved terms', topUp: 'Top-up', approvals: 'Approval trail', booking: 'Booking', disbursement: 'Disbursement',
    ref: 'Application', agreement: 'Agreement number', product: 'Product', status: 'Status', finalApproval: 'Final approval', by: (d, n) => `${d}, by ${n}`,
    name: 'Full name', staffNo: 'Staff number', title_: 'Title', station: 'Branch or station', mobile: 'Mobile', account: 'Account to credit',
    amount: 'Loan amount', tenor: 'Tenor', months: (n) => `${n} months`, rate: 'Interest rate', rateValue: (r) => `${r} per annum, on the reducing balance`, instalment: 'Monthly instalment',
    totalRepayable: 'Total amount repayable', totalInterest: 'Total interest', firstDue: 'First repayment', lastDue: 'Last repayment', payslipLabel: 'Payslip deduction label',
    clears: 'Loan being cleared', settlement: 'Settlement amount', fees: 'Fees deducted', net: 'Net amount to credit',
    stage: 'Stage', approver: 'Approver', decision: 'Decision', date: 'Date', decisions: { approve: 'Approved', return: 'Returned', reject: 'Rejected' },
    loanAccount: 'Core banking loan account', bookingDate: 'Booking date', bookedBy: 'Booked by', note: 'Note',
    disbDate: 'Disbursement date', transactionRef: 'Transaction reference', comment: 'Comment', confirmedBy: 'Confirmed by',
    notBooked: 'Not booked yet.', notDisbursed: 'Not disbursed yet.', none: '—',
    generated: (u, d) => `Generated by ${u} on ${d}`,
  },
  sw: {
    title: 'MUHTASARI WA MKOPO', header: 'Muhtasari wa Mkopo', loan: 'Mkopo', staff: 'Mwajiriwa', terms: 'Masharti yaliyoidhinishwa', topUp: 'Nyongeza', approvals: 'Mfuatano wa idhini', booking: 'Usajili', disbursement: 'Malipo ya Mkopo',
    ref: 'Maombi', agreement: 'Namba ya mkataba', product: 'Bidhaa', status: 'Hali', finalApproval: 'Idhini ya mwisho', by: (d, n) => `${d}, na ${n}`,
    name: 'Jina kamili', staffNo: 'Namba ya mfanyakazi', title_: 'Cheo', station: 'Tawi au kituo', mobile: 'Simu', account: 'Akaunti ya kuweka fedha',
    amount: 'Kiasi cha mkopo', tenor: 'Muda', months: (n) => `miezi ${n}`, rate: 'Riba', rateValue: (r) => `${r} kwa mwaka, kwa salio linalopungua`, instalment: 'Awamu ya kila mwezi',
    totalRepayable: 'Jumla ya kulipa', totalInterest: 'Jumla ya riba', firstDue: 'Rejesho la kwanza', lastDue: 'Rejesho la mwisho', payslipLabel: 'Jina la makato kwenye hati ya mshahara',
    clears: 'Mkopo unaolipwa', settlement: 'Kiasi cha kumaliza mkopo', fees: 'Ada zinazokatwa', net: 'Kiasi halisi cha kuweka',
    stage: 'Hatua', approver: 'Mwidhinishaji', decision: 'Uamuzi', date: 'Tarehe', decisions: { approve: 'Imeidhinishwa', return: 'Imerudishwa', reject: 'Imekataliwa' },
    loanAccount: 'Akaunti ya mkopo kwenye mfumo mkuu wa benki', bookingDate: 'Tarehe ya usajili', bookedBy: 'Imesajiliwa na', note: 'Maelezo',
    disbDate: 'Tarehe ya malipo', transactionRef: 'Kumbukumbu ya muamala', comment: 'Maoni', confirmedBy: 'Imethibitishwa na',
    notBooked: 'Bado haijasajiliwa.', notDisbursed: 'Bado haijalipwa.', none: '—',
    generated: (u, d) => `Imetolewa na ${u} tarehe ${d}`,
  },
};

/**
 * The Loan Summary for Disbursement (D-112): one page on the letterhead, in the agreement's
 * language. s: { language, ref, agreementNumber, product, statusLabel, finalApproval: { at, by },
 * staff: { name, staffNo, title, station, mobile, account }, terms: { amount, tenor, rate, instalment,
 * totalRepayable, totalInterest, firstDue, lastDue, payslipLabel }, topUp?: { clears, settlement, fees, net },
 * approvals: [{ stage, name, action, at }], booking?, disbursement?, generatedBy, at }.
 * No repayment schedule (on request, D-110), no bureau report, no payslip figures.
 */
async function summaryPdf(s) {
  const language = s.language === 'en' ? 'en' : 'sw';
  const L = pdfText(language);
  const S = SUMMARY_TEXT[language];
  const lay = await Layout.create({
    language,
    title: `${S.header} ${s.ref}`,
    header: S.header,
    footerLeft: S.generated(s.generatedBy, when(L, s.at)),
    logo: await brand.logoBytes(),
    createdAt: s.at,
  });
  const day = (d) => (d ? L.date(typeof d === 'string' ? d : localDay(new Date(d))) : S.none);
  const section = (title) => lay.add({ lines: lay.textLines([{ text: title }], { size: 10.5, bold: true, color: COLOR.heading, leading: 13 }), before: 5, after: 1, keepWithNext: true });
  // Compact rows so the summary stays on one page.
  const rows = (pairs) => lay.add({ lines: detailRows(lay, pairs.map(([k, v]) => ({ label: [{ text: k }], value: [{ text: v == null || v === '' ? S.none : String(v) }] })), { size: 9, leading: 11.5, padY: 3 }), before: 1, after: 1, rows: true });
  const tzs = (n) => (n == null ? S.none : `TZS ${money(n)}`);

  lay.add({ lines: lay.textLines([{ text: S.title }], { size: 15, bold: true, center: true, leading: 20 }), after: 4 });
  section(S.loan);
  rows([
    [S.ref, s.ref],
    [S.agreement, s.agreementNumber],
    [S.product, s.product],
    [S.status, s.statusLabel],
    [S.finalApproval, s.finalApproval?.at ? S.by(when(L, s.finalApproval.at), s.finalApproval.by || S.none) : S.none],
  ]);
  section(S.staff);
  rows([[S.name, s.staff.name], [S.staffNo, s.staff.staffNo], [S.title_, s.staff.title], [S.station, s.staff.station], [S.mobile, s.staff.mobile], [S.account, s.staff.account]]);
  section(S.terms);
  rows([
    [S.amount, tzs(s.terms.amount)],
    [S.tenor, S.months(s.terms.tenor)],
    [S.rate, S.rateValue(s.terms.rate)],
    [S.instalment, tzs(s.terms.instalment)],
    [S.totalRepayable, tzs(s.terms.totalRepayable)],
    [S.totalInterest, tzs(s.terms.totalInterest)],
    [S.firstDue, day(s.terms.firstDue)],
    [S.lastDue, day(s.terms.lastDue)],
    [S.payslipLabel, s.terms.payslipLabel],
  ]);
  if (s.topUp) {
    section(S.topUp);
    rows([[S.clears, s.topUp.clears], [S.settlement, tzs(s.topUp.settlement)], [S.fees, tzs(s.topUp.fees)], [S.net, tzs(s.topUp.net)]]);
  }
  section(S.approvals);
  addTable(lay, [S.stage, S.approver, S.decision, S.date], s.approvals.map((a) => [a.stage, a.name || S.none, S.decisions[a.action] || a.action, when(L, a.at)]), [0.26, 0.3, 0.16, 0.28], { size: 9, alignLeft: [0, 1, 2, 3] });
  section(S.booking);
  if (s.booking) rows([[S.loanAccount, s.booking.loanAccountNumber], [S.bookingDate, day(s.booking.date)], [S.bookedBy, s.booking.by], ...(s.booking.note ? [[S.note, s.booking.note]] : [])]);
  else lay.add({ lines: lay.textLines([{ text: S.notBooked }], { leading: LEADING }) });
  section(S.disbursement);
  if (s.disbursement) rows([[S.disbDate, day(s.disbursement.date)], [S.transactionRef, s.disbursement.transactionRef], [S.comment, s.disbursement.comment], [S.confirmedBy, s.disbursement.by]]);
  else lay.add({ lines: lay.textLines([{ text: S.notDisbursed }], { leading: LEADING }) });
  lay.flow();
  return lay.save();
}

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

/** Rebuilds printable blocks from the canonical text of an agreement stored before blocks were kept. */
function textBlocks(text) {
  const blocks = [];
  const lines = text.split(NL);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes(TAB)) {
      const head = line.split(TAB);
      const rows = [];
      while (lines[i + 1] && lines[i + 1].includes(TAB)) {
        i += 1;
        rows.push(lines[i].split(TAB));
      }
      blocks.push({ type: 'table', head, rows });
    } else if (i === 0) blocks.push({ type: 'h1', parts: [{ text: line }] });
    else if (line.startsWith('[ ] ')) blocks.push({ type: 'declaration', parts: [{ text: line.slice(4) }] });
    else blocks.push({ type: 'p', parts: [{ text: line }] });
  }
  return blocks;
}

module.exports = { agreementPdf, schedulePdf, summaryPdf, textBlocks, pdfText, plain, SUMMARY_TEXT };

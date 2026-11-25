'use strict';

// Builds the agreement for an application's terms (BRD 8 pre-filled fields, FR-33)
// and renders it with the active template. The same function serves the preview the
// staff member reads and the server-side check at signing, so the hashes match only
// when the text is identical (DECISIONS D-11).

const AgreementTemplate = require('../../models/AgreementTemplate');
const { render, sentence } = require('./renderer');
const sw = require('./swahili');
const en = require('./english');
const { badRequest, notFound } = require('../../utils/errors');
const { addressLine } = require('../reference/locationService');

const pct = (bps) => `${Number.parseFloat((bps / 100).toFixed(2))}%`;

const LANGUAGES = ['sw', 'en'];

/**
 * The staff member's full name from the staff record: first, middle and last name, with
 * spacing tidied. The one source for the name in the agreement (parties, Loan Details)
 * and in the acceptance evidence. Empty when the record has no name.
 */
const staffName = (staff) => [staff?.firstName, staff?.middleName, staff?.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');

/** Stops an agreement being prepared or signed for a staff record without a full name. */
function requireStaffName(staff) {
  if (!staff?.firstName?.trim() || !staff?.lastName?.trim()) {
    throw badRequest('Your full name is missing from your staff record, so the agreement cannot be prepared. Ask People and Culture to add your first name and surname before you sign.', undefined, 'NAME_MISSING');
  }
}

/** The name as it opens the agreement, naming the Employee party: in capitals and bold. */
const partyName = (staff) => [{ text: staffName(staff).toUpperCase(), fill: true, strong: true }];

/** The product's own application fields as one line ("Make: Toyota; Year: 2019"), or null. */
function productDetails(product, fields) {
  const shown = (product.fields || [])
    .map((f) => [f, fields?.[f.key]])
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    // Money is grouped (24,500,000); other numbers, such as a year, are printed as entered.
    .map(([f, v]) => `${f.label}: ${f.type === 'money' && Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : String(v).trim()}`);
  return shown.length ? shown.join('; ') : null;
}

/**
 * input: { ref, kind, staff, product (version), quote, amount, tenor, repayment, topUp,
 *          fields? (the product's application fields), agreementNumber?, employerClause?,
 *          employeeClause? }
 * language: 'sw' (default) or 'en', the template's language: every filled value, clause
 * and date is written in it.
 */
function values(input, templateVersion, language = 'sw') {
  return language === 'en' ? enValues(input, templateVersion) : swValues(input, templateVersion);
}

function swValues(input, templateVersion) {
  const { staff, quote: q, amount, tenor, topUp } = input;
  const revised = input.kind === 'revised';
  const v = {
    agreementNumber: input.agreementNumber || 'itatolewa wakati wa kusaini',
    templateVersion,
    ref: input.ref,
    fullName: staffName(staff),
    partyName: partyName(staff),
    staffNo: staff.staffNo,
    // P.O. Box is no longer collected (D-93): only an earlier answer appears here.
    // A missing party detail is null, so the renderer leaves its phrase out ("wa {{poBox}},")
    // rather than printing a dash in the legal text.
    poBox: staff.personal?.poBox || null,
    // D-93: the structured address (house/plot, street, ward, district, region) fills {{residence}}.
    residence: addressLine(staff.personal?.address) || null,
    mobile: staff.personal?.mobile || null,
    productName: input.product.name,
    productDetails: productDetails(input.product, input.fields),
    amount: sw.tshs(amount),
    amountWords: sw.amountInWords(amount),
    tenor: String(tenor),
    instalment: sw.tshs(q.instalment),
    instalmentWords: sw.amountInWords(q.instalment),
    interestRate: pct(q.rates.interestBps),
    processingFee: sw.tshs(q.processingFee),
    processingRate: pct(q.rates.processingFeeBps),
    loanKind: topUp?.on ? 'mkopo wa nyongeza' : 'mkopo mpya',
    insuranceFee: sw.tshs(q.insuranceFee),
    insuranceRate: pct(q.rates.insuranceBps),
    totalInterest: sw.tshs(q.totalInterest),
    totalRepayable: sw.tshs(q.totalRepayable),
    firstDueDate: sw.dateSw(q.firstDueDate),
    repaymentMethod: 'Makato ya mshahara', // salary deduction only (D-84)
  };
  v.requestClause = sentence(
    revised
      ? 'Mkopeshaji ameidhinisha kumkopesha Mwajiriwa {{amount}} ({{amountWords}}) kwa kipindi cha miezi {{tenor}}, utakaolipwa kwa awamu za kila mwezi za {{instalment}} ({{instalmentWords}}), kwa kuzingatia kanuni na masharti yaliyomo.'
      : 'Mwajiriwa ameomba kukopeshwa {{amount}} ({{amountWords}}) kwa kipindi cha miezi {{tenor}}, utakaolipwa kwa awamu za kila mwezi za {{instalment}} ({{instalmentWords}}), kwa kuzingatia kanuni na masharti yaliyomo.',
    v
  );
  v.effectClause = [
    {
      text: revised
        ? 'Mkataba huu uliorekebishwa unachukua nafasi ya mkataba ambao Mwajiriwa alisaini wakati wa kuwasilisha maombi, kwa sababu kiasi au muda ulibadilishwa wakati wa kuidhinisha. Unaanza kutumika mara Mwajiriwa anapoukubali.'
        : 'Mwajiriwa anasaini mkataba huu wakati wa kuwasilisha maombi. Mkataba unaanza kutumika pale tu Mkopeshaji atakapoidhinisha maombi kikamilifu kwa masharti haya. Mkopeshaji akibadilisha kiasi au muda wakati wa kuidhinisha, Mwajiriwa atakubali mkataba uliorekebishwa kabla mkopo haujatolewa. Maombi yakikataliwa au yakiondolewa, mkataba huu unakuwa batili; yakirudishwa kwa marekebisho, Mwajiriwa atasaini mkataba mpya atakapowasilisha upya.',
    },
  ];
  v.employerClause = [{ text: input.employerClause || 'Inasubiri idhini ya mwisho ya Mkopeshaji. Idhini za mfumo zinasimama kama saini kwa niaba ya Mwajiri.' }];
  v.employeeClause = [{ text: input.employeeClause || 'Utasainiwa kielektroniki na Mwajiriwa kwa kuweka alama ya kukubali na nenosiri lake.' }];
  return v;
}

/** English values: the same keys as the Swahili ones, so a template may use any of them. */
function enValues(input, templateVersion) {
  const { staff, quote: q, amount, tenor, topUp } = input;
  const revised = input.kind === 'revised';
  const v = {
    agreementNumber: input.agreementNumber || 'issued at signing',
    templateVersion,
    ref: input.ref,
    fullName: staffName(staff),
    partyName: partyName(staff),
    staffNo: staff.staffNo,
    poBox: staff.personal?.poBox || null,
    residence: addressLine(staff.personal?.address) || null,
    mobile: staff.personal?.mobile || null,
    productName: input.product.name,
    productDetails: productDetails(input.product, input.fields),
    amount: en.tzs(amount),
    amountWords: en.amountInWords(amount),
    tenor: String(tenor),
    instalment: en.tzs(q.instalment),
    instalmentWords: en.amountInWords(q.instalment),
    interestRate: pct(q.rates.interestBps),
    processingFee: en.tzs(q.processingFee),
    processingRate: pct(q.rates.processingFeeBps),
    loanKind: topUp?.on ? 'top-up' : 'new loan',
    insuranceFee: en.tzs(q.insuranceFee),
    insuranceRate: pct(q.rates.insuranceBps),
    totalInterest: en.tzs(q.totalInterest),
    totalRepayable: en.tzs(q.totalRepayable),
    firstDueDate: en.dateEn(q.firstDueDate),
    repaymentMethod: 'Salary deduction', // salary deduction only (D-84)
  };
  v.requestClause = sentence(
    revised
      ? 'The Bank has approved a loan to the Employee of {{amount}} ({{amountWords}}) for {{tenor}} months, repayable by monthly instalments of {{instalment}} ({{instalmentWords}}), on the terms of this Agreement.'
      : 'The Employee has applied for a loan of {{amount}} ({{amountWords}}) for {{tenor}} months, repayable by monthly instalments of {{instalment}} ({{instalmentWords}}), on the terms of this Agreement.',
    v
  );
  v.effectClause = [
    {
      text: revised
        ? 'This revised Agreement replaces the Agreement the Employee signed when applying, because the amount or period was changed at approval. It takes effect when the Employee accepts it.'
        : 'The Employee signs this Agreement when submitting the application. It takes effect only when the Bank fully approves the application on these terms. If the Bank changes the amount or period at approval, the Employee will accept a revised Agreement before the loan is paid out. If the application is rejected or withdrawn, this Agreement is void; if it is returned for correction, the Employee signs a new Agreement on resubmitting.',
    },
  ];
  v.employerClause = [{ text: input.employerClause || "Awaiting the Bank's final approval. The approvals recorded in the System stand as the Bank's signature." }];
  v.employeeClause = [{ text: input.employeeClause || 'To be signed electronically by the Employee by ticking the declarations and accepting in the System.' }];
  return v;
}

function scheduleTable(rows, language = 'sw') {
  const n = (x) => Math.round(x).toLocaleString('en-US');
  const date = language === 'en' ? en.dateEn : sw.dateSw;
  return {
    head: language === 'en' ? ['No.', 'Date', 'Payment', 'Principal', 'Interest', 'Balance'] : ['Awamu', 'Tarehe', 'Malipo', 'Mtaji', 'Riba', 'Salio'],
    rows: rows.map((r) => [String(r.n), date(r.due), n(r.payment), n(r.principal), n(r.interest), n(r.balance)]),
  };
}

/** Renders with a given template (the active one by default). */
async function build(input, { template, session } = {}) {
  requireStaffName(input.staff);
  const t = template || (await AgreementTemplate.active(session));
  if (!t) throw notFound('No agreement template is loaded. An administrator must load one.');
  const language = t.language || 'sw';
  const out = render(t.body, values(input, t.version, language), scheduleTable(input.quote.schedule, language));
  return { ...out, template: { id: String(t._id), version: t.version, sample: t.sample, language } };
}

module.exports = { build, values, scheduleTable, staffName, requireStaffName, LANGUAGES };

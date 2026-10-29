'use strict';

// Builds the agreement for an application's terms (BRD 8 pre-filled fields, FR-33)
// and renders it with the active template. The same function serves the preview the
// staff member reads and the server-side check at signing, so the hashes match only
// when the text is identical (DECISIONS D-11).

const AgreementTemplate = require('../../models/AgreementTemplate');
const { render, sentence } = require('./renderer');
const { amountInWords, tshs, dateSw } = require('./swahili');
const { notFound } = require('../../utils/errors');

const pctSw = (bps) => `${Number.parseFloat((bps / 100).toFixed(2))}%`;

/**
 * input: { ref, kind, staff, product (version), quote, amount, tenor, repayment, topUp,
 *          agreementNumber?, employerClause?, employeeClause? }
 */
function values(input, templateVersion) {
  const { staff, quote: q, amount, tenor, repayment, topUp } = input;
  const revised = input.kind === 'revised';
  const v = {
    agreementNumber: input.agreementNumber || 'itatolewa wakati wa kusaini',
    templateVersion,
    ref: input.ref,
    fullName: [staff.firstName, staff.middleName, staff.lastName].filter(Boolean).join(' '),
    staffNo: staff.staffNo,
    poBox: staff.personal?.poBox || '—',
    residence: staff.personal?.residence || '—',
    mobile: staff.personal?.mobile || '—',
    productName: input.product.name,
    amount: tshs(amount),
    amountWords: amountInWords(amount),
    tenor: String(tenor),
    instalment: tshs(q.instalment),
    instalmentWords: amountInWords(q.instalment),
    interestRate: pctSw(q.rates.interestBps),
    processingFee: tshs(q.processingFee),
    processingRate: pctSw(q.rates.processingFeeBps),
    loanKind: topUp?.on ? 'mkopo wa nyongeza' : 'mkopo mpya',
    insuranceFee: tshs(q.insuranceFee),
    insuranceRate: pctSw(q.rates.insuranceBps),
    totalInterest: tshs(q.totalInterest),
    totalRepayable: tshs(q.totalRepayable),
    firstDueDate: dateSw(q.firstDueDate),
    repaymentMethod:
      repayment.method === 'payroll' ? 'Makato ya mshahara' : `Kukatwa kwenye akaunti ${repayment.accountNo}, ${repayment.bank}, tawi la ${repayment.branch}`,
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

function scheduleTable(rows) {
  const n = (x) => Math.round(x).toLocaleString('en-US');
  return {
    head: ['Awamu', 'Tarehe', 'Malipo', 'Mtaji', 'Riba', 'Salio'],
    rows: rows.map((r) => [String(r.n), dateSw(r.due), n(r.payment), n(r.principal), n(r.interest), n(r.balance)]),
  };
}

/** Renders with a given template (the active one by default). */
async function build(input, { template, session } = {}) {
  const t = template || (await AgreementTemplate.active(session));
  if (!t) throw notFound('No agreement template is loaded. An administrator must load one.');
  const out = render(t.body, values(input, t.version), scheduleTable(input.quote.schedule));
  return { ...out, template: { id: String(t._id), version: t.version, sample: t.sample } };
}

module.exports = { build, values, scheduleTable };

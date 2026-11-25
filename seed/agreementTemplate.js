'use strict';

// Sample Swahili agreement template, seeded from the prototype's key clauses (DECISIONS Q6).
// SAMPLE TEXT: Legal must load the approved Mkataba (clauses 1 to 39) before go-live.
// Clause 3 states six months' service; Legal should revise it for applications made
// during probation (NS-01, DECISIONS D-52).

const AgreementTemplate = require('../src/models/AgreementTemplate');

// 2026.11 (legacy markup, with the schedule) stays in databases that have it; agreements
// signed on it keep their text. 2026.12g is the same sample in the numbered markup (D-110):
// numbers worked out by the renderer, cross-references by label, the Loan Details as a
// table, and no repayment schedule (staff get it on request).
const VERSION = '2026.12g';

const BODY = `# MKATABA WA MKOPO WA MWAJIRIWA
~ Toleo {{templateVersion}}, Maombi {{ref}}
Mkataba huu umeingiwa kati ya Letshego Faidika Bank Limited, S.L.P. 34459, Dar es Salaam (hapa inajulikana kama "Mkopeshaji" na pia "Mwajiri"), na {{partyName}}, namba ya mfanyakazi {{staffNo}} (hapa anajulikana kama "Mwajiriwa").
Mwajiriwa amefanya maombi ya mkopo kwa Mkopeshaji ({{productName}}).
##* MAELEZO YA MKOPO
~ Yametolewa na Mfumo kwa mkopo huu. Maelezo ya Mkopo ni sehemu ya Mkataba huu.
| Mwajiriwa | {{fullName}}, namba ya mfanyakazi {{staffNo}}, wa {{poBox}}, {{residence}}, simu {{mobile}}
| Mkopo | {{productName}}
| Maelezo ya bidhaa | {{productDetails}}
| Kiasi cha mkopo | {{amount}} ({{amountWords}})
| Muda | miezi {{tenor}}
| Riba | {{interestRate}} kwa mwaka kwa salio linalopungua
| Awamu ya kila mwezi | {{instalment}}
| Gharama ya kuchakata mkopo | {{processingFee}} ({{processingRate}} ya {{loanKind}})
| Ada ya bima | {{insuranceFee}} ({{insuranceRate}} kwa mwaka kwa miezi {{tenor}})
| Jumla ya riba | {{totalInterest}}
| Jumla ya kulipa | {{totalRepayable}}
| Awamu ya kwanza | {{firstDueDate}}
| Njia ya marejesho | {{repaymentMethod}}
{{requestClause}}
{{effectClause}}
## {#mkopo} MKOPO
+ {#idhini} Mwajiriwa anakubali kwamba ameomba mkopo kama "Mtaji" ulioonyeshwa kwenye Maelezo ya Mkopo, na kwamba Mkopeshaji ana haki ya kukataa maombi, kuyarudisha kwa marekebisho, au kuidhinisha kiasi pungufu au muda tofauti (ambapo Mwajiriwa atakubali mkataba uliorekebishwa), kwa kuzingatia Sera ya Mikopo ya Wafanyakazi na sheria za Tanzania.
+ Mwajiriwa anakubali kulipa asilimia moja (1%) ya mkopo kama gharama ya kuchakata mkopo mpya, au asilimia sifuri nukta tano (0.5%) kwa mkopo wa nyongeza.
+ Mwajiriwa anathibitisha kwamba ni mwajiriwa anayetekeleza majukumu yake katika tarehe ya mkataba huu, na kwamba ametimiza miezi sita (6) kazini bila kukosa.
## {#marejesho} MAREJESHO
+ {#makato} Mwajiriwa anamruhusu Mwajiri kukata mshahara wake, au Mkopeshaji kukata akaunti yake, kiasi cha malipo ya awamu ya kila mwezi mpaka mtaji, riba na tozo zote zilipwe kikamilifu. Hakuna makato yatakayozuiliwa au kuahirishwa kwa sababu yoyote.
+ Jedwali la marejesho linaloonyesha kila awamu na salio baada yake linapatikana kwa Mfanyakazi akiliomba kutoka Idara ya Uendeshaji au Idara ya Mikopo ya Benki.
+ Kuchelewesha malipo ya awamu kutasababisha riba na ada za malimbikizo, ambazo zitakatwa kwa mujibu wa {{ref:makato}}. Ikiwa kiasi chochote hakijalipwa katika tarehe iliyopangwa, salio lote la mtaji, riba na tozo litalipwa mara moja.
+ Panapokuwa na nia ya kusitisha mkopo mapema, Mwajiriwa atatoa notisi ya siku thelathini (30) na kulipa tozo ya asilimia nane (8%) ya salio la mkopo.
## MASHARTI MENGINE
+ Endapo ajira itasitishwa kwa sababu yoyote, masharti ya mkopo yatakuwa ya kibiashara, na Mkopeshaji atakuwa na haki ya kukata salio kutoka kwenye mafao ya Mwajiriwa yanayoshikiliwa na Mwajiri.
+ Mwajiriwa ameridhia taarifa zake za mkopo kuangaliwa na kuwasilishwa kwenye ofisi za kumbukumbu za mikopo.
+ Mwajiriwa atamtaarifu Mkopeshaji mara moja kwa maandishi endapo taarifa zake za benki au anwani zitabadilika.
+ Mwajiriwa anakubali kwamba mkataba huu umeandikwa kwa lugha anayoielewa, kwamba amepata fursa ya kuusoma, na kwamba kuukubali kwa njia ya kielektroniki kuna nguvu sawa na saini kwa mujibu wa Sheria ya Miamala ya Kielektroniki, 2015.
+ Mkataba huu unaongozwa na sheria za Jamhuri ya Muungano wa Tanzania. Vifungu {{num:mkopo}} na {{num:marejesho}} vinasomwa pamoja na Sera ya Mikopo ya Wafanyakazi.
~ [Maandishi ya mfano: vifungu kamili kama vilivyoidhinishwa na Kitengo cha Sheria vitapakiwa kabla ya kuanza kutumika.]`;

async function seedAgreementTemplate(users = {}) {
  const existing = await AgreementTemplate.findOne({ version: VERSION });
  if (existing) return existing;
  // A database that already has templates keeps them: the sample is only for a new one.
  const any = await AgreementTemplate.findOne().sort({ createdAt: -1 });
  if (any) return any;
  return AgreementTemplate.create({
    version: VERSION,
    status: 'approved', // a fixture: the sample text, approved (D-88)
    body: BODY,
    legalApproved: true,
    legalApprovalRef: 'Prototype clauses (sample)',
    sample: true,
    effectiveFrom: new Date('2026-10-01T00:00:00+03:00'),
    loadedBy: users.LFB0274?._id,
    note: 'Mkopeshaji used for LFB as lender; electronic acceptance clause added. Sample text until Legal loads the approved version.',
  });
}

module.exports = { seedAgreementTemplate, BODY, VERSION };

'use strict';

// Agreement template 2026.11, seeded from the prototype's key clauses (DECISIONS Q6).
// SAMPLE TEXT: Legal must load the approved Mkataba (clauses 1 to 39) before go-live.
// Clause 3 states six months' service; Legal should revise it for applications made
// during probation (NS-01, DECISIONS D-52).

const AgreementTemplate = require('../src/models/AgreementTemplate');

const VERSION = '2026.11';

const BODY = `# MKATABA WA MKOPO WA MWAJIRIWA
~ Namba ya Mkataba {{agreementNumber}}, toleo {{templateVersion}}, Maombi {{ref}}
Mkataba huu umeingiwa kati ya Letshego Faidika Bank Limited, S.L.P. 34459, Dar es Salaam (hapa inajulikana kama "Mkopeshaji" na pia "Mwajiri"), na {{fullName}}, namba ya mfanyakazi {{staffNo}}, wa {{poBox}}, {{residence}}, simu {{mobile}} (hapa anajulikana kama "Mwajiriwa").
## Ambapo
1. Mwajiriwa amefanya maombi ya mkopo kwa Mkopeshaji ({{productName}}).
2. {{requestClause}}
3. {{effectClause}}
## Muhtasari wa mkopo
- Riba: {{interestRate}} kwa mwaka kwa salio linalopungua.
- Gharama ya kuchakata mkopo: {{processingFee}} ({{processingRate}} ya {{loanKind}}).
- Ada ya bima: {{insuranceFee}} ({{insuranceRate}} kwa mwaka kwa miezi {{tenor}}).
- Jumla ya riba: {{totalInterest}}. Jumla ya kulipa: {{totalRepayable}}.
- Awamu ya kwanza: {{firstDueDate}}.
- Njia ya marejesho: {{repaymentMethod}}.
## Kanuni na masharti
1. Mwajiriwa anakubali kwamba ameomba mkopo kama "Mtaji" ulioonyeshwa kwenye Jedwali, na kwamba Mkopeshaji ana haki ya kukataa maombi, kuyarudisha kwa marekebisho, au kuidhinisha kiasi pungufu au muda tofauti (ambapo Mwajiriwa atakubali mkataba uliorekebishwa), kwa kuzingatia Sera ya Mikopo ya Wafanyakazi na sheria za Tanzania.
2. Mwajiriwa anakubali kulipa asilimia moja (1%) ya mkopo kama gharama ya kuchakata mkopo mpya, au asilimia sifuri nukta tano (0.5%) kwa mkopo wa nyongeza.
3. Mwajiriwa anathibitisha kwamba ni mwajiriwa anayetekeleza majukumu yake katika tarehe ya mkataba huu, na kwamba ametimiza miezi sita (6) kazini bila kukosa.
4. Mwajiriwa anamruhusu Mwajiri kukata mshahara wake, au Mkopeshaji kukata akaunti yake, kiasi cha malipo ya awamu ya kila mwezi mpaka mtaji, riba na tozo zote zilipwe kikamilifu. Hakuna makato yatakayozuiliwa au kuahirishwa kwa sababu yoyote.
5. Kuchelewesha malipo ya awamu kutasababisha riba na ada za malimbikizo. Ikiwa kiasi chochote hakijalipwa katika tarehe iliyopangwa, salio lote la mtaji, riba na tozo litalipwa mara moja.
6. Panapokuwa na nia ya kusitisha mkopo mapema, Mwajiriwa atatoa notisi ya siku thelathini (30) na kulipa tozo ya asilimia nane (8%) ya salio la mkopo.
7. Endapo ajira itasitishwa kwa sababu yoyote, masharti ya mkopo yatakuwa ya kibiashara, na Mkopeshaji atakuwa na haki ya kukata salio kutoka kwenye mafao ya Mwajiriwa yanayoshikiliwa na Mwajiri.
8. Mwajiriwa ameridhia taarifa zake za mkopo kuangaliwa na kuwasilishwa kwenye ofisi za kumbukumbu za mikopo.
9. Mwajiriwa atamtaarifu Mkopeshaji mara moja kwa maandishi endapo taarifa zake za benki au anwani zitabadilika.
10. Mwajiriwa anakubali kwamba mkataba huu umeandikwa kwa lugha anayoielewa, kwamba amepata fursa ya kuusoma, na kwamba kuukubali kwa njia ya kielektroniki kuna nguvu sawa na saini kwa mujibu wa Sheria ya Miamala ya Kielektroniki, 2015.
11. Mkataba huu unaongozwa na sheria za Jamhuri ya Muungano wa Tanzania.
~ [Maandishi ya mfano: vifungu kamili 1 hadi 39 kama vilivyoidhinishwa na Kitengo cha Sheria vitapakiwa kabla ya kuanza kutumika.]
## Jedwali la marejesho
{{schedule}}
## Kwa niaba ya Mwajiri
{{employerClause}}
## Mwajiriwa
{{employeeClause}}`;

async function seedAgreementTemplate(users = {}) {
  const existing = await AgreementTemplate.findOne({ version: VERSION });
  if (existing) return existing;
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

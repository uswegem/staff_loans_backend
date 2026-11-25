'use strict';

// D-109: one language at a time. A whole journey in Swahili shows no English message
// (errors, notifications, the agreement PDF), and in English no Swahili. Notifications are
// stored as code and params and rendered in the reader's language when read.

const { pathToFileURL } = require('url');
const { seedAll, attachPayslip, attachCrb, signIn, CRB, HR_OK } = require('../flows');
const { app: server, authed, request } = require('../helpers');
const Agreement = require('../../src/models/Agreement');
const Notification = require('../../src/models/Notification');
const StoredFile = require('../../src/models/StoredFile');
const fileStore = require('../../src/services/files/fileStore');
const i18n = require('../../src/i18n');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(240000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
  i18n.missing.length = 0;
});

/** Requests as a person in a language. */
const as = (person, lang) => {
  const go = (method, url, body) => {
    const r = request(server())[method](`/api/v1${url}`).set(authed(person.token)).set('Accept-Language', lang);
    return body ? r.send(body) : r;
  };
  return { get: (u) => go('get', u), post: (u, b = {}) => go('post', u, b), patch: (u, b) => go('patch', u, b) };
};

async function pdfText(fileId) {
  const lib = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const data = new Uint8Array(await fileStore.read(await StoredFile.findById(fileId)));
  const task = lib.getDocument({ data, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    pages.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(' '));
  }
  await task.destroy();
  return pages.join('\n').replace(/\s+/g, ' ');
}

/** Every message an API response shows people, at any depth. */
function messagesIn(body, out = []) {
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && ['message', 'reason', 'why', 'hint', 'blockedReason', 'bookBlockedReason', 'languageNotice'].includes(k)) out.push(v);
    else if (v && typeof v === 'object') messagesIn(v, out);
  }
  return out;
}

const ENGLISH = /\b(the|your|is|has|was|cannot|before|approved|ready|review|loan)\b/i;
const SWAHILI = /\b(mkopo|ombi|imeidhinishwa|tayari|ukaguzi|lazima|kwenye|kwa hiyo|hati)\b/i;

/** The journey: apply and sign, an error, approvals, a return to Credit, booking, disbursement. */
async function journey(lang) {
  const seen = [];
  const keep = (res) => {
    seen.push(...messagesIn(res.body));
    return res;
  };
  const neema = await signIn('LFB0412');
  const me = as(neema, lang);
  const { id } = keep(await me.post('/applications', { productId: String(products.PL._id) })).body.data;
  keep(await me.patch(`/applications/${id}`, { repaymentMethod: 'payroll', amount: 3000000, tenor: 24, purpose: 'Home repairs' }));
  expect((await attachPayslip(neema, id)).status).toBe(201);
  const preview = keep(await me.get(`/applications/${id}/agreement/preview`)).body.data;
  const body = { consents: { truth: true, deduct: true, crb: true, sms: true }, declarations: preview.blocks.filter((b) => b.type === 'declaration').map(() => true), accepted: true, scrolledToEnd: true, textSha256: preview.textSha256 };
  const refused = keep(await me.post(`/applications/${id}/sign-and-submit`, body));
  expect(refused.body.code).toBe('DATA_PROTECTION_REQUIRED');
  expect(keep(await me.post(`/applications/${id}/sign-and-submit`, { ...body, dataProtection: true })).status).toBe(200);

  const juma = await signIn('LFB0233');
  const grace = await signIn('LFB0051');
  const joseph = await signIn('LFB0002');
  const credit = as(juma, lang);
  keep(await credit.post(`/review/${id}/decision`, { action: 'approve', crb: CRB })); // refused: no bureau file
  await attachCrb(juma, id);
  keep(await credit.post(`/review/${id}/decision`, { action: 'approve', crb: CRB }));
  keep(await as(grace, lang).post(`/review/${id}/decision`, { action: 'approve', hrChecks: HR_OK }));
  keep(await as(joseph, lang).post(`/review/${id}/decision`, { action: 'return', returnTo: 'credit', comment: 'Angalia tena / Check again' }));
  keep(await credit.post(`/review/${id}/decision`, { action: 'approve', crb: CRB }));
  keep(await as(grace, lang).post(`/review/${id}/decision`, { action: 'approve', hrChecks: HR_OK }));
  keep(await as(joseph, lang).post(`/review/${id}/decision`, { action: 'approve' }));

  const upendo = as(await signIn('LFB0129'), lang);
  keep(await upendo.get('/disbursements'));
  keep(await upendo.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN2026000123', date: localDay(new Date(Date.now() + 86400000)) })); // refused: future
  keep(await upendo.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN2026000123', date: localDay() }));
  const halima = as(await signIn('LFB0318'), lang);
  keep(await halima.post(`/disbursements/${id}/confirm`, { date: localDay(), transactionRef: 'FT26294AB12', comment: 'Imelipwa' }));

  // Every notification anyone got, read in the language.
  const people = ['LFB0412', 'LFB0233', 'LFB0051', 'LFB0002', 'LFB0129', 'LFB0318'];
  const notes = [];
  for (const staffNo of people) {
    // eslint-disable-next-line no-await-in-loop
    const res = await as(await signIn(staffNo), lang).get('/notifications');
    notes.push(...res.body.data.items);
  }
  return { id, seen, notes };
}

describe('one language at a time (D-109)', () => {
  it('a whole journey in Swahili: every message, notification and the agreement PDF are Swahili', async () => {
    const { id, seen, notes } = await journey('sw');
    expect(i18n.missing).toEqual([]);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.filter((m) => ENGLISH.test(m))).toEqual([]);
    expect(notes.length).toBeGreaterThan(5);
    // Stored as code and params, rendered in Swahili.
    expect(notes.filter((n) => !n.code)).toEqual([]);
    expect(notes.map((n) => n.text).filter((t) => ENGLISH.test(t.replace(/Angalia tena \/ Check again/, '')))).toEqual([]);
    const ag = await Agreement.findOne({ applicationId: id }).lean();
    expect(ag.language).toBe('sw');
    const text = await pdfText(ag.inForcePdfFileId);
    expect(text).not.toMatch(/Electronic acceptance|Agreement number|Staff member|For the employer|In force from| page \d/);
  });

  it('the same journey in English shows no Swahili message or notification', async () => {
    const { seen, notes } = await journey('en');
    expect(seen.filter((m) => SWAHILI.test(m))).toEqual([]);
    expect(notes.map((n) => n.text).filter((t) => SWAHILI.test(t.replace(/Angalia tena \/ Check again/, '')))).toEqual([]);
  });

  it('a notification is rendered in the language of whoever reads it, from its code', async () => {
    await journey('en');
    const n = await Notification.findOne({ type: 'application.ready_to_book' }).lean();
    expect(n.code).toBe('FINAL_APPROVAL_READY_TO_BOOK');
    expect(n.params).toEqual({ a: expect.stringMatching(/^SL-/) });
    expect(i18n.render(n.code, n.params, 'sw')).toBe(`${n.params.a} imepata idhini ya mwisho. Iko tayari kusajiliwa kwenye mfumo mkuu wa benki.`);
  });
});

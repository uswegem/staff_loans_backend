'use strict';

// The prototype's sample applications land in the right queues and states.

const crypto = require('crypto');
const { api, seedAll, signIn, PASSWORD } = require('../flows');
const { seedSampleApplications } = require('../../seed/applications');
const Application = require('../../src/models/Application');
const Agreement = require('../../src/models/Agreement');

beforeEach(async () => {
  const seeded = await seedAll();
  expect(await seedSampleApplications(seeded)).toBe(11);
});

const refs = (body) => body.data.items.map((i) => i.ref).sort();

it('every reviewer sees the prototype queue', async () => {
  const juma = await signIn('LFB0233');
  const q = await api(juma.token).get('/queue');
  expect(refs(q.body)).toEqual(['SL-2026-00028', 'SL-2026-00030', 'SL-2026-00031']);
  expect(q.body.data.items.find((i) => i.ref === 'SL-2026-00028').limited).toBe(true);
  expect(q.body.data.counts.overdue).toBeGreaterThanOrEqual(1); // SL-2026-00030 was submitted 9.5 working hours ago

  expect(refs((await api((await signIn('LFB0051')).token).get('/queue')).body)).toEqual(['SL-2026-00025', 'SL-2026-00029']);
  expect(refs((await api((await signIn('LFB0129')).token).get('/queue')).body)).toEqual(['SL-2026-00024']);
  expect(refs((await api((await signIn('LFB0002')).token).get('/queue')).body)).toEqual(['SL-2026-00026']);
});

it('seeded agreements carry a valid fingerprint and Neema can accept her revised terms', async () => {
  for (const ag of await Agreement.find()) {
    expect(crypto.createHash('sha256').update(ag.text, 'utf8').digest('hex')).toBe(ag.textSha256);
  }
  const neema = await signIn('LFB0412');
  const id = String((await Application.findOne({ ref: 'SL-2026-00022' }))._id);
  const r = await api(neema.token).get(`/applications/${id}/revised`);
  expect(r.body.data).toMatchObject({ signed: { amount: 5000000 }, approved: { amount: 4500000 } });
  const ok = await api(neema.token).post(`/applications/${id}/accept-revised`, { accepted: true, scrolledToEnd: true, password: PASSWORD, textSha256: r.body.data.textSha256 });
  expect(ok.body.data.status).toBe('pending_disbursement');
});

it('new references continue after the samples', async () => {
  const aisha = await signIn('LFB0451');
  const { body } = await api(aisha.token).post('/applications', { productId: String((await Application.findOne({ ref: 'SL-2026-00031' })).productId) });
  // Aisha already has an open Personal Loan (SL-2026-00031), so BR-08 refuses it.
  expect(body.message).toMatch(/SL-2026-00031/);
  const he = await api(aisha.token).post('/applications', { productId: String((await Application.findOne({ ref: 'SL-2026-00028' })).productId) });
  expect(he.body.data.ref).toMatch(/^SL-\d{4}-00032$/);
});

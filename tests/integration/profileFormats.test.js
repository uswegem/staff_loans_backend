'use strict';

// D-93: phone numbers, NIDA, nationality and the structured address; the location list
// and its server-side check; the upgrade that brings existing records to the formats.
// D-94: Swahili messages and the saved language and theme.

const mongoose = require('mongoose');
const { app, seed, signIn, authed, request } = require('../helpers');
const Staff = require('../../src/models/Staff');
const Settings = require('../../src/models/Settings');
const User = require('../../src/models/User');
const Notification = require('../../src/models/Notification');
const LocationRegion = require('../../src/models/LocationRegion');
const { seedReferenceData } = require('../../seed/referenceData');
const profileFormats = require('../../scripts/profile-formats');
const { seedProducts } = require('../fixtures/products');

const api = (token, lang) => {
  const h = { ...authed(token), ...(lang ? { 'Accept-Language': lang } : {}) };
  return {
    get: (url) => request(app()).get(`/api/v1${url}`).set(h),
    patch: (url, body) => request(app()).patch(`/api/v1${url}`).set(h).send(body),
  };
};

beforeEach(async () => {
  const { users } = await seed();
  await seedProducts(users);
});

describe('location list (copied from MMS)', () => {
  it('is loaded once with every region, district and ward, and loading again adds nothing', async () => {
    const again = await seedReferenceData();
    expect(again).toMatchObject({ regions: 26, loaded: false });
    expect(await LocationRegion.countDocuments()).toBe(26);
    const dodoma = await LocationRegion.findOne({ name: 'Dodoma' }).lean();
    // Names with line breaks in the source are tidied ("Dodoma\nCbd").
    expect(dodoma.districts.map((d) => d.name)).toContain('Dodoma Cbd');
  });

  it('cascades: regions, then the districts of a region, then the wards of a district', async () => {
    const neema = await signIn('LFB0412');
    const r = api(neema.token);
    const regions = await r.get('/reference-data/regions');
    expect(regions.body.data).toContain('Mwanza');
    const districts = await r.get('/reference-data/regions/Mwanza/districts');
    expect(districts.body.data).toEqual(['Ilemela', 'Kwimba', 'Magu', 'Misungwi', 'Nyamagana', 'Sengerema', 'Ukerewe']);
    const wards = await r.get('/reference-data/regions/Mwanza/districts/Nyamagana/wards');
    expect(wards.body.data).toContain('Isamilo');
    expect((await r.get('/reference-data/regions/Atlantis/districts')).status).toBe(404);
    expect((await r.get('/reference-data/regions/Mwanza/districts/Bahi/wards')).status).toBe(404);
    const countries = await r.get('/reference-data/countries');
    expect(countries.body.data.default).toBe('Tanzania');
    expect(countries.body.data.countries).toContain('Kenya');
  });

  it('needs a signed-in user', async () => {
    expect((await request(app()).get('/api/v1/reference-data/regions')).status).toBe(401);
  });
});

describe('personal details formats (D-93)', () => {
  it.each([
    ['0712345678', '+255712345678'],
    ['255712345678', '+255712345678'],
    ['+255712345678', '+255712345678'],
    ['+255 712 345 678', '+255712345678'],
  ])('stores the mobile %s as %s', async (sent, stored) => {
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).patch('/me/profile/personal', { mobile: sent });
    expect(res.status).toBe(200);
    expect(res.body.data.personal.mobile).toBe(stored);
  });

  it.each(['7123456780', '+254712345678', '075473081', '0754 730 81'])('refuses the phone number %s without guessing', async (sent) => {
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).patch('/me/profile/personal', { workPhone: sent });
    expect(res.status).toBe(400);
    expect(res.body.details.workPhone[0]).toBe('Enter nine digits after +255, for example +255 712 345 678.');
  });

  it('work phone stays optional, and next of kin phone is normalised too', async () => {
    const rehema = await signIn('LFB0596');
    const r = api(rehema.token);
    expect((await r.patch('/me/profile/personal', { workPhone: '' })).status).toBe(200);
    const kin = await r.patch('/me/profile/kin', { nextOfKin: [{ firstName: 'Mwanaidi', lastName: 'Ally', relationship: 'Parent', phone: '0715660214', address: 'Dodoma' }] });
    expect(kin.body.data.nextOfKin[0].phone).toBe('+255715660214');
    const bad = await r.patch('/me/profile/kin', { nextOfKin: [{ firstName: 'Mwanaidi', phone: '71566021' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.details['nextOfKin.0.phone'][0]).toMatch(/nine digits after \+255/);
  });

  it('stores NIDA with its hyphens, from digits or a wrongly grouped number', async () => {
    const rehema = await signIn('LFB0596');
    const res = await api(rehema.token).patch('/me/profile/personal', { nida: '19800630-13140-0000420' });
    expect(res.body.data.personal.nida).toBe('19800630-13140-00004-20');
    expect((await Staff.findOne({ staffNo: 'LFB0596' })).personal.nida).toBe('19800630-13140-00004-20');
  });

  it('nationality comes from the country list; earlier "Tanzanian" is taken as Tanzania', async () => {
    const rehema = await signIn('LFB0596');
    const r = api(rehema.token);
    expect((await r.patch('/me/profile/personal', { nationality: 'Tanzanian' })).body.data.personal.nationality).toBe('Tanzania');
    const bad = await r.patch('/me/profile/personal', { nationality: 'Narnia' });
    expect(bad.status).toBe(400);
    expect(bad.body.details.nationality[0]).toBe('Choose a country from the list.');
  });

  it('checks the address against the location list; House/Plot Number is optional', async () => {
    const rehema = await signIn('LFB0596');
    const r = api(rehema.token);
    const wrongWard = await r.patch('/me/profile/personal', { address: { region: 'Dodoma', district: 'Dodoma', ward: 'Isamilo', street: 'Area D' } });
    expect(wrongWard.status).toBe(400);
    expect(wrongWard.body.details['address.ward'][0]).toBe('Choose a ward in Dodoma.');
    const wrongDistrict = await r.patch('/me/profile/personal', { address: { region: 'Dodoma', district: 'Nyamagana' } });
    expect(wrongDistrict.body.details['address.district'][0]).toBe('Choose a district in Dodoma.');
    const ok = await r.patch('/me/profile/personal', { address: { region: 'Dodoma', district: 'Dodoma', ward: 'Ipagala', street: 'Area D', house: '' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.completeness.missing.map((m) => m.key)).not.toEqual(expect.arrayContaining(['personal.address.region', 'personal.address.street', 'personal.address.house']));
  });

  it('P.O. Box and residence are no longer accepted, but earlier answers stay in the database', async () => {
    await Staff.updateOne({ staffNo: 'LFB0596' }, { $set: { 'personal.poBox': 'P.O. Box 1, Dodoma', 'personal.residence': 'Area D, Dodoma' } });
    const rehema = await signIn('LFB0596');
    await api(rehema.token).patch('/me/profile/personal', { maritalStatus: 'Single', poBox: 'changed', residence: 'changed' });
    const s = await Staff.findOne({ staffNo: 'LFB0596' }).lean();
    expect(s.personal).toMatchObject({ poBox: 'P.O. Box 1, Dodoma', residence: 'Area D, Dodoma', maritalStatus: 'Single' });
    const me = await api(rehema.token).get('/me/profile');
    expect(me.body.data.completeness.missing.map((m) => m.key)).toEqual(expect.arrayContaining(['personal.address.region', 'personal.address.district', 'personal.address.ward', 'personal.address.street']));
  });

  it('a stored value in the wrong format counts as missing until it is corrected', async () => {
    await Staff.collection.updateOne({ staffNo: 'LFB0412' }, { $set: { 'personal.mobile': '7123456780' } });
    const neema = await signIn('LFB0412');
    const c = (await api(neema.token).get('/me/profile/completeness')).body.data;
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual([{ key: 'personal.mobile', label: 'Mobile phone', tab: 'personal', invalid: true }]);
  });
});

describe('upgrade: existing records to the D-93 formats', () => {
  it('normalises what is unambiguous, applies a confirmed correction, lists the rest, and runs again safely', async () => {
    const { db } = mongoose.connection;
    await db.collection('staffs').updateOne({ staffNo: 'LFB0412' }, { $set: { 'personal.nida': '19890712-14112-0000421', 'personal.mobile': '0713 448 902', 'personal.nationality': 'Tanzanian' } });
    await db.collection('staffs').updateOne({ staffNo: 'LFB0596' }, { $set: { 'personal.mobile': '7123456780' } });
    await db.collection('staffs').updateOne({ staffNo: 'LFB0377' }, { $set: { 'personal.mobile': '12345' } });
    await Settings.updateOne({ _id: 'global' }, { $set: { mandatoryProfileFields: ['personal.mobile', 'personal.poBox', 'personal.residence'] } });

    const out = await profileFormats.run(db, { fixes: profileFormats.phoneFixes(['--fix-phone', '7123456780=712345678']) });
    expect(out.fixed).toEqual([{ staffNo: 'LFB0596', field: 'Mobile phone', from: '7123456780', to: '+255712345678' }]);
    expect(out.invalid).toEqual([{ staffNo: 'LFB0377', field: 'Mobile phone', value: '12345' }]);
    const neema = await db.collection('staffs').findOne({ staffNo: 'LFB0412' });
    expect(neema.personal).toMatchObject({ nida: '19890712-14112-00004-21', mobile: '+255713448902', nationality: 'Tanzania' });
    expect((await db.collection('staffs').findOne({ staffNo: 'LFB0377' })).personal.mobile).toBe('12345');
    expect((await Settings.findById('global').lean()).mandatoryProfileFields).toEqual(['personal.mobile', 'personal.address.region', 'personal.address.district', 'personal.address.ward', 'personal.address.street']);

    const again = await profileFormats.run(db, { fixes: {} });
    expect(again).toMatchObject({ nida: 0, phones: 0, nationality: 0, settings: false, fixed: [] });
  });

  it('a correction must be a valid number', () => {
    expect(() => profileFormats.phoneFixes(['--fix-phone', '7123456780=7123456780'])).toThrow(/correct number/);
  });
});

describe('Swahili messages and saved preferences (D-94)', () => {
  it('validation and rule messages come back in Swahili when asked for; English stays the default', async () => {
    const rehema = await signIn('LFB0596');
    const en = await api(rehema.token).patch('/me/profile/personal', { mobile: '7123456780' });
    expect(en.body.message).toBe('Check the highlighted fields.');
    const sw = await api(rehema.token, 'sw').patch('/me/profile/personal', { mobile: '7123456780' });
    expect(sw.body.message).toBe('Kagua sehemu zilizoangaziwa.');
    expect(sw.body.details.mobile[0]).toBe('Weka tarakimu tisa baada ya +255, kwa mfano +255 712 345 678.');
    const elig = await api(rehema.token, 'sw').get('/me/eligibility');
    expect(elig.body.data.products[0].reasons[0]).toMatch(/^Utaweza kuomba wasifu wako ukikamilika\. Zinazokosekana: .*Mkoa/);
  });

  it('notifications are shown in the reader\'s language; names and references stay as they are', async () => {
    const rehema = await signIn('LFB0596');
    const user = await User.findOne({ staffNo: 'LFB0596' });
    await Notification.create({ userId: user._id, type: 'x', text: 'SL-2026-00012 from Neema Mushi is waiting for your Credit Analyst review (limited details)' });
    const res = await api(rehema.token, 'sw').get('/notifications');
    expect(res.body.data.items[0].text).toBe('SL-2026-00012 kutoka kwa Neema Mushi linasubiri mapitio yako ya Mchambuzi wa Mikopo (taarifa chache)');
    expect((await Notification.findOne().lean()).text).toMatch(/^SL-2026-00012 from Neema Mushi/);
  });

  it('saves the language and theme on the account, returns them at sign-in, and refuses other values', async () => {
    const neema = await signIn('LFB0412');
    expect(neema.body.data.user.preferences).toEqual({ language: 'en', theme: 'light' });
    const saved = await api(neema.token).patch('/auth/preferences', { language: 'sw', theme: 'dark' });
    expect(saved.body.data.preferences).toEqual({ language: 'sw', theme: 'dark' });
    expect((await api(neema.token).patch('/auth/preferences', { theme: 'system' })).status).toBe(400);
    const again = await signIn('LFB0412');
    expect(again.body.data.user.preferences).toEqual({ language: 'sw', theme: 'dark' });
  });
});

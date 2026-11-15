'use strict';

const XLSX = require('xlsx');
const { app, seed, signIn, authed, PASSWORD, request } = require('../helpers');
const Staff = require('../../src/models/Staff');
const User = require('../../src/models/User');

beforeEach(async () => { await seed(); });

test('username-only sign-in rejects a staff-number payload', async () => {
  const old = await request(app()).post('/api/v1/auth/login').send({ staffNo: 'LFB0412', password: PASSWORD });
  expect(old.status).toBe(400);
  const current = await request(app()).post('/api/v1/auth/login').send({ userName: 'lfb0412', password: PASSWORD });
  expect(current.status).toBe(200);
  expect(current.body.data.user.staffNo).toBe('LFB0412');
  expect(current.body.data.user.userName).toBe('lfb0412');
});

test('basic staff workbook with second-row underscored headers imports without creating a login', async () => {
  const hr = await signIn('LFB0051');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['HR STAFF MASTER EXPORT'],
    ['', 'first_name', 'last_name', 'staff_number', 'gender', 'department', 'title', 'category', 'email', 'user_name'],
    ['', 'Asha', 'Mashauri', 'AT902', 'Female', 'Operations', '', 'Non-management', 'asha@example.test', 'asha.mashauri'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'HR');
  const file = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const preview = await request(app()).post('/api/v1/staff/import').set(authed(hr.token)).attach('file', file, 'staff.xlsx');
  expect(preview.status).toBe(201);
  expect(preview.body.data.summary.new).toBe(1);
  expect(preview.body.data.rows[0].changes.join(' ')).toMatch(/Incomplete HR profile/);
  const committed = await request(app()).post(`/api/v1/staff/import/${preview.body.data.id}/commit`).set(authed(hr.token));
  expect(committed.status).toBe(200);
  const person = await Staff.findOne({ staffNo: 'AT902' });
  expect(person.userName).toBe('asha.mashauri');
  expect(person.department).toBe('Operations');
  expect(person.dateJoined).toBeNull();
  expect(await User.findOne({ staffId: person._id })).toBeNull();
});

test('duplicate staff numbers are rejected in the preview', async () => {
  const hr = await signIn('LFB0051');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['First name', 'Surname', 'Staff Number/Code', 'Username', 'Category'],
    ['Asha', 'Mashauri', 'AT637', 'asha.mashauri', 'Non-management'],
    ['Juma', 'Salum', 'AT637', 'juma.salum', 'Non-management'],
  ]), 'Staff records');
  const file = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const res = await request(app()).post('/api/v1/staff/import').set(authed(hr.token)).attach('file', file, 'duplicate.xlsx');
  expect(res.status).toBe(201);
  expect(res.body.data.summary.error).toBe(1);
  expect(res.body.data.rows[1].problems.join(' ')).toMatch(/repeats row/);
});


test('middle name is retained during staff workbook import', async () => {
  const hr = await signIn('LFB0051');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['First name', 'Middle name', 'Surname', 'Staff Number/Code', 'Username', 'Category'],
    ['Asha', 'Neema', 'Mashauri', 'AT903', 'asha.neema', 'Non-management'],
  ]), 'Staff records');
  const file = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const preview = await request(app()).post('/api/v1/staff/import').set(authed(hr.token)).attach('file', file, 'middle-name.xlsx');
  expect(preview.status).toBe(201);
  expect(preview.body.data.summary.new).toBe(1);
  const committed = await request(app()).post(`/api/v1/staff/import/${preview.body.data.id}/commit`).set(authed(hr.token));
  expect(committed.status).toBe(200);
  const person = await Staff.findOne({ staffNo: 'AT903' });
  expect(person.middleName).toBe('Neema');
  expect(person.fullName).toBe('Asha Neema Mashauri');
});

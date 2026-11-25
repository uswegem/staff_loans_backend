'use strict';

// D-107: after final approval People and Culture (loan.book) book the loan in core banking,
// then OPS (disb.confirm) confirm the disbursement. Both teams see the whole queue and act
// only on their own step; the booker never confirms the same loan's disbursement, and nobody
// books or disburses their own loan.

const { api, seedAll, applyAndSign, decide, signIn, bookLoan, CRB, HR_OK } = require('../flows');
const Application = require('../../src/models/Application');
const Decision = require('../../src/models/Decision');
const Notification = require('../../src/models/Notification');
const AuditLog = require('../../src/models/AuditLog');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');
const User = require('../../src/models/User');
const { sodConflicts } = require('../../src/constants/permissions');
const { DEFAULT_ROLES } = require('../../src/constants/systemRoles');
const { localDay } = require('../../src/utils/dates');

jest.setTimeout(180000);

let products;
beforeEach(async () => {
  ({ products } = await seedAll());
});

const DAY = 24 * 3600 * 1000;
const TERMS = { amount: 4500000, tenor: 36, purpose: 'Home furniture and appliances' };
const userId = async (staffNo) => String((await User.findOne({ staffNo }))._id);

/** Neema's loan through Credit, People and Culture and the CEO. */
async function approved() {
  const id = await applyAndSign(await signIn('LFB0412'), products.PL._id, TERMS);
  await decide(await signIn('LFB0233'), id, { action: 'approve', crb: CRB });
  await decide(await signIn('LFB0051'), id, { action: 'approve', hrChecks: HR_OK });
  expect((await decide(await signIn('LFB0002'), id, { action: 'approve' })).body.data.outcome).toBe('approved');
  return id;
}

describe('booking before disbursement (D-107)', () => {
  it('the system roles: P&C Manager and Head of P&C book; OPS disburses; the two are kept apart', () => {
    const perms = (key) => DEFAULT_ROLES.find((r) => r.code === key).permissions;
    expect(perms('pc_manager')).toContain('loan.book');
    expect(perms('head_pc')).toContain('loan.book');
    expect(perms('ops')).not.toContain('loan.book');
    expect(sodConflicts(['loan.book', 'disb.confirm']).map((r) => r.id)).toContain('sod4');
    expect(sodConflicts(perms('head_pc'))).toEqual([]);
  });

  it('final approval goes to Booking; HR books; OPS disburses', async () => {
    const id = await approved();
    expect(await Application.findById(id)).toMatchObject({ status: 'pending_booking' });
    // People and Culture are told; OPS not yet.
    expect(await Notification.exists({ userId: await userId('LFB0129'), type: 'application.ready_to_book' })).toBeTruthy();
    expect(await Notification.exists({ userId: await userId('LFB0318'), type: 'application.ready_to_disburse' })).toBeFalsy();

    // Both teams see the whole queue; each can act only on its own step.
    const upendo = api((await signIn('LFB0129')).token);
    const halima = api((await signIn('LFB0318')).token);
    const hrQueue = (await upendo.get('/disbursements')).body.data;
    expect(hrQueue).toMatchObject({ tab: 'booking', counts: { booking: 1, ready: 0 }, can: { book: true, confirm: false } });
    expect(hrQueue.items[0]).toMatchObject({ id, canBook: true, canConfirm: false });
    const opsQueue = (await halima.get('/disbursements?tab=booking')).body.data;
    expect(opsQueue.items[0]).toMatchObject({ id, canBook: false, canConfirm: false });
    expect((await halima.get('/disbursements')).body.data.tab).toBe('ready');
    // OPS cannot book, nor disburse before booking.
    expect((await halima.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN1', date: localDay() })).status).toBe(403);
    expect((await halima.post(`/disbursements/${id}/confirm`, { date: localDay(), transactionRef: 'FT1', comment: 'Done.' })).status).toBe(409);

    // Booking checks.
    const tomorrow = localDay(new Date(Date.now() + DAY));
    const yesterday = localDay(new Date(Date.now() - DAY));
    expect((await upendo.post(`/disbursements/${id}/book`, { date: localDay() })).status).toBe(400);
    expect((await upendo.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN2026000123', date: tomorrow })).body.message).toBe('The booking date cannot be in the future.');
    expect((await upendo.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN2026000123', date: yesterday })).body.message).toBe('The booking date cannot be before the final approval.');
    const ok = await upendo.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN2026000123', date: localDay(), note: 'Booked under staff loan product.' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.booking).toMatchObject({ loanAccountNumber: 'LN2026000123', date: localDay(), note: 'Booked under staff loan product.', by: 'Upendo Massawe' });
    const a = await Application.findById(id);
    expect(a.status).toBe('pending_disbursement');
    expect(String(a.booking.bookedBy)).toBe(await userId('LFB0129'));
    expect(await Decision.countDocuments({ applicationId: id, action: 'book' })).toBe(1);
    expect(await AuditLog.exists({ action: 'disbursement.book', description: /booked in core banking: loan account LN2026000123/ })).toBeTruthy();
    expect(await Notification.exists({ userId: await userId('LFB0318'), type: 'application.ready_to_disburse', text: /booked in core banking \(loan account LN2026000123\)/ })).toBeTruthy();
    // Booking twice is refused.
    expect((await upendo.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN2', date: localDay() })).body.code).toBe('ALREADY_BOOKED');

    // OPS sees the booking and disburses.
    const ready = (await halima.get('/disbursements')).body.data.items[0];
    expect(ready).toMatchObject({ id, canConfirm: true, booking: { loanAccountNumber: 'LN2026000123' } });
    const done = await halima.post(`/disbursements/${id}/confirm`, { date: localDay(), transactionRef: 'FT26294AB12', comment: 'Paid to staff account.' });
    expect(done.status).toBe(200);
    expect(await Application.findById(id)).toMatchObject({ status: 'disbursed', booking: { loanAccountNumber: 'LN2026000123' } });
    // The applicant's history shows both steps.
    const history = (await api((await signIn('LFB0412')).token).get(`/applications/${id}`)).body.data.history.map((h) => h.action);
    expect(history).toEqual(expect.arrayContaining(['book', 'disburse']));
  });

  it('the person who booked a loan cannot confirm its disbursement', async () => {
    const id = await approved();
    // A user holding both permissions (a breach of sod4 that the roles screen refuses, set here directly).
    const both = await Role.create({ code: 'both_test', name: 'Both (test)', permissions: ['loan.book', 'disb.confirm'] });
    await RoleAssignment.create({ userId: await userId('LFB0377'), roleId: both._id });
    const salma = api((await signIn('LFB0377')).token);
    expect((await salma.post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN2026000777', date: localDay() })).status).toBe(200);
    const item = (await salma.get('/disbursements?tab=ready')).body.data.items[0];
    expect(item).toMatchObject({ canConfirm: false, blockedReason: 'You booked this loan, so an OPS officer confirms its disbursement.' });
    const res = await salma.post(`/disbursements/${id}/confirm`, { date: localDay(), transactionRef: 'FT1', comment: 'Done.' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_DISBURSE');
  });

  it('nobody books their own loan', async () => {
    // The P&C Manager applies; the route goes through the Head of P&C.
    const upendo = await signIn('LFB0129');
    const id = await applyAndSign(upendo, products.PL._id, TERMS);
    await Application.updateOne({ _id: id }, { $set: { status: 'pending_booking', currentStage: null, stageEnteredAt: new Date(), finalApprovedAt: new Date(), approved: { amount: 4500000, tenor: 36, instalment: 136900 } } });
    const item = (await api(upendo.token).get('/disbursements')).body.data.items.find((i) => i.id === id);
    expect(item).toMatchObject({ canBook: false, bookBlockedReason: 'This is your own loan. Another People and Culture officer books it.' });
    const res = await api(upendo.token).post(`/disbursements/${id}/book`, { loanAccountNumber: 'LN1', date: localDay() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_BOOK');
    // The Head of P&C books it.
    expect((await bookLoan(id, { staffNo: 'LFB0051' })).status).toBe(200);
  });

  it('staff without loan.book or disb.confirm cannot open the queue', async () => {
    const neema = await signIn('LFB0412');
    expect((await api(neema.token).get('/disbursements')).status).toBe(403);
  });
});

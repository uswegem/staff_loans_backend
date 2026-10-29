'use strict';

// Working calendar (BRD 7.3, FR-13): Mon–Fri 08:00–17:00 EAT, less public holidays.

const wt = require('../../src/services/calendar/workingTime');

const cal = { workingDays: [1, 2, 3, 4, 5], dayStartMinutes: 480, dayEndMinutes: 1020, utcOffsetMinutes: 180, holidays: ['2026-12-25', '2026-12-26'] };
const eat = (s) => new Date(`${s}+03:00`);

describe('working hours between two instants', () => {
  it('counts only the working part of one day', () => {
    expect(wt.workingHoursBetween(cal, eat('2026-11-02T07:00:00'), eat('2026-11-02T10:30:00'))).toBe(2.5);
    expect(wt.workingHoursBetween(cal, eat('2026-11-02T16:00:00'), eat('2026-11-02T20:00:00'))).toBe(1);
  });

  it('skips nights and weekends', () => {
    // Fri 16:00 → Mon 10:00 = 1 h Friday + 2 h Monday
    expect(wt.workingHoursBetween(cal, eat('2026-10-30T16:00:00'), eat('2026-11-02T10:00:00'))).toBe(3);
  });

  it('skips public holidays', () => {
    // Thu 24 Dec 16:00 → Mon 28 Dec 09:00: Fri 25 is a holiday, 26–27 weekend → 1 h + 1 h
    expect(wt.workingHoursBetween(cal, eat('2026-12-24T16:00:00'), eat('2026-12-28T09:00:00'))).toBe(2);
  });

  it('returns 0 for reversed or equal instants', () => {
    expect(wt.workingHoursBetween(cal, eat('2026-11-02T12:00:00'), eat('2026-11-02T09:00:00'))).toBe(0);
  });
});

describe('adding working hours (stage due time)', () => {
  it('8-hour stage target from Monday 10:00 ends Tuesday 09:00', () => {
    expect(wt.addWorkingHours(cal, eat('2026-11-02T10:00:00'), 8).toISOString()).toBe(eat('2026-11-03T09:00:00').toISOString());
  });

  it('starts counting at 08:00 when submitted at night', () => {
    expect(wt.addWorkingHours(cal, eat('2026-11-02T22:00:00'), 2).toISOString()).toBe(eat('2026-11-03T10:00:00').toISOString());
  });

  it('carries over the weekend and a holiday', () => {
    // Thu 24 Dec 15:00 + 8 h: 2 h Thu, Fri holiday, weekend, 6 h Mon → Mon 28 Dec 14:00
    expect(wt.addWorkingHours(cal, eat('2026-12-24T15:00:00'), 8).toISOString()).toBe(eat('2026-12-28T14:00:00').toISOString());
  });

  it('48 working hours for the CEO is about five working days and a third', () => {
    const due = wt.addWorkingHours(cal, eat('2026-11-02T08:00:00'), 48);
    expect(due.toISOString()).toBe(eat('2026-11-09T11:00:00').toISOString());
    expect(wt.workingHoursBetween(cal, eat('2026-11-02T08:00:00'), due)).toBe(48);
  });
});

describe('due info', () => {
  it('flags overdue in working hours', () => {
    // Due Mon 16:00 (8 of the 9 working hours); at Tue 10:00 that is 1 h Mon + 2 h Tue overdue.
    const d = wt.dueInfo(cal, eat('2026-11-02T08:00:00'), 8, eat('2026-11-03T10:00:00'));
    expect(d.dueAt.toISOString()).toBe(eat('2026-11-02T16:00:00').toISOString());
    expect(d.overdue).toBe(true);
    expect(d.hoursOverdue).toBe(3);
  });

  it('reports hours left', () => {
    const d = wt.dueInfo(cal, eat('2026-11-02T08:00:00'), 8, eat('2026-11-02T13:00:00'));
    expect(d.overdue).toBe(false);
    expect(d.hoursLeft).toBe(3);
  });
});

describe('local date', () => {
  it('uses East Africa Time for the calendar date', () => {
    expect(wt.localDateUtc(new Date('2026-11-02T22:30:00Z')).toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });
});

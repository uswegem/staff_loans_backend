'use strict';

// Working-hours clock for turnaround targets (BRD 7.3, FR-13, decision 15).
// Pure functions over a calendar:
//   { workingDays: [1..5], dayStartMinutes, dayEndMinutes, utcOffsetMinutes, holidays: ['YYYY-MM-DD'] }
// Exact interval arithmetic per local day (DECISIONS D-19), not 15-minute steps.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Local calendar date at `now`, as a Date at UTC midnight of that date. */
function localDateUtc(now = new Date(), utcOffsetMinutes = 180) {
  const local = new Date(new Date(now).getTime() + utcOffsetMinutes * MIN);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

const isoDay = (d) => d.toISOString().slice(0, 10);

function normalise(cal) {
  return {
    workingDays: new Set(cal.workingDays || [1, 2, 3, 4, 5]),
    start: cal.dayStartMinutes ?? 480,
    end: cal.dayEndMinutes ?? 1020,
    offset: cal.utcOffsetMinutes ?? 180,
    holidays: new Set(cal.holidays || []),
  };
}

/** Working window [from, to) in epoch ms for the local day that begins at dayUtcMidnight, or null. */
function windowFor(c, dayUtcMidnight) {
  const day = new Date(dayUtcMidnight);
  if (!c.workingDays.has(day.getUTCDay()) || c.holidays.has(isoDay(day))) return null;
  const base = dayUtcMidnight - c.offset * MIN;
  return [base + c.start * MIN, base + c.end * MIN];
}

/** Working milliseconds between a and b (0 if b <= a). */
function workingMsBetween(calendar, a, b) {
  const from = new Date(a).getTime();
  const to = new Date(b).getTime();
  if (to <= from) return 0;
  const c = normalise(calendar);
  let total = 0;
  for (let d = localDateUtc(from, c.offset).getTime(); d - c.offset * MIN < to; d += DAY) {
    const w = windowFor(c, d);
    if (w) total += Math.max(0, Math.min(to, w[1]) - Math.max(from, w[0]));
  }
  return total;
}

const workingHoursBetween = (calendar, a, b) => workingMsBetween(calendar, a, b) / HOUR;

/** The instant when `hours` working hours have elapsed after `start`. */
function addWorkingHours(calendar, start, hours) {
  const c = normalise(calendar);
  if (c.workingDays.size === 0 || c.end <= c.start) throw new Error('Calendar has no working time');
  let left = hours * HOUR;
  let cur = new Date(start).getTime();
  if (left <= 0) return new Date(cur);
  for (let d = localDateUtc(cur, c.offset).getTime(), guard = 0; guard < 3660; d += DAY, guard += 1) {
    const w = windowFor(c, d);
    if (w && cur < w[1]) {
      const from = Math.max(cur, w[0]);
      const avail = w[1] - from;
      if (avail >= left) return new Date(from + left);
      left -= avail;
      cur = w[1];
    }
  }
  throw new Error('Working time could not be reached within 10 years');
}

/**
 * Due and overdue info for a stage entered at `enteredAt` with a target in hours.
 * { dueAt, overdue, hoursLeft, hoursOverdue }
 */
function dueInfo(calendar, enteredAt, targetHours, now = new Date()) {
  const dueAt = addWorkingHours(calendar, enteredAt, targetHours);
  const overdue = now.getTime() > dueAt.getTime();
  return overdue
    ? { dueAt, overdue, hoursLeft: 0, hoursOverdue: workingHoursBetween(calendar, dueAt, now) }
    : { dueAt, overdue, hoursLeft: workingHoursBetween(calendar, now, dueAt), hoursOverdue: 0 };
}

module.exports = { localDateUtc, workingMsBetween, workingHoursBetween, addWorkingHours, dueInfo, isoDay };

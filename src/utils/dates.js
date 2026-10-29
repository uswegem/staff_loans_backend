'use strict';

// Calendar dates in East Africa Time (UTC+3, no daylight saving; DECISIONS D-19).

const OFFSET_MIN = 180;

/** 'YYYY-MM-DD' → the instant of local midnight that day. */
function localMidnight(day) {
  return new Date(`${day}T00:00:00+03:00`);
}

/** Local calendar date of an instant, as 'YYYY-MM-DD'. */
function localDay(at = new Date()) {
  return new Date(new Date(at).getTime() + OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/** Adds calendar months to a date, clamping to the month end (31 Jan + 1 month = 28/29 Feb). */
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

module.exports = { localMidnight, localDay, addMonths, OFFSET_MIN };

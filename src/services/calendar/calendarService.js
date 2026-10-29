'use strict';

// Loads the configured working calendar (settings + holidays) for workingTime.

const Settings = require('../../models/Settings');
const Holiday = require('../../models/Holiday');

async function load(session) {
  const [s, holidays] = await Promise.all([Settings.get(session), Holiday.find().session(session || null).lean()]);
  return {
    workingDays: s.workingDays,
    dayStartMinutes: s.dayStartMinutes,
    dayEndMinutes: s.dayEndMinutes,
    utcOffsetMinutes: s.utcOffsetMinutes,
    holidays: holidays.map((h) => h.date),
    stageTargetHours: s.stageTargetHours,
    ceoTargetHours: s.ceoTargetHours,
  };
}

module.exports = { load };

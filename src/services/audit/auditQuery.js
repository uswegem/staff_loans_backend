'use strict';

// Filters shared by the audit log screen and its export (RP-10), so both list the same entries.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "auth.login,security." -> entries whose action starts with any of the comma-separated codes. */
function actionMatch(action) {
  const codes = String(action).split(',').map((x) => x.trim()).filter(Boolean);
  return new RegExp(`^(${codes.map(escapeRe).join('|')})`);
}

/** Mongo filter for the shared query fields: q, action, actor (staff number), from and to. */
function auditFilter({ q, action, actor }) {
  const filter = {};
  if (action) filter.action = actionMatch(action);
  if (actor) filter.actorStaffNo = String(actor).toUpperCase();
  if (q) {
    const re = new RegExp(escapeRe(q), 'i');
    filter.$or = [{ description: re }, { action: re }, { actorStaffNo: re }, { appRef: re }];
  }
  return filter;
}

module.exports = { escapeRe, actionMatch, auditFilter };

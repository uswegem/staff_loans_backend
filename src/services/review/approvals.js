'use strict';

// Which approvals still count (D-106). Decisions are append-only, so an approval is never
// changed: it is cancelled ("superseded") when, later in the same cycle, the application is
// returned to its stage or an earlier one. A cancelled approval stays in the history, marked,
// and is not an approval any more: the stage must approve again, and its approver is free to
// act at that or another stage (segregation of duties counts valid approvals only).

const RETURNED_TO_STAGE = (d) => d.action === 'return' && d.details?.returnTo && d.details.returnTo !== 'applicant';

/**
 * D-113: decisions that pass a stage. Credit Underwriting recommends (approval or rejection)
 * and the application moves on either way; the other stages approve.
 */
const PASSES = ['approve', 'recommend_approval', 'recommend_rejection'];
const passes = (d) => PASSES.includes(d.action);
/** The actions to load when working out valid approvals and return targets. */
const STAGE_ACTIONS = [...PASSES, 'return'];

/** Ids (strings) of approvals cancelled by a later return to their stage or an earlier one. */
function supersededIds(decisions, stages) {
  const out = new Set();
  const order = (s) => stages.indexOf(s);
  for (const r of decisions.filter(RETURNED_TO_STAGE)) {
    const to = order(r.details.returnTo);
    if (to < 0) continue;
    decisions
      .filter((a) => passes(a) && a.cycle === r.cycle && a.at <= r.at && order(a.stage) >= to)
      .forEach((a) => out.add(String(a._id)));
  }
  return out;
}

/** Approvals (and Credit Underwriting recommendations, D-113) still in force, oldest first. */
function validApprovals(decisions, stages) {
  const gone = supersededIds(decisions, stages);
  return decisions.filter((d) => passes(d) && !gone.has(String(d._id))).sort((a, b) => a.at - b.at);
}

/**
 * Stages the application may be returned to from its current stage (D-106): the earlier
 * stages on its route with a valid approval in the current cycle, nearest first.
 */
function returnTargets(app, decisions) {
  const stages = app.stages || [];
  const here = stages.indexOf(app.currentStage);
  const passed = new Set(validApprovals(decisions, stages).filter((d) => d.cycle === app.cycle).map((d) => d.stage));
  return stages.slice(0, Math.max(here, 0)).filter((s) => passed.has(s)).reverse();
}

module.exports = { supersededIds, validApprovals, returnTargets, passes, PASSES, STAGE_ACTIONS };

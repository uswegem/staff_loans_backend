'use strict';

// Stage-overdue reminders (BRD 12): once a stage passes its target in working hours,
// the current reviewers and, where a delegation is active, both the holder and the
// delegate are told once for that stage.

const Application = require('../../models/Application');
const Staff = require('../../models/Staff');
const notify = require('../notify/notificationService');
const workflow = require('./workflowService');
const { stageName, fullName } = require('../review/reviewView');
const { PENDING_STAGE } = require('../../constants/statuses');

async function remindOverdue(now = new Date()) {
  const due = await Application.find({ status: { $in: PENDING_STAGE }, stageDueAt: { $lte: now } }).lean();
  let sent = 0;
  for (const app of due) {
    /* eslint-disable no-await-in-loop */
    if (app.overdueNotifiedAt && app.overdueNotifiedAt >= app.stageEnteredAt) continue;
    // Claim the reminder first so a second instance does not send it again.
    const claimed = await Application.updateOne(
      { _id: app._id, stageEnteredAt: app.stageEnteredAt, $or: [{ overdueNotifiedAt: null }, { overdueNotifiedAt: { $lt: app.stageEnteredAt } }] },
      { $set: { overdueNotifiedAt: now } }
    );
    if (!claimed.modifiedCount) continue;
    const actors = await workflow.stageActors(app, { now });
    const recipients = actors.flatMap((a) => [a.userId, a.onBehalfOf].filter(Boolean));
    const staff = await Staff.findById(app.applicantStaffId).select('firstName lastName').lean();
    await notify.notifyUsers(
      recipients,
      { type: 'application.overdue', text: `${app.ref} from ${fullName(staff)} is overdue at ${stageName(app.currentStage)} review.`, href: `/review/${app._id}`, entity: 'Application', entityId: String(app._id) },
      { exclude: [app.applicantUserId] }
    );
    sent += 1;
    /* eslint-enable no-await-in-loop */
  }
  return sent;
}

module.exports = { remindOverdue };

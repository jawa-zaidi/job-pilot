// Automated follow-up engine: 3, 5 and 10 days after applying, based on real
// laptop time (appliedAt / sentAt are stored on each application, so the
// schedule survives restarts and device moves). Runs on an interval and on
// demand — the Sync button calls processFollowUps() to send everything due.
const { load, save, logActivity } = require('./db');
const llm = require('./llm');
const email = require('./email');

const FOLLOW_UP_DAYS = [3, 5, 10];
const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the number of follow-ups sent in this pass
async function processFollowUps() {
  const db = load();
  const current = Date.now();
  let sentCount = 0;
  let changed = false;

  for (const app of db.applications) {
    if (!app.appliedAt) continue;
    // stop following up once there's a reply, a decision, or the thread is closed
    if (['interview', 'offer', 'rejected', 'replied', 'closed'].includes(app.status) || app.replied) continue;
    app.followups = app.followups || [];

    // all follow-ups exhausted + 3 more days of silence → close as "no response"
    if (app.followups.length >= FOLLOW_UP_DAYS.length) {
      const closeAt = app.appliedAt + (FOLLOW_UP_DAYS[FOLLOW_UP_DAYS.length - 1] + 3) * DAY_MS;
      if (current >= closeAt) {
        app.status = 'closed';
        logActivity(`No response after final follow-up — ${app.title} at ${app.company} closed`, 'move');
        changed = true;
      }
      continue;
    }

    for (const day of FOLLOW_UP_DAYS) {
      const dueAt = app.appliedAt + day * DAY_MS;
      const already = app.followups.some(f => f.day === day);
      if (already || current < dueAt) continue;

      const previous = app.followups.map(f => f.email);
      let msg, result;
      try {
        msg = await llm.followUpEmail(db.profile || {}, app, day, previous);
        result = await email.sendEmail({ to: app.recipientEmail, subject: msg.subject, body: msg.body });
      } catch (err) {
        console.error('follow-up failed:', err.message);
        continue;
      }
      app.followups.push({ day, sentAt: current, email: msg, ...result });
      if (app.status === 'applied') app.status = 'followup';
      logActivity(
        `Auto follow-up (day ${day}) ${result.simulated ? 'sent (simulated)' : `emailed to ${result.to}`} for ${app.title} at ${app.company}`,
        'followup'
      );
      sentCount++;
      changed = true;
    }
  }
  if (changed) save();
  return sentCount;
}

function startScheduler() {
  setInterval(() => {
    processFollowUps().catch(err => console.error('follow-up scheduler error:', err.message));
  }, 60 * 1000);
}

module.exports = { processFollowUps, startScheduler, FOLLOW_UP_DAYS };

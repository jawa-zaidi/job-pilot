// Automated follow-up engine: 3, 5 and 10 days after applying, based on real
// laptop time (appliedAt / sentAt are stored on each application, so the
// schedule survives restarts and device moves). Runs on an interval and on
// demand — the Sync button calls processFollowUps() to send everything due.
const { load, save, logActivity } = require('./db');
const llm = require('./llm');
const email = require('./email');

const FOLLOW_UP_DAYS = [3, 5, 10];
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Space consecutive real follow-up sends so a Sync after downtime doesn't fire
// a burst of Gmail traffic at once. Simulated sends are not paced.
const sendJitterMs = () => 2000 + Math.floor(Math.random() * 3000);

// Returns the number of follow-ups sent in this pass
async function processFollowUps() {
  const db = load();
  const current = Date.now();
  const paced = email.isConfigured();
  let sentCount = 0;
  let realSent = 0;
  let changed = false;

  for (const app of db.applications) {
    if (!app.appliedAt) continue;
    // stop following up once there's a reply, a decision, or the thread is closed
    if (['interview', 'offer', 'rejected', 'replied', 'closed'].includes(app.status) || app.replied) continue;

    // Manual platform applications have nobody to email — remind the user to
    // follow up on the platform instead (same day 3/5/10 cadence). If they
    // later paste a recruiter email on the card, the automatic email
    // follow-ups below take over for the remaining days.
    if (!app.recipientEmail) {
      app.followups = app.followups || [];
      app.reminded = app.reminded || [];
      for (const day of FOLLOW_UP_DAYS) {
        if (current < app.appliedAt + day * DAY_MS) continue;
        if (app.followups.some(f => f.day === day) || app.reminded.includes(day)) continue;
        app.reminded.push(day);
        if (app.status === 'applied') app.status = 'followup';
        logActivity(
          `⏰ Follow-up due (day ${day}): ${app.title} at ${app.company} — you applied on the platform, follow up there and mark it done on the card (or add a recruiter email to automate)`,
          'followup'
        );
        changed = true;
      }
      continue;
    }
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

    // Send at most ONE follow-up per application per pass: if the app was
    // offline while day 3, 5 and 10 all came due, the recruiter must not get
    // three emails in the same minute. We send the earliest still-unsent due
    // day and break; the next due day goes out on a later pass, keeping the
    // real-time spacing between them.
    for (const day of FOLLOW_UP_DAYS) {
      const dueAt = app.appliedAt + day * DAY_MS;
      const already = app.followups.some(f => f.day === day);
      if (already || current < dueAt) continue;

      const previous = app.followups.map(f => f.email);
      let msg, result;
      try {
        if (paced && realSent > 0) await sleep(sendJitterMs());
        msg = await llm.followUpEmail(db.profile || {}, app, day, previous);
        result = await email.sendEmail({ to: app.recipientEmail, subject: msg.subject, body: msg.body });
      } catch (err) {
        console.error('follow-up failed:', err.message);
        break; // don't try the next overdue day this pass either
      }
      app.followups.push({ day, sentAt: current, email: msg, ...result });
      if (app.status === 'applied') app.status = 'followup';
      logActivity(
        `Auto follow-up (day ${day}) ${result.simulated ? 'sent (simulated)' : `emailed to ${result.to}`} for ${app.title} at ${app.company}`,
        'followup'
      );
      sentCount++;
      if (!result.simulated) realSent++;
      changed = true;
      break; // one follow-up per application per pass
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

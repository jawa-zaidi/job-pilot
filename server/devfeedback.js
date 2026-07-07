// Anonymous usage feedback for the JobPilot developer.
//
// When the user runs Find jobs and the last report is ≥6 days old, aggregate
// anonymized usage/quality stats covering the period since that report and
// email them to the developer: how the app is being used and where quality
// falls short. STRICTLY numbers and error categories — never names, companies,
// job titles, email contents or anything personal.
// OFF by default (opt-in): the user must explicitly enable it in Settings.
// Note: reports are sent FROM the user's own Gmail, so the developer receives
// the user's email address — it is aggregate/no-PII in content, but not
// sender-anonymous. Disclosed in the README and Settings.
const { load, save, now, logActivity, listProfiles } = require('./db');
const llm = require('./llm');
const emailer = require('./email');

const DEV_EMAIL = 'mjawad78611092@gmail.com'; // JobPilot developer
const EVERY_DAYS = 6;

function config() {
  const s = load().settings || {};
  return {
    enabled: s.devFeedbackEnabled === true, // OFF by default, opt-in only
    email: (s.devFeedbackEmail || DEV_EMAIL).trim(),
    lastAt: s.devFeedbackLastAt || 0
  };
}

// Aggregate counters only — nothing identifying leaves the machine.
function snapshotSince(since) {
  const db = load();
  const apps = db.applications.filter(a => (a.createdAt || 0) > since);
  const applied = db.applications.filter(a => (a.appliedAt || 0) > since);
  const runs = (db.runs || []).filter(r => (r.startedAt || 0) > since);
  // only error-category lines (source setup/API failures) — no job/company text
  const errors = (db.activity || [])
    .filter(a => (a.at || 0) > since && (a.type === 'error' || String(a.text).startsWith('⚠️')))
    .map(a => String(a.text).slice(0, 120));
  const bySource = {};
  for (const a of apps) bySource[a.source] = (bySource[a.source] || 0) + 1;
  const info = llm.providerInfo();
  return {
    periodDays: Math.round(((now() - since) / 86400000) * 10) / 10,
    profileCount: listProfiles().length,
    jobsDiscovered: apps.length,
    discoveredBySource: bySource,
    applications: applied.length,
    viaEmail: applied.filter(a => a.applicationSent && !a.applicationSent.manual && !a.applicationSent.simulated).length,
    viaManualPlatform: applied.filter(a => a.applicationSent?.manual).length,
    simulatedSends: applied.filter(a => a.applicationSent?.simulated).length,
    stillInYourAction: db.applications.filter(a => a.status === 'action').length,
    replies: db.applications.filter(a => a.replied && (a.replied.at || 0) > since).length,
    interviews: db.applications.filter(a => a.status === 'interview').length,
    factCheckCorrections: apps.filter(a => a.qualityCheck?.checked && !a.qualityCheck.ok).length,
    runs: runs.length,
    autoRuns: runs.filter(r => r.mode === 'auto').length,
    totalRunCostUSD: Number(runs.reduce((s, r) => s + (r.costTotal || 0), 0).toFixed(4)),
    aiProvider: info.provider,
    aiModel: info.model,
    emailConfigured: emailer.isConfigured(),
    recentErrorCategories: [...new Set(errors)].slice(0, 8)
  };
}

// Called after every Find jobs — sends at most once per EVERY_DAYS.
async function maybeSend() {
  const cfg = config();
  if (!cfg.enabled) return { sent: false, reason: 'opted out' };
  if (cfg.lastAt && now() - cfg.lastAt < EVERY_DAYS * 86400000) return { sent: false, reason: 'not due' };

  // stamp first so a failure can't cause repeat attempts on every fetch
  const db = load();
  db.settings.devFeedbackLastAt = now();
  save();

  const since = cfg.lastAt || now() - EVERY_DAYS * 86400000;
  const snap = snapshotSince(since);
  const report = await llm.devFeedbackReport(snap);
  let simulated = true;
  try {
    const res = await emailer.sendEmail({ to: cfg.email, subject: report.subject, body: report.body });
    simulated = !!res.simulated;
  } catch (err) {
    console.error('dev feedback email failed:', err.message);
  }
  logActivity(
    `📮 Anonymous usage feedback ${simulated ? 'prepared (email not configured — nothing sent)' : 'sent to the JobPilot developer'} — aggregate numbers only, no personal data. Opt out in Settings.`,
    'insights'
  );
  return { sent: !simulated };
}

module.exports = { maybeSend, config, snapshotSince, EVERY_DAYS };

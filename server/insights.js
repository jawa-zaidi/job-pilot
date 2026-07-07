// Auto feedback mechanism: after every N applications (default 50) or after
// an automated run, analyze the pipeline data, find gaps, and email the user
// an improvement report (viewable in-app too).
const { load, save, now, logActivity } = require('./db');
const llm = require('./llm');
const emailer = require('./email');

function insightsConfig() {
  const s = load().settings || {};
  return {
    enabled: s.insightsEnabled !== false, // on by default
    every: Math.max(5, Number(s.insightsEvery) || 50),
    email: s.insightsEmail || s.smtpUser || load().profile?.email || ''
  };
}

// Aggregate the numbers the AI needs to spot gaps
function snapshot() {
  const db = load();
  const apps = db.applications;
  const applied = apps.filter(a => a.appliedAt);
  const replied = apps.filter(a => a.replied || a.status === 'replied');
  const band = (a) => a.matchScore >= 75 ? 'high(75+)' : a.matchScore >= 55 ? 'mid(55-74)' : 'low(<55)';

  const byBand = {};
  for (const a of applied) {
    const b = band(a);
    byBand[b] = byBand[b] || { applied: 0, replied: 0 };
    byBand[b].applied++;
    if (a.replied || a.status === 'replied') byBand[b].replied++;
  }
  const bySource = {};
  for (const a of applied) {
    bySource[a.source] = bySource[a.source] || { applied: 0, replied: 0 };
    bySource[a.source].applied++;
    if (a.replied || a.status === 'replied') bySource[a.source].replied++;
  }

  return {
    totalTracked: apps.length,
    applied: applied.length,
    replies: replied.length,
    replyRatePct: applied.length ? Math.round(replied.length / applied.length * 100) : 0,
    interviews: apps.filter(a => ['interview', 'offer'].includes(a.status)).length,
    noResponseClosed: apps.filter(a => a.status === 'closed').length,
    rejected: apps.filter(a => a.status === 'rejected').length,
    followupsSent: apps.reduce((n, a) => n + (a.followups?.length || 0), 0),
    avgMatchScoreApplied: applied.length ? Math.round(applied.reduce((n, a) => n + (a.matchScore || 0), 0) / applied.length) : 0,
    withRecruiterEmail: applied.filter(a => a.recipientEmail).length,
    simulatedSends: applied.filter(a => a.applicationSent?.simulated).length,
    manualPlatformApplies: applied.filter(a => a.applicationSent?.manual).length,
    awaitingUserAction: apps.filter(a => a.status === 'action').length,
    expiredBeforeApply: apps.filter(a => (a.notes || '').includes('Expired before applying')).length,
    confirmedReceived: applied.filter(a => a.confirmed).length,
    recentRuns: (db.runs || []).slice(0, 5).map(r => ({
      mode: r.mode, found: r.found, tailored: r.tailored, sent: r.sent,
      manualQueued: r.manualQueued, costUSD: Number((r.costTotal || 0).toFixed(4))
    })),
    totalApiCostUSD: Number((require('./costs').totals().totalUSD || 0).toFixed(4)),
    replyRateByMatchBand: byBand,
    replyRateBySource: bySource,
    recentApplications: applied.slice(0, 25).map(a => ({
      title: a.title, company: a.company, score: a.matchScore, status: a.status,
      replied: !!a.replied, followups: (a.followups || []).length
    }))
  };
}

async function generateReport(trigger) {
  const db = load();
  const cfg = insightsConfig();
  const snap = snapshot();

  const report = await llm.insightsReport(db.profile || {}, snap, trigger);

  db.reports = db.reports || [];
  db.reports.unshift({ at: now(), trigger, subject: report.subject, body: report.body });
  db.reports = db.reports.slice(0, 10);
  db.appliedSinceReport = 0;
  save();

  let emailed = false;
  if (cfg.email) {
    try {
      const res = await emailer.sendEmail({ to: cfg.email, subject: report.subject, body: report.body });
      emailed = !res.simulated;
    } catch (err) {
      console.error('insights email failed:', err.message);
    }
  }
  logActivity(
    `📊 Improvement report generated (${trigger})${emailed ? ` and emailed to ${cfg.email}` : ' — view it via the sidebar (email not configured)'}`,
    'insights'
  );
  return { report, emailed, to: cfg.email };
}

// Called after applications go out; fires a report when the counter hits N
async function afterApplies(count) {
  if (!count) return null;
  const db = load();
  const cfg = insightsConfig();
  db.appliedSinceReport = (db.appliedSinceReport || 0) + count;
  save();
  if (!cfg.enabled) return null;
  if (db.appliedSinceReport >= cfg.every) {
    try {
      return await generateReport(`${cfg.every} applications milestone`);
    } catch (err) {
      console.error('insights after-applies failed:', err.message);
    }
  }
  return null;
}

// Called at the end of an automated cycle
async function afterAutoRun(sentCount) {
  const cfg = insightsConfig();
  if (!cfg.enabled || !sentCount) return null;
  try {
    return await generateReport('automated run');
  } catch (err) {
    console.error('insights after-auto-run failed:', err.message);
    return null;
  }
}

module.exports = { insightsConfig, snapshot, generateReport, afterApplies, afterAutoRun };

// Batch pipeline: fetch best jobs in bulk → approve → generate all CVs/emails
// → send all. Manual mode gates each step behind a user click; auto mode runs
// the whole cycle unattended.
const { load, save, now, logActivity } = require('./db');
const llm = require('./llm');
const emailer = require('./email');
const costs = require('./costs');
const { discover } = require('./discovery');

function dailyTarget() {
  return Math.max(1, Number(load().settings?.dailyTarget) || 50);
}

// Step 1: fetch across multiple queries derived from the CV until the target
// number of unapplied matches is on the board (or sources are exhausted).
async function fetchBatch(target) {
  const db = load();
  if (!db.profile) throw new Error('Upload your CV first');
  target = target || dailyTarget();

  const p = db.profile;
  const queries = [...new Set(
    [...(p.target_roles || []), p.title, ...(p.skills || []).slice(0, 4).map(s => `${s}`)]
      .filter(Boolean).map(q => String(q).trim())
  )];

  const runStart = costs.beginRun();
  let added = 0, skipped = 0;
  const used = [];
  for (const q of queries) {
    const pending = load().applications.filter(a => ['discovered', 'approved', 'ready'].includes(a.status)).length;
    if (pending >= target) break;
    // pull more per source the further we are from the target, but never add past it
    const remaining = target - pending;
    const limit = Math.min(25, Math.max(10, remaining));
    try {
      const r = await discover(q, { activityLabel: 'Batch fetch', limit, maxAdd: remaining });
      added += r.added;
      skipped += r.skipped;
      used.push(q);
    } catch (err) {
      console.error(`batch fetch "${q}" failed:`, err.message);
    }
  }
  const cost = costs.endRun(runStart);
  const discovered = load().applications.filter(a => a.status === 'discovered').length;
  logActivity(`Batch fetch done: ${added} new matches (${skipped} poor fits filtered) across ${used.length} searches · cost ${costs.fmt(cost.usd)}`, 'search');
  save();
  return { added, skipped, queries: used, discovered, target, cost };
}

// Step 1b: approve everything still in "discovered" (user removes bad ones first)
function approveAll() {
  const db = load();
  let n = 0;
  for (const a of db.applications) {
    if (a.status === 'discovered') { a.status = 'approved'; n++; }
  }
  save();
  if (n) logActivity(`${n} jobs approved for CV & email generation`, 'move');
  return { approved: n };
}

// Step 2: generate tailored CV + email for the jobs the user kept in review
// (Discovered). Only touches those — removed cards are already gone, and
// already-generated (CV Ready) jobs are left alone.
async function generateAll({ statuses = ['discovered', 'approved'] } = {}) {
  const db = load();
  const targets = db.applications.filter(a => statuses.includes(a.status));
  const runStart = costs.beginRun();
  let done = 0, failed = 0, lastError = '';
  for (const a of targets) {
    try {
      if (!a.tailored) a.tailored = await llm.tailorApplication(db.profile, db.cvText || '', a);
      a.tailoredAt = now();
      a.status = 'ready';
      save();
      done++;
    } catch (err) {
      failed++;
      lastError = err.message;
      console.error(`generate failed for ${a.title}:`, err.message);
      if (err.message.includes('daily limit')) break; // no point hammering a rate-limited API
    }
  }
  const cost = costs.endRun(runStart);
  if (done || failed) logActivity(`Batch generate: ${done} tailored CVs & emails ready${failed ? `, ${failed} failed` : ''} · cost ${costs.fmt(cost.usd)}`, 'tailor');
  save();
  return { done, failed, total: targets.length, cost, error: failed ? lastError : '' };
}

// Step 3: send everything that's ready
async function sendAll({ skipInsights = false } = {}) {
  const db = load();
  const targets = db.applications.filter(a => a.status === 'ready' && a.tailored);
  let sent = 0, simulated = 0, failed = 0;
  for (const a of targets) {
    try {
      const result = await emailer.sendEmail({
        to: a.recipientEmail,
        subject: a.tailored.email_subject,
        body: a.tailored.email_body + '\n\n---\n' + a.tailored.cv
      });
      a.status = 'applied';
      a.appliedAt = now();
      a.applicationSent = { at: now(), ...result };
      result.simulated ? simulated++ : sent++;
      save();
    } catch (err) {
      failed++;
      console.error(`send failed for ${a.title}:`, err.message);
    }
  }
  if (targets.length) {
    logActivity(`Batch send: ${sent} emailed for real, ${simulated} simulated${failed ? `, ${failed} failed` : ''} — follow-ups scheduled (day 3, 5, 10)`, 'apply');
  }
  if (!skipInsights && (sent + simulated) > 0) {
    // lazy require avoids a circular import
    await require('./insights').afterApplies(sent + simulated)
      .catch(err => console.error('insights hook failed:', err.message));
  }
  // sending itself is free (Gmail); cost object kept for a uniform shape
  return { sent, simulated, failed, total: targets.length, cost: { usd: 0, ai: 0, source: 0 } };
}

// Auto mode: the whole cycle with no human review
async function runAutoCycle(target) {
  const runStart = costs.beginRun();
  const fetch = await fetchBatch(target);
  const generated = await generateAll(); // tailors discovered directly
  const sendResult = await sendAll({ skipInsights: true });
  const cost = costs.endRun(runStart);
  logActivity(`Auto cycle complete: ${fetch.added} found, ${generated.done} tailored, ${sendResult.sent + sendResult.simulated} applications sent · cost ${costs.fmt(cost.usd)}`, 'apply');
  // auto feedback: one report per automated run (when anything was sent)
  await require('./insights').afterAutoRun(sendResult.sent + sendResult.simulated)
    .catch(err => console.error('insights hook failed:', err.message));
  return { fetch, generated, sendResult, cost };
}

module.exports = { fetchBatch, approveAll, generateAll, sendAll, runAutoCycle, dailyTarget };

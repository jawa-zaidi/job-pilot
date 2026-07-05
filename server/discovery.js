// Job discovery: shared by the manual Search button and the auto-search
// scheduler. Auto-search runs every N hours (default 6) using the target
// roles extracted from the user's CV.
const { load, save, now, logActivity } = require('./db');
const llm = require('./llm');
const { searchJobs } = require('./jobs');

const MIN_SCORE = 30;      // discard poor fits
const CHECK_EVERY_MS = 15 * 60 * 1000;

async function discover(query, { activityLabel = 'Job search' } = {}) {
  const db = load();
  if (!db.profile) throw new Error('Upload your CV first');
  const q = (query || db.profile.target_roles?.[0] || db.profile.title || 'software').trim();

  const { jobs, source } = await searchJobs(q, 10);
  const fresh = jobs.filter(j => !db.applications.some(a => a.id === j.id));
  const scores = fresh.length ? await llm.scoreJobs(db.profile, fresh) : {};

  let added = 0, skipped = 0;
  for (const job of fresh) {
    const s = scores[String(job.id)] || { score: 50, reasons: [] };
    if (s.score < MIN_SCORE) { skipped++; continue; }
    db.applications.push({
      ...job,
      matchScore: Math.round(s.score),
      matchReasons: s.reasons,
      status: 'discovered',
      createdAt: now(),
      appliedAt: null,
      tailored: null,
      followups: [],
      notes: ''
    });
    added++;
  }
  db.applications.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  save();
  if (added || skipped) {
    logActivity(`${activityLabel} "${q}" via ${source}: ${added} good matches added${skipped ? `, ${skipped} poor fits filtered out` : ''}`, 'search');
  }
  return { added, skipped, source, query: q };
}

function autoSearchConfig() {
  const s = load().settings || {};
  return {
    enabled: s.autoSearch !== false, // on by default
    hours: Math.max(1, Number(s.autoSearchHours) || 6)
  };
}

async function autoSearchTick(force = false) {
  const db = load();
  const cfg = autoSearchConfig();
  if (!cfg.enabled && !force) return { ran: false, reason: 'disabled' };
  if (!db.profile) return { ran: false, reason: 'no profile yet' };

  const due = !db.lastAutoSearchAt || Date.now() - db.lastAutoSearchAt >= cfg.hours * 3600000;
  if (!due && !force) return { ran: false, reason: 'not due yet' };

  db.lastAutoSearchAt = Date.now();
  save();

  // Auto mode: run the entire pipeline unattended (fetch → approve →
  // generate → send). Lazy require to avoid a circular import with batch.js.
  if ((db.settings?.mode || 'manual') === 'auto') {
    const batch = require('./batch');
    const cycle = await batch.runAutoCycle();
    return { ran: true, mode: 'auto', ...cycle };
  }

  // Manual mode: only discover — the user reviews and drives the rest.
  const queries = (db.profile.target_roles || []).slice(0, 2);
  if (!queries.length) queries.push(db.profile.title || 'software');

  let added = 0, skipped = 0;
  for (const q of queries) {
    try {
      const r = await discover(q, { activityLabel: 'Auto-discovery' });
      added += r.added;
      skipped += r.skipped;
    } catch (err) {
      console.error(`auto-search "${q}" failed:`, err.message);
    }
  }
  return { ran: true, mode: 'manual', added, skipped, queries };
}

function startAutoSearch() {
  // first pass shortly after boot (if due), then check every 15 minutes
  setTimeout(() => autoSearchTick().catch(err => console.error('auto-search error:', err.message)), 10 * 1000);
  setInterval(() => autoSearchTick().catch(err => console.error('auto-search error:', err.message)), CHECK_EVERY_MS);
}

module.exports = { discover, autoSearchTick, autoSearchConfig, startAutoSearch };

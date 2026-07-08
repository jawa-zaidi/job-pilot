// Job discovery: shared by the manual Search button and the auto-search
// scheduler. Auto-search runs every N hours (default 6) using the target
// roles extracted from the user's CV.
const { load, save, now, logActivity } = require('./db');
const llm = require('./llm');
const { searchJobs, canonicalKey, normCompany, extractRecruiterEmail } = require('./jobs');

const MIN_SCORE = 40;      // discard poor fits (LLM match floor)
const CHECK_EVERY_MS = 15 * 60 * 1000;

function cooldownDays() {
  return Math.max(0, Number(load().settings?.companyCooldownDays) || 14);
}

// Rank = LLM fit + bonuses discovery can see on its own. The match % shown to
// the user stays the pure LLM fit; boosts only change ordering and are listed
// with the match reasons so the ranking is explainable.
function rankBoosts(job, preferredTitles = []) {
  const boosts = [];
  let bonus = 0;
  const age = job.publishedAt ? (Date.now() - new Date(job.publishedAt).getTime()) / 86400000 : null;
  if (age != null && age <= 2) { bonus += 8; boosts.push('posted <48h — few applicants yet (+8)'); }
  else if (age != null && age <= 7) { bonus += 4; boosts.push('posted this week (+4)'); }
  else if (age != null && age > 21) { bonus -= 5; boosts.push('3+ weeks old (−5)'); }
  if (job.recipientEmail) { bonus += 10; boosts.push('recruiter email found — direct apply path (+10)'); }
  if (job.source === 'Career page') { bonus += 5; boosts.push('direct from company career page (+5)'); }
  const title = (job.title || '').toLowerCase();
  if (preferredTitles.some(t => title.includes(t.toLowerCase()))) {
    bonus += 6; boosts.push('matches one of your preferred job titles (+6)');
  }
  return { bonus, boosts };
}

async function discover(query, { activityLabel = 'Job search', limit = 10, maxAdd = Infinity } = {}) {
  const db = load();
  if (!db.profile) throw new Error('Upload your CV first');
  // Default query priority: user's preferred title > CV-derived role > CV title
  const preferredTitle = require('./jobs').jobPrefs().titles[0];
  const q = (query || preferredTitle || db.profile.target_roles?.[0] || db.profile.title || 'software').trim();

  const { jobs, source, filtered, note } = await searchJobs(q, limit);

  // A silent zero is a dead end for the user — say WHY nothing came through.
  if (!jobs.length && note) {
    // batch fetch runs many queries back to back — log each distinct cause once
    const recent = (db.activity || []).slice(0, 10).some(a => a.text.includes(note.slice(0, 70)));
    if (!recent) logActivity(`⚠️ ${note}`, 'error');
  } else if (!jobs.length && filtered > 0) {
    logActivity(
      `${activityLabel} "${q}": ${filtered} job${filtered > 1 ? 's' : ''} found but ALL filtered out by your preferences ` +
      `(locations / posted-in-last-N-days — see Settings → 🎯 Job preferences). Loosen them to see these jobs.`,
      'search');
  }

  // Skip anything already on the board — same source ID or the same
  // company+title from another source (reposts and cross-board duplicates).
  const knownKeys = new Set(db.applications.map(a => a.key || canonicalKey(a)));
  const knownIds = new Set(db.applications.map(a => a.id));
  // Company cooldown: recently applied there → don't pile on a second one yet
  const cd = cooldownDays() * 86400000;
  const recentCompanies = new Set(
    db.applications
      .filter(a => a.appliedAt && now() - a.appliedAt < cd)
      .map(a => normCompany(a.company))
  );

  let dupes = 0, cooled = 0;
  const fresh = jobs.filter(j => {
    if (knownIds.has(j.id) || knownKeys.has(canonicalKey(j))) { dupes++; return false; }
    if (recentCompanies.has(normCompany(j.company))) { cooled++; return false; }
    return true;
  });

  // Best apply path: a real contact address in the posting
  for (const j of fresh) {
    if (!j.recipientEmail) j.recipientEmail = extractRecruiterEmail(j.description);
  }

  const scores = fresh.length ? await llm.scoreJobs(db.profile, fresh) : {};

  // strongest first (fit + bonuses), so a maxAdd cap keeps the best ones
  const preferredTitles = require('./jobs').jobPrefs().titles;
  const ranked = fresh.map(job => {
    const s = scores[String(job.id)] || { score: 50, reasons: [] };
    const { bonus, boosts } = rankBoosts(job, preferredTitles);
    return { job, score: s.score, reasons: s.reasons || [], bonus, boosts };
  }).sort((a, b) => (b.score + b.bonus) - (a.score + a.bonus));

  let added = 0, skipped = 0;
  for (const r of ranked) {
    if (added >= maxAdd) break;
    if (r.score < MIN_SCORE) { skipped++; continue; }
    db.applications.push({
      ...r.job,
      key: canonicalKey(r.job),
      applyPath: r.job.recipientEmail ? 'email' : 'manual',
      matchScore: Math.round(r.score),
      matchReasons: [...r.reasons, ...r.boosts],
      rankScore: Math.round(r.score + r.bonus),
      status: 'discovered',
      createdAt: now(),
      appliedAt: null,
      tailored: null,
      followups: [],
      notes: ''
    });
    knownKeys.add(canonicalKey(r.job)); // no dupes within this batch either
    added++;
  }
  db.applications.sort((a, b) => (b.rankScore || b.matchScore || 0) - (a.rankScore || a.matchScore || 0));
  save();
  if (added || skipped || dupes || cooled) {
    const extras = [
      skipped ? `${skipped} poor fits filtered` : '',
      dupes ? `${dupes} duplicates/reposts skipped` : '',
      cooled ? `${cooled} skipped (applied to that company recently)` : ''
    ].filter(Boolean).join(', ');
    logActivity(`${activityLabel} "${q}" via ${source}: ${added} good matches added${extras ? ` (${extras})` : ''}`, 'search');
  }
  return { added, skipped, dupes, cooled, source, query: q };
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

  // Manual mode: discover up to the per-cycle target — the user reviews and
  // drives the rest. Same capped fetch as the smart button.
  const batch = require('./batch');
  const r = await batch.fetchBatch();
  return { ran: true, mode: 'manual', ...r };
}

function startAutoSearch() {
  // first pass shortly after boot (if due), then check every 15 minutes
  setTimeout(() => autoSearchTick().catch(err => console.error('auto-search error:', err.message)), 10 * 1000);
  setInterval(() => autoSearchTick().catch(err => console.error('auto-search error:', err.message)), CHECK_EVERY_MS);
}

module.exports = { discover, autoSearchTick, autoSearchConfig, startAutoSearch };

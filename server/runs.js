// Run ledger: one "run" = one full cycle (fetch → generate → send), whether
// the user drove it step by step (manual mode) or auto mode did it unattended.
// Every run records what happened and what it actually cost — AI tokens and
// paid source APIs separately — so spend per ~50 applications is always visible.
const { load, save, now, logActivity } = require('./db');
const costs = require('./costs');

const STALE_MS = 24 * 60 * 60 * 1000; // an unfinished run older than a day is abandoned

function blankRun(mode) {
  return {
    id: 'run_' + now().toString(36),
    mode,                 // 'manual' | 'auto'
    startedAt: now(),
    activeOp: null,       // 'fetching' | 'generating' | 'sending' — the step running right now
    activeSince: 0,
    found: 0, tailored: 0, sent: 0, simulated: 0, manualQueued: 0, expired: 0,
    costAI: 0, costSource: 0
  };
}

// Mark the step that's actively executing, so the UI can show a live indicator
// that survives page refreshes and covers unattended auto runs.
function markBusy(op) {
  const db = load();
  beginIfNeeded();
  db.currentRun.activeOp = op;
  db.currentRun.activeSince = now();
  save();
}
function clearBusy() {
  const db = load();
  if (db.currentRun) { db.currentRun.activeOp = null; save(); }
}

// Start a run of the given mode, replacing any stale leftover
function startRun(mode) {
  const db = load();
  db.currentRun = blankRun(mode);
  save();
  return db.currentRun;
}

// Auto cycles start the run explicitly; manual steps join the run in progress
// (or open a fresh manual one if none / the old one went stale).
function beginIfNeeded(mode = 'manual') {
  const db = load();
  if (!db.currentRun || now() - db.currentRun.startedAt > STALE_MS) {
    db.currentRun = blankRun(mode);
    save();
  }
  return db.currentRun;
}

// Merge step results into the run in progress. `cost` is the {ai, source}
// object costs.endRun() returns for that step.
function addToRun(patch = {}, cost = null) {
  const db = load();
  beginIfNeeded();
  const r = db.currentRun;
  for (const k of ['found', 'tailored', 'sent', 'simulated', 'manualQueued', 'expired']) {
    if (patch[k]) r[k] += patch[k];
  }
  if (cost) {
    r.costAI += cost.ai || 0;
    r.costSource += cost.source || 0;
  }
  save();
  return r;
}

// Close the run (called when the send step finishes), log its true cost.
function finishRun() {
  const db = load();
  const r = db.currentRun;
  if (!r) return null;
  r.endedAt = now();
  r.costTotal = r.costAI + r.costSource;
  db.runs = db.runs || [];
  db.runs.unshift(r);
  db.runs = db.runs.slice(0, 50);
  db.currentRun = null;
  save();
  logActivity(
    `📒 Run complete (${r.mode}): ${r.found} found, ${r.tailored} tailored, ${r.sent} emailed, ` +
    `${r.manualQueued} queued for you${r.simulated ? `, ${r.simulated} simulated` : ''}${r.expired ? `, ${r.expired} expired` : ''} · ` +
    `cost AI ${costs.fmt(r.costAI)} + sources ${costs.fmt(r.costSource)} = ${costs.fmt(r.costTotal)}`,
    'run'
  );
  return r;
}

// Close a run the user has nothing left to press a button for: no step
// executing and no cards waiting in Discovered/Approved/CV Ready. Manual
// "Your action" applications do NOT hold a run open — they cost nothing and
// happen whenever the user gets to them.
function settleIdleRun() {
  const db = load();
  const r = db.currentRun;
  if (!r) return;
  // a step marked busy >10 min with no completion = the process died mid-run
  if (r.activeOp && now() - (r.activeSince || 0) > 10 * 60 * 1000) {
    r.activeOp = null;
    save();
  }
  if (r.activeOp) return; // genuinely executing
  const pending = db.applications.some(a => ['discovered', 'approved', 'ready'].includes(a.status));
  if (pending) return;    // waiting on the user's next click — keep the run open
  if (r.found || r.tailored || r.sent || r.simulated || r.manualQueued) {
    finishRun();
  } else {
    db.currentRun = null;  // nothing ever happened — discard silently
    save();
  }
}

function listRuns(limit = 20) {
  settleIdleRun();
  const db = load();
  return { runs: (db.runs || []).slice(0, limit), current: db.currentRun || null };
}

module.exports = { startRun, beginIfNeeded, addToRun, finishRun, markBusy, clearBusy, settleIdleRun, listRuns };

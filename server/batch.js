// Batch pipeline: fetch best jobs in bulk → approve → generate all CVs/emails
// → send all. Manual mode gates each step behind a user click; auto mode runs
// the whole cycle unattended.
//
// Applications are routed by apply path:
//   email  — a recruiter address was found AND the person asked JobPilot to send
//            → we email the tailored CV (PDF) directly
//   manual — no address, or they said "I'll send them myself"; after generation
//            the card moves to "Your action", where they send it (or apply on
//            the platform) and click "I applied" to confirm
//
// `settings.sendingMode` decides which of those two an emailable job takes, and
// it is honoured in one place only — `sendPath()` below — so nothing can drift.
const { load, save, now, logActivity, sendingMode } = require('./db');
const llm = require('./llm');
const emailer = require('./email');
const costs = require('./costs');
const runs = require('./runs');
const { discover } = require('./discovery');
const { verifyJobLive } = require('./verify');
const { cvToPdfBuffer, cvFileName } = require('./pdf');

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Gmail flags bursts of near-identical mail; space consecutive REAL sends out a
// few seconds (jittered). Skipped entirely for simulated/mock sends.
const sendJitterMs = () => 2000 + Math.floor(Math.random() * 3000);

function dailyTarget() {
  return Math.max(1, Number(load().settings?.dailyTarget) || 50);
}

// Auto mode only sends strong fits without review; weaker matches stay on the
// board for the user even while autopilot is on.
function autoMinScore() {
  return Math.min(95, Math.max(0, Number(load().settings?.autoMinScore) || 70));
}

function factCheckEnabled() {
  return load().settings?.factCheck !== false; // on by default
}

// The single decision every send path defers to. A written application is
// either ours to email ('ready') or theirs to send ('action') — there is no
// third answer, and the person's own choice always wins over the fact that we
// happen to have found an address.
function sendPath(a) {
  return a.recipientEmail && sendingMode() === 'jobpilot' ? 'ready' : 'action';
}

// Re-route everything already written whenever the answer to that question can
// have changed: at start-up (so an existing store catches up) and the moment
// the person changes the setting. Nothing else about the job is touched.
function applySendingMode() {
  const db = load();
  let moved = 0;
  for (const a of db.applications) {
    if (!a.tailored || !['ready', 'action'].includes(a.status)) continue;
    const want = sendPath(a);
    if (a.status !== want) { a.status = want; moved++; }
  }
  if (moved) save();
  return moved;
}

// Step 1: fetch across multiple queries derived from the CV until the target
// number of unapplied matches is on the board (or sources are exhausted).
async function fetchBatch(target) {
  const db = load();
  if (!db.profile) throw new Error("We need your CV first — it's what every application is written from.");
  target = target || dailyTarget();
  runs.beginIfNeeded('manual'); // joins the auto run when one is already open

  const p = db.profile;
  // The user's preferred job titles (Settings → Job preferences) are searched
  // first — an exact title the user chose beats anything guessed from the CV.
  // CV-derived roles and skills follow as backfill until the target is met.
  const preferred = require('./jobs').jobPrefs().titles;
  const queries = [...new Set(
    [...preferred, ...(p.target_roles || []), p.title, ...(p.skills || []).slice(0, 4).map(s => `${s}`)]
      .filter(Boolean).map(q => String(q).trim())
  )];

  runs.markBusy('fetching');
  const runStart = costs.beginRun();
  let added = 0, skipped = 0;
  const used = [];
  const notes = new Set(); // source problems ("X runs its own careers site") — shown to the user
  // Pending = jobs still moving through the PIPELINE (to review, generate or
  // send). "Your action" cards are deliberately excluded: they wait on the
  // user, cost nothing, and can sit for days — they must not starve new
  // discovery (a target of 5 with 6 action cards used to fetch NOTHING).
  const pendingCount = () =>
    load().applications.filter(a => ['discovered', 'approved', 'ready'].includes(a.status)).length;
  for (const q of queries) {
    const pending = pendingCount();
    if (pending >= target) break;
    // pull more per source the further we are from the target, but never add past it
    const remaining = target - pending;
    const limit = Math.min(25, Math.max(10, remaining));
    try {
      const r = await discover(q, { activityLabel: 'Batch fetch', limit, maxAdd: remaining });
      added += r.added;
      skipped += r.skipped;
      if (r.note) notes.add(r.note);
      used.push(q);
    } catch (err) {
      console.error(`batch fetch "${q}" failed:`, err.message);
    }
  }
  const cost = costs.endRun(runStart);
  runs.addToRun({ found: added }, cost);
  runs.clearBusy();
  // every ~6 days: anonymous usage feedback to the developer (opt-out in Settings);
  // fire-and-forget so it never slows the user's fetch down
  require('./devfeedback').maybeSend().catch(err => console.error('dev feedback failed:', err.message));
  const discovered = load().applications.filter(a => a.status === 'discovered').length;
  // Never end a fetch with an unexplained zero — say what blocked it.
  let reason = '';
  if (!used.length) {
    const waiting = pendingCount();
    // The day's activity is rewritten for the Home feed by its exact shape —
    // leave this line's wording alone. What a person reads is `reason`, below.
    logActivity(`⚠️ Fetch skipped: ${waiting} jobs already on the board waiting for review/generation/sending (per-cycle target: ${target}).`, 'search');
    reason = `We didn't go looking this time — ${waiting} ${waiting === 1 ? 'job is' : 'jobs are'} already waiting for you. `
      + 'Work through those (or drop the ones you do not want), and we will look again.';
  } else {
    // sources ran but produced nothing → the toast must carry the WHY
    if (!added && notes.size) reason = [...notes].join(' · ');
    logActivity(`Batch fetch done: ${added} new matches (${skipped} poor fits filtered) across ${used.length} searches · cost ${costs.fmt(cost.usd)}`, 'search');
  }
  save();
  return { added, skipped, queries: used, discovered, target, cost, reason };
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
// (Discovered). Each draft passes a fact-check (no invented claims) before it
// counts as ready. Jobs without a recruiter email land in "Your action".
async function generateAll({ statuses = ['discovered', 'approved'], minScore = 0 } = {}) {
  const db = load();
  const targets = db.applications.filter(a => statuses.includes(a.status) && (a.matchScore || 0) >= minScore);
  const heldBack = db.applications.filter(a => statuses.includes(a.status) && (a.matchScore || 0) < minScore).length;
  runs.markBusy('generating');
  const runStart = costs.beginRun();
  let done = 0, failed = 0, manualQueued = 0, fixed = 0, lastError = '';
  for (const a of targets) {
    try {
      if (!a.tailored) {
        a.tailored = await llm.tailorApplication(db.profile, db.cvText || '', a);
        // honesty gate: strip anything the draft claims that the real CV doesn't back
        if (factCheckEnabled() && llm.hasKey()) {
          const check = await llm.reviewTailored(db.profile, db.cvText || '', a, a.tailored);
          a.qualityCheck = { ok: check.ok, problems: check.problems, checked: check.checked, at: now() };
          if (!check.ok && (check.cv || check.email_body)) {
            if (check.cv) a.tailored.cv = check.cv;
            if (check.email_body) a.tailored.email_body = check.email_body;
            fixed++;
          }
        }
      }
      a.tailoredAt = now();
      a.status = sendPath(a); // 'ready' = ours to email, 'action' = theirs to send
      if (a.status === 'action') manualQueued++;
      save();
      done++;
    } catch (err) {
      failed++;
      lastError = err.message;
      console.error(`generate failed for ${a.title}:`, err.message);
      // no point hammering a service that has told us to stop
      if (err.httpStatus === 429 || /allowance|enough requests/i.test(err.message)) break;
    }
  }
  const cost = costs.endRun(runStart);
  runs.addToRun({ tailored: done, manualQueued }, cost);
  runs.clearBusy();
  if (done || failed) {
    logActivity(
      // Wording read by the Home feed's rule for this line — change both together.
      `Batch generate: ${done} tailored CVs & emails ready${fixed ? ` (${fixed} corrected by fact-check)` : ''}` +
      `${manualQueued ? `, ${manualQueued} for you to send yourself (Your action column)` : ''}` +
      `${failed ? `, ${failed} failed` : ''} · cost ${costs.fmt(cost.usd)}`, 'tailor');
  }
  save();
  return { done, failed, manualQueued, fixed, heldBack, total: targets.length, cost, error: failed ? lastError : '' };
}

// Step 3: send everything on the email path. Each job is re-checked against
// its source right before sending — expired postings are closed, not applied to.
//
// When the person said "I'll send them myself" this step does not send. It hands
// every written application back to them under "Needs you" and stops. Nothing is
// marked applied, no `appliedAt` is stamped and no follow-up clock starts,
// because none of that would be true.
async function sendAll({ skipInsights = false, minScore = 0 } = {}) {
  const db = load();

  if (sendingMode() === 'myself') {
    const handedBack = applySendingMode();
    const waiting = db.applications.filter(a => a.status === 'action' && a.tailored).length;
    runs.clearBusy();
    const run = runs.finishRun();
    if (waiting) {
      // Wording read by the Home feed's rule for this line — change both together.
      logActivity(`Ready for you to send: ${waiting} written and waiting — nothing was emailed, because you send these yourself`, 'apply');
    }
    return {
      sent: 0, simulated: 0, failed: 0, expired: 0, heldBack: 0, total: 0,
      yoursToSend: true, handedBack, waiting, run, cost: { usd: 0, ai: 0, source: 0 }
    };
  }

  const targets = db.applications.filter(a =>
    a.status === 'ready' && a.tailored && a.recipientEmail && (a.matchScore || 0) >= minScore);
  const heldBack = db.applications.filter(a =>
    a.status === 'ready' && a.tailored && a.recipientEmail && (a.matchScore || 0) < minScore).length;
  if (targets.length) runs.markBusy('sending');
  const paced = emailer.isConfigured(); // real sends → pace them; simulated → no delay
  let sent = 0, simulated = 0, failed = 0, expired = 0;
  for (const a of targets) {
    try {
      const alive = await verifyJobLive(a);
      if (!alive.live) {
        a.status = 'closed';
        a.notes = ((a.notes || '') + `\nExpired before applying: ${alive.reason}`).trim();
        expired++;
        save();
        logActivity(`Skipped ${a.title} at ${a.company} — ${alive.reason}`, 'move');
        continue;
      }
      const attachments = [];
      try {
        const pdf = await cvToPdfBuffer(a.tailored.cv, { name: db.profile?.name });
        attachments.push({ filename: cvFileName(db.profile?.name, a.company, a.title), content: pdf });
      } catch (err) {
        console.error('CV PDF failed, sending text fallback:', err.message);
      }
      if (paced && (sent + simulated) > 0) await sleep(sendJitterMs());
      const result = await emailer.sendEmail({
        to: a.recipientEmail,
        subject: a.tailored.email_subject,
        body: a.tailored.email_body + (attachments.length ? '' : '\n\n---\n' + a.tailored.cv),
        attachments
      });
      a.status = 'applied';
      a.appliedAt = now();
      a.applicationSent = { at: now(), ...result, cvAttached: !!attachments.length };
      result.simulated ? simulated++ : sent++;
      save();
    } catch (err) {
      failed++;
      console.error(`send failed for ${a.title}:`, err.message);
    }
  }
  runs.addToRun({ sent, simulated, expired });
  const run = runs.finishRun(); // a completed send closes the run and logs its true cost
  if (targets.length) {
    logActivity(`Batch send: ${sent} emailed for real, ${simulated} simulated${expired ? `, ${expired} expired postings skipped` : ''}${failed ? `, ${failed} failed` : ''} — follow-ups scheduled (day 3, 5, 10)`, 'apply');
  }
  if (!skipInsights && (sent + simulated) > 0) {
    // lazy require avoids a circular import
    await require('./insights').afterApplies(sent + simulated)
      .catch(err => console.error('insights hook failed:', err.message));
  }
  // sending itself is free (Gmail); run carries the AI/source cost
  return { sent, simulated, failed, expired, heldBack, total: targets.length, run, cost: { usd: 0, ai: 0, source: 0 } };
}

// Auto mode: the whole cycle with no human review — but only for strong fits.
// Weaker matches (below the auto threshold) stay on the board for the user.
async function runAutoCycle(target) {
  const floor = autoMinScore();
  runs.startRun('auto');
  const fetch = await fetchBatch(target);
  const generated = await generateAll({ minScore: floor }); // weak fits stay in Discovered
  const sendResult = await sendAll({ skipInsights: true, minScore: floor });
  const run = sendResult.run;
  logActivity(
    `Auto cycle complete: ${fetch.added} found, ${generated.done} tailored, ${sendResult.sent + sendResult.simulated} emailed, ` +
    `${sendResult.yoursToSend ? sendResult.waiting || 0 : generated.manualQueued || 0} waiting for you in "Your action"` +
    `${generated.heldBack ? `, ${generated.heldBack} below the ${floor}% auto threshold left for review` : ''} · ` +
    `cost ${costs.fmt(run ? run.costTotal : 0)}`, 'apply');
  // auto feedback: one report per automated run (when anything was sent)
  await require('./insights').afterAutoRun(sendResult.sent + sendResult.simulated)
    .catch(err => console.error('insights hook failed:', err.message));
  return { fetch, generated, sendResult, run, cost: { usd: run ? run.costTotal : 0, ai: run ? run.costAI : 0, source: run ? run.costSource : 0 } };
}

module.exports = {
  fetchBatch, approveAll, generateAll, sendAll, runAutoCycle,
  dailyTarget, autoMinScore, sendPath, applySendingMode
};

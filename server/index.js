const path = require('path');
const express = require('express');
const multer = require('multer');

// People are told to leave the Terminal window open, so they read it as the
// app's status display. This keeps developer diagnostics off that screen and in
// a log file instead — first, before anything else can print.
require('./log').install();

const { load, save, now, logActivity, isFirstRun, DATA_DIR, saveCvOriginal,
        listProfiles, createProfile, switchProfile, deleteProfile, renameProfile,
        welcomeSettings, sendingMode } = require('./db');
const llm = require('./llm');
const email = require('./email');
const { sourcesConfig, clearAtsCache } = require('./jobs');
const { discover, autoSearchTick, autoSearchConfig, startAutoSearch } = require('./discovery');
const batch = require('./batch');
const insights = require('./insights');
const { syncInbox } = require('./inbox');
const { processFollowUps, startScheduler, FOLLOW_UP_DAYS } = require('./followups');

const app = express();
const PORT = process.env.PORT || 4310;
// Bind to loopback by default so the CV, settings and Gmail send capability are
// not exposed to everyone on the local network. Opt in to LAN access with
// HOST=0.0.0.0 or JOBPILOT_LAN=1 (a warning is logged when LAN mode is on).
const LAN = process.env.JOBPILOT_LAN === '1' || (process.env.HOST && process.env.HOST !== '127.0.0.1' && process.env.HOST !== 'localhost');
const HOST = process.env.HOST || (LAN ? '0.0.0.0' : '127.0.0.1');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------- CV upload & profile ----------

async function extractText(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf')) {
    const pdfParse = require('pdf-parse');
    // pdf-parse bundles pdf.js v1.10, which mis-reads a Node Buffer: multer
    // hands us a *pooled* Buffer (a view into a shared 64KB block) and the
    // parser reads past the view, so the same valid CV fails roughly four
    // times in five with "bad XRef entry". new Uint8Array() copies the exact
    // bytes into their own memory, which parses reliably.
    const out = await pdfParse(new Uint8Array(file.buffer));
    return out.text;
  }
  if (name.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const out = await mammoth.extractRawText({ buffer: file.buffer });
    return out.value;
  }
  return file.buffer.toString('utf8'); // .txt / .md
}

app.post('/api/cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file came through — choose your CV and try again.' });
    const text = (await extractText(req.file)).trim();
    if (text.length < 50) return res.status(400).json({ error: "We couldn't read enough words out of that file. A PDF, a Word file or plain text works best." });

    const profile = await llm.extractProfile(text);
    const db = load();
    db.cvText = text;
    db.profile = profile;
    saveCvOriginal(req.file.originalname, req.file.buffer); // keep the actual CV file in the profile's folder
    save();
    logActivity(`CV uploaded (${req.file.originalname}) — profile extracted: ${profile.skills.length} skills found`, 'cv');
    res.json({ profile, mockMode: !llm.hasKey() });
  } catch (err) {
    console.error('CV upload failed:', err);
    // pdf-parse / mammoth throw library-speak when a file is malformed. Anything
    // from the writing arrives already written for a person (err.plain), so pass
    // that through rather than wrongly blaming the file.
    res.status(500).json({
      error: err.plain ? err.message : "We couldn't read that file. Try a PDF, a Word file or plain text."
    });
  }
});

app.get('/api/profile', (req, res) => {
  const db = load();
  res.json({ profile: db.profile, mockMode: !llm.hasKey() });
});

// User-edited profile (from the editable text box)
app.put('/api/profile', (req, res) => {
  const { profile } = req.body;
  if (!profile || typeof profile !== 'object') return res.status(400).json({ error: 'Those details did not come through — try again.' });
  const db = load();
  db.profile = profile;
  save();
  logActivity('Profile edited and saved', 'cv');
  res.json({ profile });
});

// ---------- Job search ----------

app.post('/api/jobs/search', async (req, res) => {
  try {
    res.json(await discover(req.body.query));
  } catch (err) {
    console.error('job search failed:', err);
    res.status(err.message.includes('CV first') ? 400 : 500).json({ error: err.message });
  }
});

app.post('/api/jobs/auto-search', async (req, res) => {
  try {
    res.json(await autoSearchTick(true));
  } catch (err) {
    console.error('auto-search failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Batch pipeline (manual mode: 3 gated steps) ----------

app.post('/api/batch/fetch', async (req, res) => {
  try {
    res.json(await batch.fetchBatch(Number(req.body.target) || undefined));
  } catch (err) {
    res.status(err.message.includes('CV first') ? 400 : 500).json({ error: err.message });
  }
});

app.post('/api/batch/approve', (req, res) => {
  res.json(batch.approveAll());
});

app.post('/api/batch/generate', async (req, res) => {
  try {
    res.json(await batch.generateAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/batch/send', async (req, res) => {
  try {
    res.json(await batch.sendAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Feedback: appended to the chosen step's system prompt (find | cv | email)
// so the AI learns the user's preferences for that step from then on.
app.post('/api/feedback', (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write the rule first — one line is plenty.' });
  const kind = ['find', 'cv', 'email'].includes(req.body.kind) ? req.body.kind : 'email';
  const field = { find: 'promptFind', cv: 'promptCV', email: 'promptEmail' }[kind];
  const db = load();
  db.settings = db.settings || {};
  db.settings[field] = ((db.settings[field] || '').trim() + '\n- ' + text).trim();
  save();
  const label = { find: 'job finding', cv: 'CV writing', email: 'email writing' }[kind];
  logActivity(`AI instruction for ${label} added: "${text.slice(0, 70)}${text.length > 70 ? '…' : ''}"`, 'settings');
  res.json({ ok: true, kind });
});

// ---------- Sync: send all due follow-ups + read inbox + update board ----------

app.post('/api/sync', async (req, res) => {
  try {
    const followupsSent = await processFollowUps();
    let inbox = null, inboxError = null;
    if (email.isConfigured()) {
      try {
        inbox = await syncInbox();
        logActivity(`Inbox synced: ${inbox.checked} applications checked, ${inbox.repliesFound} replies found`, 'reply');
      } catch (err) {
        inboxError = err.message;
        console.error('inbox sync failed:', err.message);
      }
    }
    res.json({ followupsSent, inbox, inboxError });
  } catch (err) {
    console.error('sync failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Profiles (apply with different CVs/personas) ----------

app.get('/api/profiles', (req, res) => {
  res.json({ profiles: listProfiles() });
});

app.post('/api/profiles', (req, res) => {
  const id = createProfile();
  logActivity('New profile created — upload a CV for it', 'cv');
  res.json({ id, profiles: listProfiles() });
});

app.patch('/api/profiles/:id', (req, res) => {
  try {
    renameProfile(req.params.id, req.body.label);
    res.json({ profiles: listProfiles() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/profiles/:id/activate', (req, res) => {
  try {
    switchProfile(req.params.id);
    res.json({ profiles: listProfiles() });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/profiles/:id', (req, res) => {
  try {
    deleteProfile(req.params.id);
    res.json({ profiles: listProfiles() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Improvement reports (auto feedback) ----------

app.get('/api/insights', (req, res) => {
  const db = load();
  res.json({
    reports: db.reports || [],
    appliedSinceReport: db.appliedSinceReport || 0,
    config: insights.insightsConfig()
  });
});

app.post('/api/insights/run', async (req, res) => {
  try {
    res.json(await insights.generateReport('manual request'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Applications / kanban ----------

app.get('/api/applications', (req, res) => {
  const db = load();
  res.json({ applications: db.applications, followUpDays: FOLLOW_UP_DAYS, now: now() });
});

app.patch('/api/applications/:id', (req, res) => {
  const db = load();
  const a = db.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "We can't find that one — it may have been removed." });
  const { status, notes, recipientEmail, manualApplied } = req.body;
  if (manualApplied) {
    // "I applied on the platform" confirmation from the Your-action column
    a.status = 'applied';
    if (!a.appliedAt) a.appliedAt = now();
    a.applicationSent = { at: now(), manual: true, to: null };
    logActivity(`✋→✓ You applied on the platform: ${a.title} at ${a.company} — now tracking it`, 'apply');
    insights.afterApplies(1).catch(err => console.error('insights hook failed:', err.message));
  } else if (status) {
    a.status = status;
    if (status === 'applied' && !a.appliedAt) a.appliedAt = now();
    logActivity(`${a.title} at ${a.company} moved to "${status}"`, 'move');
  }
  if (notes !== undefined) a.notes = notes;
  if (recipientEmail !== undefined) {
    a.recipientEmail = recipientEmail.trim();
    a.applyPath = a.recipientEmail ? 'email' : 'manual';
    // Adding an address to a "Your action" card puts it back on the email path —
    // but only if JobPilot is the one who sends. batch.sendPath() is the single
    // place that decides, so this can never disagree with the batch.
    if (a.tailored && ['ready', 'action'].includes(a.status)) a.status = batch.sendPath(a);
  }
  save();
  res.json({ application: a });
});

// Bulk-confirm manual applies: every "Your action" card the user says they
// applied to moves to Applied and starts being tracked.
app.post('/api/applications/mark-all-applied', (req, res) => {
  const db = load();
  let n = 0;
  for (const a of db.applications) {
    if (a.status !== 'action') continue;
    a.status = 'applied';
    if (!a.appliedAt) a.appliedAt = now();
    a.applicationSent = { at: now(), manual: true, to: null };
    n++;
  }
  save();
  if (n) {
    logActivity(`✋→✓ ${n} platform application${n > 1 ? 's' : ''} confirmed as applied — now tracked with follow-up reminders`, 'apply');
    insights.afterApplies(n).catch(err => console.error('insights hook failed:', err.message));
  }
  res.json({ applied: n });
});

// Record a manual follow-up as done (day 3/5/10 reminder on platform applies)
app.post('/api/applications/:id/followup-done', (req, res) => {
  const db = load();
  const a = db.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "We can't find that one — it may have been removed." });
  const day = Number(req.body?.day);
  if (!FOLLOW_UP_DAYS.includes(day)) return res.status(400).json({ error: "That isn't one of the reminder days we use." });
  a.followups = a.followups || [];
  if (!a.followups.some(f => f.day === day)) {
    a.followups.push({ day, sentAt: now(), manual: true });
    if (a.status === 'applied') a.status = 'followup';
    logActivity(`✓ Day-${day} follow-up marked done (on platform) for ${a.title} at ${a.company}`, 'followup');
  }
  save();
  res.json({ application: a });
});

// Tailored CV as a downloadable PDF — for manual applies where the platform
// asks for a CV upload. Same rendering as the email attachment.
app.get('/api/applications/:id/cv.pdf', async (req, res) => {
  try {
    const db = load();
    const a = db.applications.find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "We can't find that one — it may have been removed." });
    if (!a.tailored?.cv) return res.status(400).json({ error: 'There is nothing written for this one yet.' });
    const { cvToPdfBuffer, cvFileName } = require('./pdf');
    const buf = await cvToPdfBuffer(a.tailored.cv, { name: db.profile?.name });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${cvFileName(db.profile?.name, a.company, a.title)}"`);
    res.send(buf);
  } catch (err) {
    console.error('CV PDF failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/applications/:id', (req, res) => {
  const db = load();
  db.applications = db.applications.filter(x => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post('/api/applications/:id/tailor', async (req, res) => {
  try {
    const db = load();
    const a = db.applications.find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "We can't find that one — it may have been removed." });
    if (!db.profile) return res.status(400).json({ error: "We need your CV first — it's what every application is written from." });

    const feedback = String(req.body?.feedback || '').trim();
    a.tailored = await llm.tailorApplication(db.profile, db.cvText || '', a, feedback);
    // same honesty gate as the batch: no invented claims go out
    if (db.settings?.factCheck !== false && llm.hasKey()) {
      const check = await llm.reviewTailored(db.profile, db.cvText || '', a, a.tailored, feedback);
      a.qualityCheck = { ok: check.ok, problems: check.problems, checked: check.checked, at: now() };
      if (!check.ok) {
        if (check.cv) a.tailored.cv = check.cv;
        if (check.email_body) a.tailored.email_body = check.email_body;
      }
    }
    a.tailoredAt = now();
    if (['discovered', 'approved'].includes(a.status)) a.status = a.recipientEmail ? 'ready' : 'action';
    save();
    logActivity(feedback
      ? `Revised CV/email for ${a.title} at ${a.company} per your feedback: "${feedback.slice(0, 60)}${feedback.length > 60 ? '…' : ''}"`
      : `Tailored CV + email generated for ${a.title} at ${a.company}`, 'tailor');
    res.json({ application: a });
  } catch (err) {
    console.error('tailor failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/applications/:id/apply', async (req, res) => {
  try {
    const db = load();
    const a = db.applications.find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "We can't find that one — it may have been removed." });
    if (!a.tailored) return res.status(400).json({ error: 'Write the CV and the message for this one first, then it can go.' });

    // Two things JobPilot must never do: send in somebody's name when they said
    // they would send it themselves, and record an application as gone when
    // there was nobody to send it to. Either way the card becomes theirs to act
    // on — written, ready, and honestly labelled.
    if (sendingMode() === 'myself' || !a.recipientEmail) {
      a.status = 'action';
      save();
      return res.status(400).json({
        error: sendingMode() === 'myself'
          ? "You chose to send your applications yourself, so we haven't emailed this one. It's written and waiting — copy the message, take the CV, and tell us once it has gone."
          : "There's nobody to send this one to yet. Put an address in the box above, or apply on their own site and tell us you've done it."
      });
    }

    // don't email about a posting that died since discovery
    const alive = await require('./verify').verifyJobLive(a);
    if (!alive.live) {
      a.status = 'closed';
      a.notes = ((a.notes || '') + `\nExpired before applying: ${alive.reason}`).trim();
      save();
      logActivity(`Skipped ${a.title} at ${a.company} — ${alive.reason}`, 'move');
      return res.status(409).json({ error: `We didn't send it — ${alive.reason}. This job is closed now, so nothing more happens with it.` });
    }

    const { cvToPdfBuffer, cvFileName } = require('./pdf');
    const attachments = [];
    try {
      attachments.push({
        filename: cvFileName(db.profile?.name, a.company, a.title),
        content: await cvToPdfBuffer(a.tailored.cv, { name: db.profile?.name })
      });
    } catch (err) { console.error('CV PDF failed, sending text fallback:', err.message); }
    const result = await email.sendEmail({
      to: a.recipientEmail,
      subject: a.tailored.email_subject,
      body: a.tailored.email_body + (attachments.length ? '' : '\n\n---\n' + a.tailored.cv),
      attachments
    });
    a.status = 'applied';
    a.appliedAt = now();
    a.applicationSent = { at: now(), ...result, cvAttached: !!attachments.length };
    save();
    // a drawer-send counts toward the open run (and lets it settle when done)
    if (load().currentRun) {
      try { require('./runs').addToRun(result.simulated ? { simulated: 1 } : { sent: 1 }); } catch { /* best-effort */ }
    }
    logActivity(
      `Application ${result.simulated ? 'sent (simulated)' : `emailed to ${result.to}`} for ${a.title} at ${a.company} — follow-ups scheduled for day ${FOLLOW_UP_DAYS.join(', ')}`,
      'apply'
    );
    insights.afterApplies(1).catch(err => console.error('insights hook failed:', err.message));
    res.json({ application: a, simulated: result.simulated });
  } catch (err) {
    console.error('apply failed:', err);
    res.status(500).json({ error: err.message || "That one didn't go out. Nothing is lost — try again in a moment." });
  }
});

// ---------- Settings ----------

// First-run wizard state, stored inside the ordinary settings object so there
// is exactly one persistence path. `needed` is the server's judgment on whether
// this install should be walked through setup:
//   - already finished (or deliberately skipped) → never again
//   - stopped part-way through → resume at that step, even after a restart
//   - otherwise only when the install is genuinely untouched, so an existing
//     user with a CV, applications or settings of their own is never dragged in.
function onboardingState(s) {
  const ob = s.onboarding || {};
  const db = load();
  const configured = !!(s.groqKey || s.openaiKey || s.anthropicKey || s.provider || s.model ||
    s.smtpUser || s.apifyToken || s.atsCompanies || s.adzunaAppId ||
    (s.jobTitles || []).length || (s.jobLocations || []).length);
  const untouched = !db.profile && !(db.applications || []).length && !configured;
  return {
    done: !!ob.done,
    step: ob.step || '',
    needed: !ob.done && (!!ob.step || untouched)
  };
}

app.get('/api/settings', (req, res) => {
  const s = load().settings || {};
  const w = welcomeSettings();
  const info = llm.providerInfo();
  const groqKey = s.groqKey || process.env.GROQ_API_KEY || '';
  const openaiKey = s.openaiKey || process.env.OPENAI_API_KEY || '';
  const anthropicKey = s.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
  res.json({
    provider: info.provider,
    model: s.model || '',
    activeModel: info.model,
    groqKeySet: !!groqKey,
    groqKeyMasked: groqKey ? groqKey.slice(0, 7) + '…' + groqKey.slice(-4) : '',
    openaiKeySet: !!openaiKey,
    openaiKeyMasked: openaiKey ? openaiKey.slice(0, 6) + '…' + openaiKey.slice(-4) : '',
    anthropicKeySet: !!anthropicKey,
    anthropicKeyMasked: anthropicKey ? anthropicKey.slice(0, 8) + '…' + anthropicKey.slice(-4) : '',
    claudeCode: llm.claudeCodeStatus(), // { available, plan, detail } — no key involved
    llmReady: info.hasKey,
    smtpUser: s.smtpUser || '',
    fromName: s.fromName || '',
    smtpConfigured: email.isConfigured(),
    customPrompt: s.customPrompt || '',
    promptFind: s.promptFind || '',
    promptCV: s.promptCV || '',
    promptEmail: s.promptEmail || '',
    mode: s.mode || 'manual',
    dailyTarget: batch.dailyTarget(),
    autoSearch: autoSearchConfig().enabled,
    autoSearchHours: autoSearchConfig().hours,
    lastAutoSearchAt: load().lastAutoSearchAt || null,
    firstRun: isFirstRun(),
    onboarding: onboardingState(s),
    // The revamped welcome questions. `welcomeNeeded` is false for anyone who
    // was already using JobPilot before these fields existed — see db.js.
    welcomeDone: w.done,
    welcomeNeeded: w.needed,
    sendingMode: w.sendingMode,
    dataDir: DATA_DIR,
    insightsEnabled: insights.insightsConfig().enabled,
    insightsEvery: insights.insightsConfig().every,
    insightsEmail: insights.insightsConfig().email,
    devFeedbackEnabled: require('./devfeedback').config().enabled,
    sources: {
      remotive: sourcesConfig().remotive,
      linkedin: sourcesConfig().linkedin,
      naukri: sourcesConfig().naukri,
      ats: sourcesConfig().ats,
      adzuna: sourcesConfig().adzuna
    },
    apifyTokenSet: !!(s.apifyToken),
    apifyTokenMasked: s.apifyToken ? s.apifyToken.slice(0, 10) + '…' : '',
    atsCompanies: s.atsCompanies || '',
    adzunaAppId: s.adzunaAppId || '',
    adzunaKeySet: !!s.adzunaAppKey,
    adzunaCountry: s.adzunaCountry || 'in',
    autoMinScore: batch.autoMinScore(),
    factCheck: s.factCheck !== false,
    companyCooldownDays: s.companyCooldownDays ?? 14,
    jobTitles: Array.isArray(s.jobTitles) ? s.jobTitles : [],
    jobLocations: Array.isArray(s.jobLocations) ? s.jobLocations : (s.jobLocation ? [s.jobLocation] : []),
    maxJobAgeDays: s.maxJobAgeDays || 30,
    preferLowCompetition: !!s.preferLowCompetition,
    remoteOk: s.remoteOk !== false
  });
});

app.post('/api/settings', (req, res) => {
  const db = load();
  db.settings = db.settings || {};
  const { groqKey, openaiKey, anthropicKey, provider, model, smtpUser, smtpPass, fromName,
          autoSearch, autoSearchHours, customPrompt, mode, dailyTarget,
          sources, apifyToken } = req.body;
  if (sources !== undefined && typeof sources === 'object') {
    db.settings.sources = {
      remotive: sources.remotive !== false,
      linkedin: !!sources.linkedin,
      naukri: !!sources.naukri
    };
  }
  if (apifyToken !== undefined && apifyToken.trim()) db.settings.apifyToken = apifyToken.trim();
  if (req.body.atsCompanies !== undefined) {
    db.settings.atsCompanies = String(req.body.atsCompanies).trim();
    db.settings.atsDetected = {}; // re-probe boards when the list changes
    clearAtsCache();              // never serve the previous companies' cached jobs
  }
  if (req.body.adzunaAppId !== undefined) db.settings.adzunaAppId = String(req.body.adzunaAppId).trim();
  if (req.body.adzunaAppKey !== undefined && String(req.body.adzunaAppKey).trim()) db.settings.adzunaAppKey = String(req.body.adzunaAppKey).trim();
  if (req.body.adzunaCountry !== undefined) db.settings.adzunaCountry = String(req.body.adzunaCountry).trim().toLowerCase() || 'in';
  if (req.body.autoMinScore !== undefined) db.settings.autoMinScore = Math.min(95, Math.max(0, Number(req.body.autoMinScore) || 70));
  if (req.body.factCheck !== undefined) db.settings.factCheck = !!req.body.factCheck;
  if (req.body.companyCooldownDays !== undefined) db.settings.companyCooldownDays = Math.max(0, Number(req.body.companyCooldownDays) || 0);
  if (req.body.jobTitles !== undefined) {
    const list = Array.isArray(req.body.jobTitles)
      ? req.body.jobTitles
      : String(req.body.jobTitles).split(',');
    db.settings.jobTitles = list.map(t => String(t).trim()).filter(Boolean);
  }
  if (req.body.jobLocations !== undefined) {
    const list = Array.isArray(req.body.jobLocations)
      ? req.body.jobLocations
      : String(req.body.jobLocations).split(',');
    db.settings.jobLocations = list.map(l => String(l).trim()).filter(Boolean);
    delete db.settings.jobLocation; // retire the old single-value field
  }
  if (req.body.maxJobAgeDays !== undefined) db.settings.maxJobAgeDays = Math.max(1, Number(req.body.maxJobAgeDays) || 30);
  if (req.body.preferLowCompetition !== undefined) db.settings.preferLowCompetition = !!req.body.preferLowCompetition;
  if (req.body.remoteOk !== undefined) db.settings.remoteOk = !!req.body.remoteOk;
  if (groqKey !== undefined && groqKey.trim()) db.settings.groqKey = groqKey.trim();
  if (openaiKey !== undefined && openaiKey.trim()) db.settings.openaiKey = openaiKey.trim();
  if (anthropicKey !== undefined && anthropicKey.trim()) db.settings.anthropicKey = anthropicKey.trim();
  if (provider !== undefined) {
    db.settings.provider = ['openai', 'anthropic', 'claude_code'].includes(provider) ? provider : 'groq';
    // Check the CLI now rather than serving a stale "not found" from the cache
    // when the user has just installed it and switched to the subscription.
    llm.resetClaudeCodeProbe();
  }
  if (model !== undefined) db.settings.model = model.trim();
  if (smtpUser !== undefined) db.settings.smtpUser = smtpUser.trim();
  if (smtpPass !== undefined && smtpPass.trim()) db.settings.smtpPass = smtpPass.replace(/\s+/g, '');
  if (fromName !== undefined) db.settings.fromName = fromName.trim();
  if (autoSearch !== undefined) db.settings.autoSearch = !!autoSearch;
  if (autoSearchHours !== undefined) db.settings.autoSearchHours = Math.max(1, Number(autoSearchHours) || 6);
  if (customPrompt !== undefined) db.settings.customPrompt = String(customPrompt);
  if (req.body.promptFind !== undefined) db.settings.promptFind = String(req.body.promptFind);
  if (req.body.promptCV !== undefined) db.settings.promptCV = String(req.body.promptCV);
  if (req.body.promptEmail !== undefined) db.settings.promptEmail = String(req.body.promptEmail);
  if (mode !== undefined) db.settings.mode = mode === 'auto' ? 'auto' : 'manual';
  if (dailyTarget !== undefined) db.settings.dailyTarget = Math.max(1, Number(dailyTarget) || 50);
  if (req.body.insightsEnabled !== undefined) db.settings.insightsEnabled = !!req.body.insightsEnabled;
  if (req.body.devFeedbackEnabled !== undefined) db.settings.devFeedbackEnabled = !!req.body.devFeedbackEnabled;
  if (req.body.insightsEvery !== undefined) db.settings.insightsEvery = Math.max(5, Number(req.body.insightsEvery) || 50);
  if (req.body.insightsEmail !== undefined) db.settings.insightsEmail = String(req.body.insightsEmail).trim();
  // The welcome questions. `welcomeDone` is the "they've been through it" flag
  // and `sendingMode` is who presses send — see db.js for what an unset value
  // means for installs that predate both fields.
  const wasWelcomed = welcomeSettings().done;
  if (req.body.welcomeDone !== undefined) db.settings.welcomeDone = !!req.body.welcomeDone;
  if (req.body.sendingMode !== undefined) {
    db.settings.sendingMode = req.body.sendingMode === 'jobpilot' ? 'jobpilot' : 'myself';
  }
  // Setup-wizard progress. Written on every step so closing the browser mid-way
  // resumes exactly where the user stopped instead of starting over.
  const ob = req.body.onboarding;
  if (ob !== undefined && ob && typeof ob === 'object') {
    const prev = db.settings.onboarding || {};
    db.settings.onboarding = {
      step: ob.step !== undefined ? String(ob.step).slice(0, 32) : (prev.step || ''),
      done: ob.done !== undefined ? !!ob.done : !!prev.done,
      updatedAt: now()
    };
  }
  save();
  // Changing who presses send re-routes everything already written, straight
  // away: nothing may sit in "ready to email" once they've said they send.
  if (req.body.sendingMode !== undefined) batch.applySendingMode();
  // Answering five questions would otherwise post five "Settings updated" lines
  // into a brand-new user's activity feed — the first thing they ever see there.
  // Send `quiet: true` alongside a step-by-step save to keep it out of the feed.
  const quiet = ob !== undefined || req.body.quiet === true ||
                req.body.welcomeDone !== undefined || req.body.sendingMode !== undefined;
  if (!quiet) logActivity('Settings updated', 'settings');
  if (db.settings.onboarding?.done && ob !== undefined) {
    logActivity('Setup finished — JobPilot is ready to find jobs', 'settings');
  } else if (!wasWelcomed && welcomeSettings().done) {
    logActivity('Setup finished — JobPilot is ready to find jobs', 'settings');
  }
  const w = welcomeSettings();
  res.json({
    ok: true,
    onboarding: onboardingState(db.settings),
    welcomeDone: w.done,
    welcomeNeeded: w.needed,
    sendingMode: w.sendingMode
  });
});

// Does the configured AI actually work? The wizard's "Test it" button calls this
// after saving, so the answer reflects exactly what the app will use. It makes
// one small real request — a claimed-good key that 401s is the whole point.
// Nothing here logs, echoes or returns a key.
app.post('/api/settings/test-ai', async (req, res) => {
  const info = llm.providerInfo();
  const label = (llm.PROVIDERS[info.provider] || {}).label || info.provider;
  if (!info.hasKey) {
    return res.status(400).json({
      error: info.provider === 'claude_code'
        ? llm.claudeCodeStatus().detail
        : `Nothing is saved for ${label} yet — paste the code in and try again.`
    });
  }
  try {
    const out = await llm.extractProfile(
      'Alex Taylor\nalex@example.com\nSoftware Engineer, 3 years, JavaScript and SQL.'
    );
    if (!out || !Array.isArray(out.skills)) throw new Error('the answer came back in a form we could not read');
    logActivity(`AI connection test passed — ${label} (${info.model})`, 'settings');
    res.json({
      ok: true,
      message: info.subscription
        ? 'Working — JobPilot will write your CVs and messages through your Claude subscription, at no extra charge.'
        : `Working — JobPilot can write your CVs and messages, using ${label}.`
    });
  } catch (err) {
    const m = String(err.message || '');
    let plain = `That didn't work — ${m.slice(0, 160)}`;
    if (/not accepted|rejected|401|403|invalid.*key/i.test(m)) {
      plain = 'That code was not accepted. Check you copied the whole thing with no spaces, then try again.';
    } else if (/allowance|enough requests|limit|429|quota/i.test(m)) {
      plain = "This account's free allowance is used up for now. Try again later, or pick a different option above.";
    } else if (/took too long|timed out|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(m)) {
      plain = 'No answer came back — check your internet connection and try again.';
    } else if (/Claude/i.test(m)) {
      plain = m.slice(0, 200); // already says exactly what to do
    }
    res.status(400).json({ error: plain });
  }
});

app.post('/api/settings/test-email', async (req, res) => {
  try {
    if (!email.isConfigured()) return res.status(400).json({ error: 'Add your Gmail address and app password first' });
    const s = load().settings;
    await email.sendEmail({
      to: s.smtpUser,
      subject: 'JobPilot test email ✓',
      body: 'Your JobPilot email setup works. Application emails will be sent from this address.'
    });
    res.json({ ok: true, to: s.smtpUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Runs (per-run cost & outcome ledger) ----------

app.get('/api/runs', (req, res) => {
  res.json(require('./runs').listRuns(20));
});

// ---------- Stats ----------

app.get('/api/stats', (req, res) => {
  const db = load();
  const apps = db.applications;
  const byStatus = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const applied = apps.filter(a => a.appliedAt);
  const followupsSent = apps.reduce((n, a) => n + (a.followups?.length || 0), 0);
  const avgScore = apps.length ? Math.round(apps.reduce((n, a) => n + (a.matchScore || 0), 0) / apps.length) : 0;
  res.json({
    total: apps.length,
    byStatus,
    applied: applied.length,
    replied: apps.filter(a => a.replied || a.status === 'replied').length,
    followupsSent,
    avgScore,
    interviews: byStatus.interview || 0,
    offers: byStatus.offer || 0,
    activity: db.activity.slice(0, 30),
    mockMode: !llm.hasKey(),
    provider: llm.providerInfo(),
    mode: (db.settings?.mode) || 'manual',
    smtpConfigured: email.isConfigured(),
    hasProfile: !!db.profile,
    costTotalUSD: require('./costs').totals().totalUSD
  });
});

// ---------- Health check (used by smoke tests / uptime probes) ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mockMode: !llm.hasKey() });
});

// ---------- Reset current profile's data ----------

app.post('/api/demo/reset', (req, res) => {
  const db = load();
  db.profile = null; db.cvText = null; db.applications = [];
  db.activity = []; db.reports = []; db.appliedSinceReport = 0;
  db.runs = []; db.currentRun = null;
  db.lastAutoSearchAt = null;
  save();
  res.json({ ok: true });
});

// The Terminal window is a status display to the person who was told to leave it
// open, so this is the whole of what it says: where the app is, where their
// files are, whether the writer is connected, and where to look if something
// goes wrong. No stage names, no codes, no stack traces (see ./log).
function start() {
  const server = app.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    // Anything already written but no longer on the right path (an existing
    // store, or a mode changed while the app was closed) is re-routed once here.
    try { batch.applySendingMode(); } catch { /* never block start-up */ }
    console.log(`JobPilot is running. Open it at http://${shownHost}:${PORT}`);
    if (LAN) {
      console.log('Careful: anyone on your network can open this copy of JobPilot — read your CV, change your settings and send email as you. Close JobPilot and start it normally to keep it to this computer.');
    }
    console.log(`Your files are in ${DATA_DIR}${isFirstRun() ? ' — new here, so the questions will open in your browser.' : ' — your jobs and settings were found and loaded.'}`);
    const info = llm.providerInfo();
    if (info.hasKey) {
      console.log(`The writer is connected${info.subscription ? ' through your Claude subscription, so there is nothing more to pay.' : '.'}`);
    } else if (info.provider === 'claude_code') {
      // Chosen but unusable: say so plainly, so this doesn't look like it worked.
      console.log(`The writer is not ready yet. ${llm.claudeCodeStatus().detail} Until then JobPilot uses stand-in text and says so.`);
    } else {
      console.log('No writer is set up yet, so JobPilot uses stand-in text and says so. You can connect one in Settings.');
    }
    console.log(require('./log').where());
    console.log('Leave this window open while you use JobPilot.');
    startScheduler();
    startAutoSearch();
  });
  return server;
}

// Auto-start only when run directly, so tests can import `app` without binding.
if (require.main === module) start();

module.exports = { app, start };

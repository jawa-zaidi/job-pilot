const path = require('path');
const express = require('express');
const multer = require('multer');

const { load, save, now, logActivity, isFirstRun, DATA_DIR, saveCvOriginal,
        listProfiles, createProfile, switchProfile, deleteProfile, renameProfile } = require('./db');
const llm = require('./llm');
const email = require('./email');
const { sourcesConfig } = require('./jobs');
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
    const out = await pdfParse(file.buffer);
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
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: cv)' });
    const text = (await extractText(req.file)).trim();
    if (text.length < 50) return res.status(400).json({ error: 'Could not extract enough text from that file' });

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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profile', (req, res) => {
  const db = load();
  res.json({ profile: db.profile, mockMode: !llm.hasKey() });
});

// User-edited profile (from the editable text box)
app.put('/api/profile', (req, res) => {
  const { profile } = req.body;
  if (!profile || typeof profile !== 'object') return res.status(400).json({ error: 'Invalid profile' });
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
  if (!text) return res.status(400).json({ error: 'Empty feedback' });
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
  if (!a) return res.status(404).json({ error: 'Not found' });
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
    // adding an address to a "Your action" card puts it back on the email path
    if (a.recipientEmail && a.status === 'action' && a.tailored) a.status = 'ready';
    if (!a.recipientEmail && a.status === 'ready') a.status = 'action';
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
  if (!a) return res.status(404).json({ error: 'Not found' });
  const day = Number(req.body?.day);
  if (!FOLLOW_UP_DAYS.includes(day)) return res.status(400).json({ error: 'Invalid follow-up day' });
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
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!a.tailored?.cv) return res.status(400).json({ error: 'Generate the tailored CV first' });
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
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!db.profile) return res.status(400).json({ error: 'Upload your CV first' });

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
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!a.tailored) return res.status(400).json({ error: 'Generate the tailored CV & email first' });

    // don't email about a posting that died since discovery
    const alive = await require('./verify').verifyJobLive(a);
    if (!alive.live) {
      a.status = 'closed';
      a.notes = ((a.notes || '') + `\nExpired before applying: ${alive.reason}`).trim();
      save();
      logActivity(`Skipped ${a.title} at ${a.company} — ${alive.reason}`, 'move');
      return res.status(409).json({ error: `This posting is no longer live (${alive.reason}) — moved to Closed.` });
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
    res.status(500).json({ error: 'Email send failed: ' + err.message });
  }
});

// ---------- Settings ----------

app.get('/api/settings', (req, res) => {
  const s = load().settings || {};
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
  if (provider !== undefined) db.settings.provider = ['openai', 'anthropic'].includes(provider) ? provider : 'groq';
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
  save();
  logActivity('Settings updated', 'settings');
  res.json({ ok: true });
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

function start() {
  const server = app.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`JobPilot running at http://${shownHost}:${PORT}`);
    if (LAN) {
      console.log('⚠️  LAN mode ON — the app is reachable by anyone on your network (they could read your CV, change settings and send email from your Gmail). Unset HOST/JOBPILOT_LAN to bind to localhost only.');
    }
    console.log(`Data folder: ${DATA_DIR} ${isFirstRun() ? '(new install — setup will open in the browser)' : '(existing data loaded)'}`);
    const info = llm.providerInfo();
    console.log(`LLM: ${info.hasKey ? `${info.provider} (${info.model})` : 'MOCK MODE (no API key)'}`);
    startScheduler();
    startAutoSearch();
  });
  return server;
}

// Auto-start only when run directly, so tests can import `app` without binding.
if (require.main === module) start();

module.exports = { app, start };

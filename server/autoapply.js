// Browser-assisted job applications, driven through the user's OWN Chrome.
//
// SAFETY MODEL (especially LinkedIn):
//   • We drive the user's real, already-logged-in Chrome — never a scripted
//     login (automated logins are the #1 ban trigger) and never headless
//     (headless is easily fingerprinted). The session lives in a persistent
//     profile folder so the user logs in once, by hand.
//   • The human always makes the final click. "assisted" mode just opens the
//     application page (fast, because they're logged in and the tailored CV is
//     ready); "autofill" mode best-effort fills obvious fields and still leaves
//     the Submit to the user.
//   • Human-like pacing + a conservative per-day cap, so activity never spikes
//     into obvious-bot territory.
//   • LinkedIn automation is against LinkedIn's ToS, so it stays behind an
//     explicit risk-acceptance flag. Greenhouse / Lever / other ATS forms have
//     no login and carry no such risk, so they don't need it.
//
// This module deliberately NEVER submits an application on its own.

const path = require('path');
const { load, save, logActivity, DATA_DIR } = require('./db');

const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile'); // persistent login
const DEFAULTS = { dailyCap: 15, minDelayMs: 3500, maxDelayMs: 11000 };

let _context = null; // one long-lived browser context (keeps the user logged in)

function cfg() {
  const s = load().settings || {};
  return {
    enabled: !!s.autoApplyEnabled,
    linkedin: !!s.autoApplyLinkedIn,
    riskAccepted: !!s.autoApplyRiskAccepted,
    mode: s.autoApplyMode === 'autofill' ? 'autofill' : 'assisted',
    dailyCap: Math.max(1, Number(s.autoApplyDailyCap) || DEFAULTS.dailyCap)
  };
}

function isLinkedIn(url) { return /(^|\.)linkedin\.com/i.test(String(url || '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function jitter() { return DEFAULTS.minDelayMs + Math.floor(Math.random() * (DEFAULTS.maxDelayMs - DEFAULTS.minDelayMs)); }

// Per-day counter, stored in settings so the cap survives restarts.
function today() { return new Date().toISOString().slice(0, 10); }
function usage() {
  const s = load().settings || {};
  if (s.autoApplyDay !== today()) return { day: today(), count: 0 };
  return { day: s.autoApplyDay, count: s.autoApplyCount || 0 };
}
function bumpUsage() {
  const db = load();
  db.settings = db.settings || {};
  const u = usage();
  db.settings.autoApplyDay = u.day;
  db.settings.autoApplyCount = u.count + 1;
  save();
}

async function getContext() {
  if (_context && _context._jpAlive !== false) return _context;
  let pw;
  try {
    pw = require('playwright-core');
  } catch {
    throw new Error('Playwright is not installed. Run `npm install` to enable browser assisted-apply.');
  }
  try {
    _context = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,           // headless is fingerprintable → detectable
      channel: 'chrome',         // the user's real Chrome, per their choice
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled']
    });
  } catch (err) {
    throw new Error(
      'Could not launch Google Chrome. Install Chrome from google.com/chrome (the assisted browser uses your own Chrome so you stay logged in as yourself). ' +
      `Details: ${String(err.message || err).slice(0, 160)}`
    );
  }
  _context._jpAlive = true;
  _context.on('close', () => { if (_context) _context._jpAlive = false; });
  return _context;
}

// Best-effort fill of the obvious fields on common ATS forms. Never submits.
async function autofillCommon(page, profile) {
  const name = profile?.name || '';
  const email = profile?.email || '';
  const [first, ...rest] = name.split(/\s+/);
  const last = rest.join(' ');
  const trySet = async (selectors, value) => {
    if (!value) return;
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      try {
        if (await el.count() && await el.isVisible()) { await el.fill(value); await sleep(300 + Math.random() * 500); return; }
      } catch { /* selector not present — try the next */ }
    }
  };
  await trySet(['input[name*="first" i]', 'input[id*="first" i]', 'input[autocomplete="given-name"]'], first);
  await trySet(['input[name*="last" i]', 'input[id*="last" i]', 'input[autocomplete="family-name"]'], last);
  await trySet(['input[name*="name" i]:not([name*="first" i]):not([name*="last" i])', 'input[autocomplete="name"]'], name);
  await trySet(['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]'], email);
}

// Open one application in the user's browser. Enforces consent, cap and pacing.
// Returns { opened, mode, remainingToday }. Never clicks Submit.
async function apply(app) {
  const c = cfg();
  if (!c.enabled) throw new Error('Browser assisted-apply is off. Turn it on in Settings → Automation.');
  if (!app || !app.url) throw new Error('This job has no application URL to open.');
  if (isLinkedIn(app.url)) {
    if (!c.linkedin) throw new Error('LinkedIn assisted-apply is off. Enable it in Settings (it needs you to accept the risk first).');
    if (!c.riskAccepted) throw new Error('You must accept the LinkedIn automation risk in Settings before using it.');
  }
  const u = usage();
  if (u.count >= c.dailyCap) {
    throw new Error(`Daily assisted-apply cap reached (${c.dailyCap}). This pacing is deliberate — spiking activity is what gets accounts flagged. Try again tomorrow or raise the cap in Settings.`);
  }

  const context = await getContext();
  await sleep(jitter()); // human-like gap before acting
  const page = await context.newPage();
  await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  if (c.mode === 'autofill' && !isLinkedIn(app.url)) {
    // Only auto-fill straightforward ATS forms; LinkedIn stays fully manual.
    try { await autofillCommon(page, load().profile); } catch { /* best-effort */ }
  }
  try { await page.bringToFront(); } catch { /* non-fatal */ }

  bumpUsage();
  logActivity(`Assisted-apply opened "${app.title}" at ${app.company} in your browser (${c.mode}) — review and click Apply yourself`, 'apply');
  return { opened: true, mode: c.mode, remainingToday: Math.max(0, c.dailyCap - usage().count) };
}

module.exports = { apply, cfg, isLinkedIn, usage };

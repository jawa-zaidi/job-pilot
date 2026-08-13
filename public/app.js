// JobPilot dashboard
//
// THE FOUR BUCKETS. The store keeps nine internal statuses; nobody outside this
// file ever needs to know that. Every job lands in exactly one of these four,
// and the labels are the only names a person ever reads:
//
//   Needs you    action                                     — you have to do something
//   Good news    replied, interview, offer                  — a human answered
//   We're waiting applied, followup, ready, approved, discovered — nothing to do
//   Closed       closed, rejected                           — over
//
// `color` and `dot` are the group marker (a token, never a hex, so both themes
// work). Anything with an unrecognised status falls into "We're waiting" rather
// than vanishing — see bucketise().
const COLUMNS = [
  { id: 'needsyou', label: 'Needs you',     statuses: ['action'],
    color: 'var(--accent)', dot: 'jp-dot--accent' },
  { id: 'goodnews', label: 'Good news',     statuses: ['replied', 'interview', 'offer'],
    color: 'var(--good)',   dot: 'jp-dot--good' },
  { id: 'waiting',  label: "We're waiting", statuses: ['applied', 'followup', 'ready', 'approved', 'discovered'],
    color: 'var(--ink2)',   dot: '' },
  { id: 'closed',   label: 'Closed',        statuses: ['closed', 'rejected'],
    color: 'var(--line)',   dot: 'jp-dot--quiet' }
];
const WAITING_BUCKET = 2; // where an unknown status goes

let state = { applications: [], stats: null, openId: null, settings: null, lastRunCost: null, lastRunLabel: '' };
let filters = { stage: 'all', from: '', to: '' };

const $ = s => document.querySelector(s);

/* ===========================================================================
 * APP SHELL — light/dark, the screen router, and the shared data feed.
 *
 * Everything a screen needs to plug itself in lives on `window.JobPilot`:
 *
 *   JobPilot.screens.register('jobs', { onEnter(el), onLeave(el) })
 *       Called every time that screen is shown / hidden. `el` is the screen's
 *       <section>. Register at load time; if the screen is already showing,
 *       onEnter fires straight away so nothing depends on load order.
 *
 *   JobPilot.screens.go('jobs')     move to a screen (also updates the address bar)
 *   JobPilot.screens.current()      which screen is showing
 *   JobPilot.mount('jobs')          the empty <div> inside it to render into
 *
 *   JobPilot.data                   last snapshot from the server, or null
 *   JobPilot.refresh()              re-fetch now; resolves when the data has landed
 *   document.addEventListener('jobpilot:data', e => …e.detail)
 *                                   fires after every successful refresh
 *
 *   JobPilot.theme.get() / .set('dark') / .toggle()
 *
 * The screen showing is kept in the address bar (#/home, #/jobs, …) so a reload
 * lands back where the person was.
 * ======================================================================== */
const JobPilot = (window.JobPilot = {});

(() => {
  // ---------- Light or dark ----------
  // The very first application happens in the inline script in index.html,
  // before the stylesheet loads, so the window never flashes the wrong colours.
  const THEME_KEY = 'jp_theme';
  const themeOf = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

  function setTheme(next) {
    const t = next === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* storage disabled — this session only */ }
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = t === 'dark' ? '☾' : '☀';
      btn.title = t === 'dark' ? 'Switch to the light look' : 'Switch to the dark look';
    }
    document.dispatchEvent(new CustomEvent('jobpilot:theme', { detail: { theme: t } }));
    return t;
  }

  JobPilot.theme = {
    get: themeOf,
    set: setTheme,
    toggle: () => setTheme(themeOf() === 'dark' ? 'light' : 'dark')
  };
  setTheme(themeOf()); // paints the right icon on the toggle

  // ---------- The screen router ----------
  // A screen is any <section class="jp-screen" data-screen="NAME"> in the page.
  // `data-chrome="off"` on the section hides the header while it is showing.
  const TITLES = {
    home: 'Home', jobs: 'My jobs', report: "How it's going",
    settings: 'Settings', you: 'You', welcome: 'Welcome'
  };
  const HOME = 'home';
  const handlers = {};
  let showing = null;

  const sectionOf = name => document.querySelector(`.jp-screen[data-screen="${name}"]`);
  const exists = name => !!name && !!sectionOf(name);

  function fromHash() {
    const m = /^#\/([a-z-]+)/.exec(location.hash || '');
    return m && exists(m[1]) ? m[1] : null;
  }

  function show(name) {
    if (!exists(name)) name = HOME;
    if (name === showing) return;
    const leaving = showing;
    if (leaving && handlers[leaving]?.onLeave) {
      try { handlers[leaving].onLeave(sectionOf(leaving)); }
      catch (err) { console.warn(`[screen ${leaving}] onLeave failed:`, err); }
    }
    showing = name;

    for (const el of document.querySelectorAll('.jp-screen')) {
      el.classList.toggle('is-active', el.dataset.screen === name);
    }
    for (const btn of document.querySelectorAll('[data-go]')) {
      btn.classList.toggle('is-active', btn.dataset.go === name);
    }
    const el = sectionOf(name);
    document.body.classList.toggle('jp-chrome-off', el.dataset.chrome === 'off');
    document.title = `${TITLES[name] || 'JobPilot'} · JobPilot`;
    window.scrollTo(0, 0);

    if (handlers[name]?.onEnter) {
      try { handlers[name].onEnter(el); }
      catch (err) { console.warn(`[screen ${name}] onEnter failed:`, err); }
    }
    document.dispatchEvent(new CustomEvent('jobpilot:screen', { detail: { screen: name, from: leaving } }));
  }

  function go(name) {
    if (!exists(name)) name = HOME;
    const hash = '#/' + name;
    if (location.hash === hash) show(name);
    else location.hash = hash;   // the hashchange listener calls show()
  }

  JobPilot.screens = {
    register(name, spec = {}) {
      if (!exists(name)) { console.warn(`[router] no screen called "${name}" in the page`); return; }
      handlers[name] = spec;
      if (showing === name && spec.onEnter) {
        try { spec.onEnter(sectionOf(name)); }
        catch (err) { console.warn(`[screen ${name}] onEnter failed:`, err); }
      }
    },
    go,
    current: () => showing,
    list: () => [...document.querySelectorAll('.jp-screen')].map(el => el.dataset.screen)
  };
  JobPilot.mount = name => document.getElementById('mount-' + name);

  window.addEventListener('hashchange', () => show(fromHash() || HOME));

  // Any element with data-go="screen" navigates — header nav, links inside a
  // screen, an empty state's "have a look at your jobs" button, anything.
  document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-go]');
    if (!trigger) return;
    e.preventDefault();
    go(trigger.dataset.go);
  });

  document.getElementById('themeToggle')?.addEventListener('click', () => JobPilot.theme.toggle());

  show(fromHash() || HOME);
})();

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast'), 6000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)
      ? JSON.stringify(opts.body) : opts.body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtCost(usd) {
  if (!usd) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(usd < 1 ? 3 : 2);
}
// appended to a toast after a run
function costSuffix(cost) {
  if (!cost || !cost.usd) return '';
  const parts = [];
  if (cost.ai) parts.push(`AI ${fmtCost(cost.ai)}`);
  if (cost.source) parts.push(`sources ${fmtCost(cost.source)}`);
  return `  ·  cost ${fmtCost(cost.usd)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

// What a run cost, said the way a person would read it. costSuffix() is the
// old dashboard's version and breaks it down by AI vs source.
function costWords(cost) {
  const usd = cost && (cost.usd || 0);
  if (!usd) return '';
  return usd < 0.01 ? ' It cost less than a penny.' : ` It cost ${'$' + usd.toFixed(2)}.`;
}

function stageOf(a) {
  if (a.status === 'rejected') return 'rejected';
  if (a.status === 'closed') return 'no_response';
  if (a.status === 'offer' || a.status === 'interview') return 'interview';
  if (a.replied || a.status === 'replied') return 'replied';
  if (a.appliedAt) {
    const n = (a.followups || []).length;
    return n === 0 ? 'fresh' : `fu${Math.min(n, 3)}`;
  }
  return 'pre';
}

function matchesFilters(a) {
  if (filters.stage !== 'all' && stageOf(a) !== filters.stage) return false;
  if (filters.from || filters.to) {
    if (!a.appliedAt) return false;
    const d = new Date(a.appliedAt).toISOString().slice(0, 10);
    if (filters.from && d < filters.from) return false;
    if (filters.to && d > filters.to) return false;
  }
  return true;
}

// ---------- Refresh ----------

async function refresh() {
  const [appsData, stats, settings, profilesData, runsData] = await Promise.all([
    api('/api/applications'), api('/api/stats'), api('/api/settings'), api('/api/profiles'),
    api('/api/runs').catch(() => ({ runs: [] }))
  ]);
  state.applications = appsData.applications;
  state.stats = stats;
  state.settings = settings;
  state.currentRun = runsData.current || null;

  // The single snapshot every screen reads. Published before anything renders,
  // so one screen failing can never stop another screen seeing the data.
  JobPilot.data = {
    applications: state.applications,
    stats,
    settings,
    profiles: profilesData.profiles,
    runs: runsData.runs || [],
    currentRun: state.currentRun
  };

  // The pre-revamp dashboard. Fenced off on purpose: the day its markup finally
  // comes out of index.html, the snapshot above must still reach the new
  // screens instead of the whole refresh dying on a missing element.
  try {
    renderStats(stats);
    renderBoard();
    renderSmartButton();
    renderCostLine();
    renderProfiles(profilesData.profiles);
    renderActivity(stats.activity);
    renderRuns(runsData);
    renderRunStatus();
    renderProfileCard();
    renderSideStatus(settings);
    const badge = $('#modeBadge');
    if (badge) {
      // The subscription provider's internal key reads badly in the badge; the
      // other three already read fine as-is.
      const providerName = stats.provider.provider === 'claude_code' ? 'Claude subscription' : stats.provider.provider;
      badge.textContent = stats.mockMode ? 'AI: mock mode' : `AI: ${providerName} · ${stats.provider.model}`;
      badge.className = 'badge ' + (stats.mockMode ? 'mock' : 'live');
    }
    const modeSel = $('#modeSelect');
    if (modeSel) modeSel.value = settings.mode;
  } catch (err) {
    console.warn('[legacy dashboard] render skipped:', err);
  }

  document.dispatchEvent(new CustomEvent('jobpilot:data', { detail: JobPilot.data }));

  // Keep the open job panel in step with the new data — and close it if the job
  // itself has gone (deleted here, or on another tab).
  if (state.openId) {
    const a = state.applications.find(x => x.id === state.openId);
    if (a) renderDrawer(a); else closeDrawer();
  }
}
JobPilot.refresh = () => refresh();

// ---------- The smart button ----------

function pipelineCounts() {
  const by = {};
  for (const a of state.applications) by[a.status] = (by[a.status] || 0) + 1;
  return { disc: by.discovered || 0, appr: by.approved || 0, ready: by.ready || 0, action: by.action || 0 };
}

// ---------- Who presses send ----------
//
// One answer, read everywhere, so no screen can offer something the server will
// refuse (or worse, quietly do). 'myself' is what an unset value means, and it
// is what the server's own `sendingMode()` decides too — see server/db.js.
function sendsHerself(data) {
  const s = (data || JobPilot.data || {}).settings || state.settings || {};
  return s.sendingMode !== 'jobpilot';
}

// JobPilot only chases by email what it actually sent by email. Everything else
// — no address, applied by hand, or "I'll send them myself" — is the person's
// own nudge to send, and the app says so instead of pretending.
function chasedByUs(a) {
  return !sendsHerself() && !!a.recipientEmail && !(a.applicationSent && a.applicationSent.manual);
}

// The CV is the one thing nothing works without.
const hasCv = data => !!((data || JobPilot.data || {}).stats || state.stats || {}).hasProfile;

// The one button that moves the whole thing forward: find → write → send. It
// lives on Home and says, in plain words, what pressing it will do next. The
// element itself is never re-created (renderHome only ever moves it between
// slots), so this listener and the deferred AI/email questions keep working.
function renderSmartButton() {
  const { disc, appr, ready: readyCount } = pipelineCounts();
  const btn = $('#smartBtn');
  if (!btn) return;
  const n = disc + appr;
  // "Send this application" is only ever honest when JobPilot is the sender.
  // When the person sends, those applications are handed to them under
  // "Needs you" and the button never claims it will send anything.
  const ready = sendsHerself() ? 0 : readyCount;
  if (!hasCv()) {
    // Without a CV the button used to start a search that could only fail. It
    // now leads to the one thing that unblocks everything else.
    btn.dataset.action = 'cv';
    btn.textContent = 'Add your CV';
  } else if (ready > 0) {
    btn.dataset.action = 'send';
    btn.textContent = ready > 1 ? `Send ${ready} applications` : 'Send this application';
  } else if (n > 0) {
    btn.dataset.action = 'generate';
    btn.textContent = n > 1 ? `Write ${n} applications` : 'Write this application';
  } else {
    btn.dataset.action = 'fetch';
    btn.textContent = state.applications.length ? 'Find more jobs' : 'Find my first jobs';
  }
  btn.className = 'jp-btn jp-btn--primary jp-btn--sm';
  // `data-action` is what the click handler and the deferred AI / email
  // questions read — never change it without checking both.
}

function renderCostLine() {
  const el = $('#costLine');
  if (!el) return;                       // lives in the hidden legacy dashboard
  const total = state.stats ? state.stats.costTotalUSD : 0;
  const last = state.lastRunCost && state.lastRunCost.usd
    ? `<span class="last">last ${state.lastRunLabel}: ${fmtCost(state.lastRunCost.usd)}</span> · ` : '';
  el.innerHTML = `${last}API cost so far: <b>${fmtCost(total)}</b>`;
}

// Pull the next refresh forward. Pressing the big button opens a run on the
// server, but the poll that would notice it can be 30 seconds away — so the
// step checklist on Home would only appear on a long run. One early refresh
// picks the run up, and the 3-second cadence takes over from there.
function pokeRefresh(ms = 900) {
  clearTimeout(state._refreshTimer);
  state._refreshTimer = setTimeout(async () => {
    try { await refresh(); } catch { /* the loop below carries on regardless */ }
    if (typeof scheduleRefresh === 'function') scheduleRefresh();
  }, ms);
}

$('#smartBtn')?.addEventListener('click', async e => {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  // No CV, no application — so the button opens the question that asks for one
  // rather than starting work that can only come back with an error.
  if (action === 'cv') {
    await obHydrate().catch(() => {});
    ob.i = OB_STEPS.indexOf('cv');
    JobPilot.screens.go('welcome');
    obRender();
    return;
  }
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.innerHTML = '<span class="jp-spinner"></span>Working…';
  pokeRefresh();
  try {
    if (action === 'fetch') {
      const r = await api('/api/batch/fetch', { method: 'POST', body: {} });
      state.lastRunCost = r.cost; state.lastRunLabel = 'find';
      if (r.reason) {
        toast(r.reason, true); // fetch didn't run — tell the user exactly why
      } else {
        toast((r.added
          ? `Found ${r.added} job${r.added === 1 ? '' : 's'} that suit you. Have a look through them, and drop any you don't fancy — then press the button again.`
          : `Nothing new that suits you right now${r.skipped ? ` — we read ${r.skipped} and none were close enough` : ''}. Try again later, or widen what you're after in Settings.`)
          + costWords(r.cost));
      }
    } else if (action === 'generate') {
      const r = await api('/api/batch/generate', { method: 'POST' });
      state.lastRunCost = r.cost; state.lastRunLabel = 'generate';
      if (r.done === 0 && r.error) {
        toast(r.error, true);
      } else {
        toast(`Written — ${r.done} CV${r.done === 1 ? '' : 's'} and ${r.done === 1 ? 'a message' : 'messages'} to go with ${r.done === 1 ? 'it' : 'them'}`
          + `${r.fixed ? `, and we corrected ${r.fixed} against your real CV` : ''}${r.failed ? ` (${r.failed} didn't work: ${esc(r.error)})` : ''}.`
          + (r.manualQueued ? ` ${r.manualQueued} of them have nobody to email, so those are yours to send on the company's own site — they're under "Needs you".` : '')
          + ' Read them if you like, then press Send.' + costWords(r.cost));
      }
    } else if (action === 'send') {
      const ready = state.applications.filter(a => a.status === 'ready').length;
      const { action: actionCount } = pipelineCounts();
      if (!confirm(`Send ${ready === 1 ? 'this application' : `these ${ready} applications`} now, with your CV attached to each one?`
        + (actionCount ? `\n\n(${actionCount} more can only be done on the companies' own sites — those stay under "Needs you".)` : ''))) {
        btn.disabled = false; btn.textContent = oldText; return;
      }
      const r = await api('/api/batch/send', { method: 'POST' });
      const runCost = r.run ? { usd: r.run.costTotal, ai: r.run.costAI, source: r.run.costSource } : r.cost;
      const out = (r.sent || 0) + (r.simulated || 0);
      if (r.yoursToSend) {
        // The setting changed under us between drawing the button and pressing
        // it. Nothing was sent, and the toast says exactly that.
        toast("You send your applications yourself, so nothing was emailed. They're written and waiting for you under \"Needs you\".");
        await refresh();
        btn.disabled = false;
        renderSmartButton();
        return;
      }
      toast(`${out ? `${out} application${out === 1 ? '' : 's'} sent` : 'Nothing went out'}`
        + `${r.simulated && !r.sent ? " — as a practice run, because your email isn't connected yet" : ''}`
        + `${r.expired ? `, and ${r.expired} advert${r.expired === 1 ? ' had' : 's had'} already closed` : ''}`
        + `${r.failed ? `, ${r.failed} didn't go through` : ''}`
        + `. We'll remind them on day 3, 5 and 10.`
        + costWords(r.run ? { usd: r.run.costTotal } : runCost));
    }
    await refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  renderSmartButton();
});

// ---------- "Check for replies": sends any nudges that are due, reads the inbox ----------

$('#syncBtn')?.addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span>Checking…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    const bits = [];
    if (r.followupsSent) bits.push(`nudged ${r.followupsSent} compan${r.followupsSent === 1 ? 'y' : 'ies'} for you`);
    if (r.inbox) {
      const i = r.inbox;
      if (i.interviews) bits.push(`${i.interviews === 1 ? 'one company wants' : `${i.interviews} companies want`} to meet you 🎉`);
      if (i.repliesFound) bits.push(`${i.repliesFound} repl${i.repliesFound === 1 ? 'y' : 'ies'} came back`);
      if (i.rejections) bits.push(`${i.rejections} said no`);
      if (i.confirmations) bits.push(`${i.confirmations} confirmed they got your application`);
      if (i.contactsCaptured) bits.push(`${i.contactsCaptured} new address${i.contactsCaptured === 1 ? '' : 'es'} to chase up`);
    }
    let msg = bits.length ? `All done — ${bits.join(', ')}.` : 'All done — nothing new since last time.';
    if (r.inboxError) msg += ` We couldn't read your inbox: ${r.inboxError}`;
    else if (!r.inbox) msg += " Connect your email in Settings and we can read the replies for you too.";
    toast(msg);
    await refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = 'Check for replies';
});

// ---------- Profiles ----------

function renderProfiles(profiles) {
  const sel = $('#profileSelect');
  sel.innerHTML = profiles.map(p =>
    `<option value="${esc(p.id)}" ${p.active ? 'selected' : ''}>${esc(p.name)} — ${esc(p.title)} (${p.applications})</option>`
  ).join('') +
    '<option value="__rename__">✎ Rename current profile…</option>' +
    '<option value="__new__">＋ New profile…</option>' +
    (profiles.length > 1 ? '<option value="__delete__">🗑 Delete current profile…</option>' : '');
}

$('#profileSelect')?.addEventListener('change', async e => {
  const v = e.target.value;
  try {
    if (v === '__rename__') {
      const active = (await api('/api/profiles')).profiles.find(p => p.active);
      const label = prompt('Name this profile (e.g. "India Backend", "US Remote"):', active?.name || '');
      if (label === null) { refresh(); return; }
      await api(`/api/profiles/${active.id}`, { method: 'PATCH', body: { label } });
      toast('Profile renamed');
    } else if (v === '__new__') {
      if (!confirm('Create a new profile? Upload a different CV for it after switching.')) { refresh(); return; }
      await api('/api/profiles', { method: 'POST' });
      toast('New profile created — upload a CV for it');
    } else if (v === '__delete__') {
      const current = state.settings && document.querySelector('#profileSelect option[selected]');
      const active = (await api('/api/profiles')).profiles.find(p => p.active);
      if (!confirm(`Delete profile "${active?.name}" and ALL its applications? This cannot be undone.`)) { refresh(); return; }
      await api(`/api/profiles/${active.id}`, { method: 'DELETE' });
      toast('Profile deleted');
    } else {
      await api(`/api/profiles/${v}/activate`, { method: 'POST' });
      toast('Profile switched');
    }
    location.reload();
  } catch (err) { toast(err.message, true); refresh(); }
});

// Initials for the "You" button in the header — first letters of the name we
// read from the CV, a neutral dot until there is one.
function renderYouButton(profile) {
  // Home greets people by name. The profile list only carries the *label* of a
  // search ("New profile"), so the name off the CV is kept here instead. This
  // lands one tick after the snapshot, so Home is redrawn when it changes.
  const before = state.cvName;
  state.cvName = (profile && profile.name) || '';
  if (before !== state.cvName && typeof renderHome === 'function') {
    try { renderHome(); } catch { /* Home may not be in this page */ }
  }
  const el = $('#youInitials');
  if (!el) return;
  const parts = String(profile?.name || '').trim().split(/\s+/).filter(Boolean);
  el.textContent = parts.length
    ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
    : '·';
}

async function renderProfileCard() {
  const { profile } = await api('/api/profile');
  renderYouButton(profile);
  const el = $('#profileCard');
  if (!el) return;
  if (!profile) {
    el.innerHTML = `
      <div class="empty-profile">
        <p>Upload a CV for this profile — JobPilot extracts skills and tailors every application.</p>
        <label class="btn btn-primary" for="cvInput">Upload CV</label>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="profile-name">${esc(profile.name)}</div>
    <div class="profile-title">${esc(profile.title)} · ${esc(profile.years_experience)} yrs</div>
    <div class="skill-chips">${(profile.skills || []).slice(0, 8).map(s => `<span class="chip">${esc(s)}</span>`).join('')}</div>
    <div style="display:flex;gap:12px;margin-top:10px">
      <label class="btn-link" for="cvInput" style="padding:0">Re-upload CV</label>
    </div>
  `;
}

// ---------- Stats / board / activity ----------

// Everything from here to renderActivity() writes into the hidden pre-revamp
// dashboard. Each one checks its own element exists first, so the day that
// markup is finally deleted the new screens carry on untouched.
function renderStats(s) {
  if (!$('#stTotal')) return;
  $('#stTotal').textContent = s.total;
  $('#stApplied').textContent = s.applied;
  $('#stFollow').textContent = s.followupsSent;
  $('#stReplied').textContent = s.replied;
  $('#stInterview').textContent = s.interviews + (s.offers ? ` +${s.offers}🏆` : '');
  const counts = COLUMNS.map(c => c.statuses.reduce((n, st) => n + (s.byStatus[st] || 0), 0));
  const max = Math.max(1, ...counts);
  $('#funnel').innerHTML = COLUMNS.map((c, i) =>
    `<div class="bar" style="height:${Math.max(6, (counts[i] / max) * 100)}%;background:${c.color}" title="${c.label}: ${counts[i]}"><span>${counts[i] || ''}</span></div>`
  ).join('');
}

function renderSideStatus(s) {
  const sourceList = document.querySelector('.source-list');
  if (!sourceList) return;
  const srcHtml = [
    { on: s.sources.ats, name: 'Career pages (ATS)', note: s.sources.ats ? 'live' : 'add companies' },
    { on: s.sources.remotive, name: 'Free boards ×3', note: s.sources.remotive ? 'live' : 'off' },
    { on: s.sources.adzuna, name: 'Adzuna', note: s.sources.adzuna ? 'live' : 'add API keys' },
    { on: s.sources.linkedin && s.apifyTokenSet, name: 'LinkedIn (Apify)', note: s.sources.linkedin ? (s.apifyTokenSet ? 'live' : 'needs token') : 'off' },
    { on: s.sources.naukri && s.apifyTokenSet, name: 'Naukri (Apify)', note: s.sources.naukri ? (s.apifyTokenSet ? 'live' : 'needs token') : 'off' }
  ].map(x =>
    `<div class="source ${x.on ? 'on' : ''}"><span class="dot ${x.on ? 'green' : 'gray'}"></span>${x.name} <small>${x.note}</small></div>`
  ).join('');
  sourceList.innerHTML = srcHtml;

  $('#emailStatus').innerHTML = s.smtpConfigured
    ? `<span class="on">✓ Email: sending as ${esc(s.fromName || s.smtpUser)}</span>`
    : 'Email: simulated (add Gmail in Settings to send for real)';
  if (!s.autoSearch) {
    $('#autoSearchStatus').innerHTML = 'Auto-discovery: off';
  } else {
    const next = s.lastAutoSearchAt
      ? Math.max(0, Math.round((s.lastAutoSearchAt + s.autoSearchHours * 3600000 - Date.now()) / 3600000 * 10) / 10)
      : 0;
    $('#autoSearchStatus').innerHTML =
      `<span class="on">✓ Auto: every ${s.autoSearchHours}h (${s.mode} mode)</span>` +
      (s.lastAutoSearchAt ? ` · next in ~${next}h` : ' · first run pending');
  }
}

function renderBoard() {
  const board = $('#board');
  if (!board) return;
  const visible = state.applications.filter(matchesFilters);
  const filtering = filters.stage !== 'all' || filters.from || filters.to;
  $('#filterCount').textContent = filtering ? `${visible.length} of ${state.applications.length} shown` : '';

  board.innerHTML = bucketise(visible).map(col => {
    const cards = col.rows;
    const bulkBtn = col.id === 'needsyou' && cards.length
      ? `<button class="col-action" id="markAllAppliedBtn" title="Move every card here to Applied — use after you've applied to them on the platforms">✓ all applied</button>`
      : '';
    return `
      <div class="column" data-col="${col.id}">
        <div class="col-head"><span class="col-dot" style="background:${col.color}"></span>${col.label}
          <span class="col-count">${cards.length}</span>${bulkBtn}</div>
        <div class="cards">${cards.map(cardHtml).join('')}</div>
      </div>`;
  }).join('');

  $('#markAllAppliedBtn')?.addEventListener('click', async e => {
    e.stopPropagation();
    const n = state.applications.filter(a => a.status === 'action').length;
    if (!confirm(`Mark all ${n} "Your action" job${n > 1 ? 's' : ''} as applied?\n\nOnly do this after you actually applied on the platforms — they move to Applied and follow-up reminders start.`)) return;
    try {
      const r = await api('/api/applications/mark-all-applied', { method: 'POST' });
      toast(`${r.applied} application${r.applied > 1 ? 's' : ''} marked applied — follow-up reminders on day 3, 5, 10 ✓`);
      refresh();
    } catch (err) { toast(err.message, true); }
  });

  // A card opens the same slide-over panel the new My jobs screen uses — there
  // is only one job detail view in the app. Dragging cards between columns is
  // gone: the four buckets follow what actually happened, they aren't a to-do
  // list you rearrange by hand.
  board.querySelectorAll('.card').forEach(el => {
    el.addEventListener('click', () => openDrawer(el.dataset.id));
  });
  board.querySelectorAll('.card-link').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation()); // open the posting, not the panel
  });
  board.querySelectorAll('.card-x').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      await api(`/api/applications/${el.dataset.id}`, { method: 'DELETE' });
      refresh();
    });
  });
}

function cardHtml(a) {
  const cls = a.matchScore >= 75 ? 'hi' : a.matchScore >= 55 ? 'mid' : 'lo';
  const pips = [3, 5, 10].map(d =>
    `<span class="pip ${(a.followups || []).some(f => f.day === d) ? 'sent' : ''}" title="Day ${d} follow-up"></span>`).join('');
  const removable = ['discovered', 'approved'].includes(a.status);
  return `
    <div class="card" data-id="${esc(a.id)}">
      ${removable ? `<button class="card-x" data-id="${esc(a.id)}" title="Not interested — remove">✕</button>` : ''}
      <div class="card-title">${esc(a.title)}</div>
      <div class="card-company">${esc(a.company)} · ${esc(a.location)}</div>
      <div class="card-meta">
        <span class="score ${cls}">${a.matchScore}%</span>
        ${a.url ? `<a class="card-link" href="${esc(a.url)}" target="_blank" title="Open the job posting">view job ↗</a>` : ''}
        ${a.status === 'action' ? '<span class="tag warn">✋ apply on platform</span>' : ''}
        ${a.status === 'action' && a.tailored ? `<a class="card-link" href="/api/applications/${esc(a.id)}/cv.pdf" title="Download the tailored CV as PDF — upload this on the platform">CV ⬇</a>` : ''}
        ${a.recipientEmail && !a.appliedAt ? '<span class="tag done" title="Recruiter email found — applies by email automatically">@ direct</span>' : ''}
        ${a.tailored ? '<span class="tag done">CV ✓</span>' : ''}
        ${a.confirmed ? '<span class="tag done" title="Company confirmed receiving the application">rcvd ✓</span>' : ''}
        ${a.replied ? '<span class="tag done">Reply ⭐</span>' : ''}
        ${a.appliedAt ? `<span class="card-date">applied ${new Date(a.appliedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>` : ''}
        ${a.appliedAt ? `<span class="followup-pips">${pips}</span>` : ''}
      </div>
    </div>`;
}

// Is a run step executing right now? Returns its label, or null. These three
// words are also what the big button says while it is locked, and what the
// step checklist on Home is built from — one set of words for one thing.
const OP_LABELS = {
  fetching:   { icon: '🔍', text: 'Looking for jobs', count: r => `${r.found} found so far` },
  generating: { icon: '✍', text: 'Writing your applications', count: r => `${r.tailored} written` },
  sending:    { icon: '✉', text: 'Sending them off', count: r => `${r.sent + r.simulated} sent` }
};
function activeOp() {
  const r = state.currentRun;
  return r && r.activeOp && OP_LABELS[r.activeOp] ? r.activeOp : null;
}

// Live banner above the board so you always know a run is executing — even
// after a page refresh or during an unattended auto run.
function renderRunStatus() {
  const el = $('#runStatus');
  if (!el) return;
  const op = activeOp();
  const r = state.currentRun;
  if (op) {
    const L = OP_LABELS[op];
    el.className = 'run-status running';
    el.innerHTML = `<span class="spinner"></span><b>${L.icon} ${L.text}…</b> <span class="rs-sub">${esc(L.count(r))}${r.mode === 'auto' ? ' · auto run' : ''} · running ${Math.max(0, Math.round((Date.now() - r.activeSince) / 1000))}s · cost so far ${fmtCost((r.costAI || 0) + (r.costSource || 0))}</span>`;
    // keep the big button locked while the step runs, with a matching label
    const btn = $('#smartBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="jp-spinner"></span>${L.text}…`;
    }
  } else if (r) {
    // a cycle is open but no step executing — say exactly what it's waiting for
    const { disc, appr, ready } = pipelineCounts();
    const cost = `cost so far ${fmtCost((r.costAI || 0) + (r.costSource || 0))}`;
    let msg;
    if (disc + appr > 0) {
      msg = `Found <b>${disc + appr}</b> jobs that suit you. Have a look through them, then press <b>Write ${disc + appr} applications</b>.`;
    } else if (ready > 0) {
      msg = `<b>${ready}</b> application${ready > 1 ? 's are' : ' is'} written and waiting — read them if you like, then press <b>Send</b>.`;
    } else {
      msg = `Finishing up — this round closes itself once everything is sent or handed to you.`;
    }
    el.className = 'run-status open';
    el.innerHTML = `<span class="rs-dot"></span><span>${msg} <span class="rs-sub">${r.mode === 'auto' ? 'auto run · ' : ''}${cost}</span></span>`;
  } else {
    el.className = 'run-status hidden';
    el.innerHTML = '';
  }
}

// Run ledger: one line per completed cycle with its true AI + API cost
function renderRuns({ runs = [], current = null } = {}) {
  const el = $('#runsList');
  if (!el) return;
  const rows = runs.slice(0, 8).map(r => `
    <li>
      <span class="when">${timeAgo(r.endedAt || r.startedAt)}</span>
      <span><b>${r.mode === 'auto' ? '🤖 auto' : '🖐 manual'}</b> · ${r.found} found → ${r.tailored} tailored → ${r.sent} emailed
        ${r.manualQueued ? ` + ${r.manualQueued} for you` : ''}${r.simulated ? ` (${r.simulated} simulated)` : ''}${r.expired ? ` · ${r.expired} expired` : ''}
        · <b>AI ${fmtCost(r.costAI)} + API ${fmtCost(r.costSource)} = ${fmtCost(r.costTotal)}</b></span>
    </li>`).join('');
  const cur = current
    ? `<li><span class="when">now</span><span>⏳ run in progress (${current.mode}): ${current.found} found, ${current.tailored} tailored · AI ${fmtCost(current.costAI)} + API ${fmtCost(current.costSource)} so far</span></li>`
    : '';
  el.innerHTML = cur + rows || '<li><span>No runs yet — a run is one full find → generate → send cycle.</span></li>';
}

function renderActivity(items) {
  if (!$('#activityFeed')) return;
  $('#activityFeed').innerHTML = (items || []).slice(0, 12).map(a =>
    `<li><span class="when">${timeAgo(a.at)}</span><span>${esc(a.text)}</span></li>`).join('') ||
    '<li><span>No activity yet — upload your CV and hit Find jobs.</span></li>';
}

/* ===========================================================================
 * Installable app (PWA): service worker, install prompt, offline notice.
 * Self-contained on purpose — nothing above this line depends on it, and the
 * app behaves exactly as before in browsers that support none of it.
 * ======================================================================== */
(() => {
  const DISMISS_KEY = 'jp_install_dismissed';

  // The worker caches the static shell only; every /api call stays network-only
  // (see public/sw.js), so live job/application data can never go stale.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        // Not fatal: no offline shell, everything else works as before.
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  // The desktop launcher (JobPilot.app / JobPilot.command / JobPilot.bat) opens
  // JobPilot in a Chrome "--app" window: no tabs, no address bar. That window
  // reports `display-mode: standalone` — exactly what a genuinely installed app
  // reports — so on its own we would decide JobPilot was already installed and
  // hide the offer to install it. The launcher therefore says so in the address
  // (?opened-by=launcher) and we remember it for THIS WINDOW only: sessionStorage
  // survives reloads inside the window but is empty in the app a person later
  // opens from their Dock, so a real installed app is never nagged.
  const LAUNCHER_KEY = 'jp_launcher_window';
  function launcherWindow() {
    let flagged = false;
    try { flagged = new URLSearchParams(location.search).get('opened-by') === 'launcher'; } catch { /* ancient browser */ }
    try {
      if (flagged) sessionStorage.setItem(LAUNCHER_KEY, '1');
      return sessionStorage.getItem(LAUNCHER_KEY) === '1';
    } catch { return flagged; } // storage disabled: the address alone has to do
  }

  // Tidy the marker back out of the address bar once it is remembered, so it is
  // never bookmarked or shared. The hash route is left exactly as it was.
  (() => {
    if (!launcherWindow() || !location.search) return;
    try {
      const q = new URLSearchParams(location.search);
      if (!q.has('opened-by')) return;
      q.delete('opened-by');
      const rest = q.toString();
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    } catch { /* cosmetic only — never worth an error */ }
  })();

  const isInstalled = () =>
    !launcherWindow() && (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      navigator.standalone === true); // iOS home-screen apps

  let deferredPrompt = null; // Chrome's beforeinstallprompt event, usable once
  let banner = null;

  function closeBanner() {
    if (banner) banner.remove();
    banner = null;
  }

  // Sits at the top of Home, above whatever needs you — the old dashboard it
  // used to hang off is hidden now, so it follows the screen people look at.
  function showBanner() {
    if (banner || !deferredPrompt || isInstalled()) return;
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
    const anchor = document.getElementById('homeRun') || $('#statsRow');
    if (!anchor || !anchor.parentNode) return;

    banner = document.createElement('div');
    banner.className = 'jp-card jp-card--quiet jp-card--tight jp-install-banner';
    banner.id = 'installBanner';
    banner.innerHTML = `
      <span class="jp-avatar jp-avatar--accent">✈</span>
      <div class="jp-row-main">
        <div class="jp-h-sans--sm">Keep JobPilot in your Dock</div>
        <div class="jp-note">Its own icon in your Dock or Start menu, and its own window with no browser tabs around it. Same data, same computer.</div>
      </div>
      <button id="installYes" class="jp-btn jp-btn--primary jp-btn--sm">Install it</button>
      <button id="installNo" class="jp-btn jp-btn--link">Not now</button>`;
    anchor.parentNode.insertBefore(banner, anchor);

    $('#installYes').addEventListener('click', doInstall);
    $('#installNo').addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, '1'); // asked once, that's enough
      closeBanner();
      toast('Fine — install any time from the browser menu → "Install JobPilot".');
    });
  }

  async function doInstall() {
    if (!deferredPrompt) { closeBanner(); return; }
    const btn = $('#installYes');
    if (btn) btn.disabled = true;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null; // the event is spent either way
    closeBanner();
    if (outcome !== 'accepted') {
      // Not persisted: Chrome re-fires beforeinstallprompt on a later visit.
      toast('Install cancelled — the option stays in the browser menu.');
    }
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); // suppress Chrome's own mini-infobar; we ask in-app
    deferredPrompt = e;
    showBanner();
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    localStorage.setItem(DISMISS_KEY, '1');
    closeBanner();
    notify();
    toast('JobPilot installed — look for the ✈️ icon in your Dock or Start menu.');
  });

  // The one deferred prompt lives here and can only be captured here (the event
  // fires once per page load). Anything else that wants to offer the install
  // reuses it through this hook rather than listening for the event a second time.
  const watchers = [];
  function notify() { for (const fn of watchers) { try { fn(); } catch { /* never break the app */ } } }
  window.jobPilotInstall = {
    canInstall: () => !!deferredPrompt && !isInstalled(),
    isInstalled,
    install: doInstall,
    onChange: fn => { if (typeof fn === 'function') watchers.push(fn); }
  };

  // Offline: the cached shell means you land in the app instead of on Chrome's
  // dinosaur, but /api is network-only by design — so say plainly that the live
  // data is paused rather than letting every poll surface as a red error.
  let offlineBar = null;
  function renderOffline() {
    const anchor = document.getElementById('homeRun') || $('#runStatus');
    if (navigator.onLine || !anchor || !anchor.parentNode) {
      if (offlineBar) { offlineBar.remove(); offlineBar = null; }
      return;
    }
    if (offlineBar) return;
    offlineBar = document.createElement('div');
    offlineBar.className = 'jp-card jp-card--warn jp-card--tight jp-offline-bar';
    offlineBar.innerHTML = '<div class="jp-h-sans--sm">You are offline — this is the last thing JobPilot loaded</div>' +
      '<div class="jp-note">Nothing is lost: your CV, your jobs and your applications are all on this computer. ' +
      'Searching, applying and chasing up carry on the moment you are back.</div>';
    anchor.parentNode.insertBefore(offlineBar, anchor);
  }

  window.addEventListener('offline', () => {
    renderOffline();
    toast('You went offline — JobPilot paused live updates.', true);
  });
  window.addEventListener('online', () => {
    renderOffline();
    toast('Back online.');
    refresh().catch(() => { /* the 30s poll will catch up */ });
  });
  renderOffline();
})();


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
 * THE WELCOME QUESTIONS — five questions, one per screen.
 *
 * Replaces the old six-step setup wizard. Two deliberate differences:
 *
 *  1. Nothing technical is asked here. There is no question about an AI
 *     service and no question about email. A brand-new person can answer all
 *     five and land on a working app without pasting a single key.
 *  2. The two things that DO eventually need a key are asked at the moment
 *     they are actually needed — see "Asked at the last moment" below.
 *
 * There is no second state store: every answer goes through the same
 * /api/settings the rest of the app reads (`quiet: true` keeps the five saves
 * out of the activity feed), and the CV goes through the same /api/cv. The
 * step number rides along in `onboarding.step`, so closing the browser half
 * way through comes back to the question they were on.
 * ======================================================================== */

const OB_STEPS = ['name', 'cv', 'roles', 'places', 'sending', 'done'];

// The question each screen asks. Shown as the card's heading, and again as
// JobPilot's chat bubble once it has been answered.
const OB_QUESTION = {
  name: 'Hello — what should we call you?',
  cv: 'Now your CV — one file, one time.',
  roles: 'What kind of job are you after?',
  places: 'Where would you like to work?',
  sending: 'Last one. Who presses send?'
};

const OB_REMOTE = 'Anywhere I can work from home';

let ob = {
  hydrated: false,
  i: 0,
  name: '',
  profile: null,
  cvName: '',          // this session only — the server doesn't keep the file name
  roleChips: [],       // suggestions, from the CV and from what's already saved
  roles: [],           // the ones they picked
  placeChips: [],
  places: [],
  remote: true,
  sending: null,
  busy: false
};

const obStep = () => OB_STEPS[ob.i];
const obFirstName = () => (ob.name || ob.profile?.name || '').trim().split(/\s+/)[0] || '';

function obInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '·';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

const obUniq = list => [...new Set(list.map(x => String(x || '').trim()).filter(Boolean))];

// One place worth suggesting — and it comes from their CV, which is the only
// thing here that actually knows where they are.
//
// This used to read the computer's clock ("Asia/Calcutta" → "Calcutta"), which
// offered Calcutta to a CV that says London, Delhi to somebody in Delhi and
// Kiev to somebody in Kyiv: IANA zone names are regions with legacy spellings,
// not addresses. If the CV doesn't say, we don't guess — they can type it.
function obCvPlace() {
  const raw = String(ob.profile?.location || '').trim();
  if (!raw) return '';
  const first = raw.split(/[|•·\n]/)[0].trim().replace(/[,;]\s*$/, '');
  return first.length > 1 && first.length < 60 ? first : '';
}

/* ---------- Reading and writing the same settings everything else uses ---- */

// Everything we know about them, pulled from the server rather than kept in a
// second store — so a reload, a different tab or the Settings screen all agree.
async function obHydrate() {
  const [s, p] = await Promise.all([
    api('/api/settings').catch(() => state.settings || {}),
    api('/api/profile').catch(() => ({ profile: null }))
  ]);
  ob.profile = p.profile || null;
  ob.name = s.fromName || ob.profile?.name || '';

  ob.roles = Array.isArray(s.jobTitles) ? [...s.jobTitles] : [];
  ob.roleChips = obUniq([
    ...(ob.profile?.target_roles || []),
    ob.profile?.title || '',
    ...ob.roles
  ]).slice(0, 8);

  const saved = Array.isArray(s.jobLocations) ? s.jobLocations : [];
  ob.remote = s.remoteOk !== false;
  ob.places = saved.filter(l => String(l).toLowerCase() !== 'remote');
  ob.placeChips = obUniq([...ob.places, obCvPlace()]);

  const stored = OB_STEPS.indexOf(s.onboarding?.step || '');
  ob.i = stored >= 0 ? stored : 0;
  ob.sending = ob.i > 4 ? (s.sendingMode || null) : null;
  ob.hydrated = true;
}

// What each answer contributes to the settings the rest of the app reads.
function obPatch(step) {
  if (step === 'name') return { fromName: ob.name.trim() };
  if (step === 'roles') return { jobTitles: ob.roles };
  if (step === 'places') {
    // "Remote" is a location the job filter understands on its own, so someone
    // who picked only "anywhere I can work from home" gets exactly that rather
    // than every job on earth.
    const locations = ob.places.length ? [...ob.places] : (ob.remote ? ['Remote'] : []);
    return { jobLocations: locations, remoteOk: ob.remote };
  }
  if (step === 'sending' && ob.sending) return { sendingMode: ob.sending };
  return {};
}

// `quiet: true` so answering five questions doesn't put five "Settings updated"
// lines into the activity feed of someone who has never seen it before.
function obSave(patch) {
  return api('/api/settings', { method: 'POST', body: { quiet: true, ...patch } });
}

/* ---------- Drawing it ---------------------------------------------------- */

function obPlaceLabels() {
  const out = [...ob.places];
  if (ob.remote) out.push(OB_REMOTE);
  return out;
}

// The answers so far, as a conversation: what we asked, what they said.
function obChatHtml() {
  const rows = [];
  const bot = text => rows.push(`
    <div class="jp-bubble-row">
      <span class="jp-avatar jp-avatar--xs jp-avatar--round jp-avatar--brand">J</span>
      <div class="jp-bubble">${esc(text)}</div>
    </div>`);
  const me = text => rows.push(`
    <div class="jp-bubble-row">
      <span class="jp-avatar jp-avatar--xs jp-avatar--round jp-avatar--accent">${esc(obInitials(ob.name))}</span>
      <div class="jp-bubble jp-bubble--me">${esc(text)}</div>
    </div>`);

  const answers = [
    () => ob.name,
    () => (ob.profile ? `Uploaded my CV${ob.cvName ? ` — ${ob.cvName}` : ''}` : "I'll add my CV later"),
    () => ob.roles.join(', ') || 'Whatever fits my CV',
    () => obPlaceLabels().join(', ') || 'Anywhere',
    () => (ob.sending === 'jobpilot' ? 'You send them for me' : "I'll send them myself")
  ];

  for (let i = 0; i < 5 && i < ob.i; i++) {
    const said = answers[i]();
    if (!said) continue;
    bot(OB_QUESTION[OB_STEPS[i]]);
    me(said);
  }
  if (obStep() === 'done' && ob.sending === 'jobpilot') {
    bot("Great — we'll ask for your email address the first time we actually need it, not now.");
  }
  return rows.join('');
}

function obChipsHtml(chips, selected, kind) {
  return chips.map(c => `<button type="button" class="jp-chip${selected.includes(c) ? ' is-on' : ''}"
    data-chip="${esc(kind)}" data-value="${esc(c)}">${esc(c)}</button>`).join('');
}

function obCardHtml() {
  const step = obStep();

  if (step === 'name') return `
    <h1 class="jp-h1">${esc(OB_QUESTION.name)}</h1>
    <p class="jp-lede jp-ob-lede">This is the name companies will see on your applications.
      Nothing else happens yet.</p>
    <input class="jp-input" id="obInput" value="${esc(ob.name)}" placeholder="e.g. Mohammed Jawad"
      autocomplete="name" aria-label="Your name">`;

  if (step === 'cv') {
    const body = ob.profile ? obProofHtml() : `
      <div class="jp-card jp-card--dashed" id="obDrop">
        <div class="jp-lede">Drag your CV here — PDF, Word or plain text</div>
        <div class="jp-btns jp-ob-drop-btns">
          <button type="button" class="jp-btn jp-btn--primary" id="obChooseCv">Choose a file</button>
        </div>
        <div class="jp-note">Don't have one handy?
          <button type="button" class="jp-btn jp-btn--link" id="obCvLater">Do this bit later</button></div>
      </div>`;
    return `
      <h1 class="jp-h1">${esc(OB_QUESTION.cv)}</h1>
      <p class="jp-lede jp-ob-lede">We read it to learn what you do, then rewrite it to fit each job.
        It stays on this computer.</p>
      ${body}`;
  }

  if (step === 'roles') {
    const fromCv = (ob.profile?.target_roles || []).length || ob.profile?.title;
    return `
      <h1 class="jp-h1">${esc(OB_QUESTION.roles)}</h1>
      <p class="jp-lede jp-ob-lede">${fromCv
        ? 'Everyday words are fine. We read these from your CV — tap the ones that sound right.'
        : 'Everyday words are fine — no need to be clever.'}</p>
      ${ob.roleChips.length ? `<div class="jp-chips jp-ob-chips">${obChipsHtml(ob.roleChips, ob.roles, 'role')}</div>` : ''}
      <input class="jp-input jp-input--md" id="obInput" placeholder="Something else? Type it here"
        aria-label="Another kind of job">`;
  }

  if (step === 'places') return `
    <h1 class="jp-h1">${esc(OB_QUESTION.places)}</h1>
    <p class="jp-lede jp-ob-lede">Pick as many as you like. We'll only bring you jobs from these places.</p>
    <div class="jp-chips jp-ob-chips">
      <button type="button" class="jp-chip${ob.remote ? ' is-on' : ''}" data-chip="remote"
        data-value="${esc(OB_REMOTE)}">${esc(OB_REMOTE)}</button>
      ${obChipsHtml(ob.placeChips, ob.places, 'place')}
    </div>
    <input class="jp-input jp-input--md" id="obInput" placeholder="Somewhere else? Type a town, city or country"
      aria-label="Another place you'd work">`;

  if (step === 'sending') return `
    <h1 class="jp-h1">${esc(OB_QUESTION.sending)}</h1>
    <p class="jp-lede jp-ob-lede">Either way we write every application for you.
      This is only about who sends it.</p>
    <button type="button" class="jp-choice${ob.sending === 'jobpilot' ? ' is-on' : ''}" data-send="jobpilot">
      <div class="jp-choice-title">JobPilot sends them for me</div>
      <div class="jp-choice-sub">We email each application from your address and chase it up after 3, 5 and
        10 days. We'll ask for your email details the first time we need them.</div>
    </button>
    <button type="button" class="jp-choice${ob.sending === 'myself' ? ' is-on' : ''}" data-send="myself">
      <div class="jp-choice-title">I'll send them myself</div>
      <div class="jp-choice-sub">We still write every CV and message and remind you when to follow up.
        You press send. Perfectly fine choice.</div>
    </button>
    <p class="jp-note">We never send anything to a company without showing you first.</p>`;

  // done
  return `
    <div class="jp-ob-done">
      <div class="jp-ob-icon">🎉</div>
      <h1 class="jp-h1">That's everything${obFirstName() ? `, ${esc(obFirstName())}` : ''}.</h1>
      <p class="jp-lede">We're looking for jobs now. From here on, JobPilot only asks when it
        genuinely needs you — usually a minute or two a day.</p>
      <button type="button" class="jp-btn jp-btn--primary" id="obFinish">Show me what you found</button>
    </div>`;
}

// The moment that earns their trust: we read the file, here is what we got.
function obProofHtml() {
  const p = ob.profile || {};
  const skills = (p.skills || []).slice(0, 10).join(', ');
  const years = p.years_experience ? `, about ${p.years_experience} years` : '';
  const rows = [
    ['Your name', p.name || '—'],
    ['What you do', (p.title || '—') + years],
    p.location ? ['Where you are', p.location] : null,
    skills ? ['Best at', skills] : null,
    (p.target_roles || []).length ? ['Jobs it suits', p.target_roles.slice(0, 4).join(', ')] : null
  ].filter(Boolean);
  const rough = JobPilot.data?.settings && !JobPilot.data.settings.llmReady;
  return `
    <div class="jp-card jp-card--good">
      <div class="jp-ob-proof-head">Read it — here's what we understood</div>
      ${rows.map(([k, v]) => `<div class="jp-kv"><span class="jp-kv-key">${esc(k)}</span><span class="jp-kv-val">${esc(v)}</span></div>`).join('')}
      <p class="jp-note jp-ob-proof-note">Wrong anywhere? You can fix all of it later — nothing is set in stone.${
        rough ? ' We picked this out of the words on the page for now; once JobPilot has something to think with it will read your CV properly.' : ''}</p>
    </div>
    <div class="jp-btns jp-ob-reupload">
      <button type="button" class="jp-btn jp-btn--quiet jp-btn--sm" id="obChooseCv">Use a different file</button>
    </div>`;
}

function obFootHtml() {
  const step = obStep();
  if (step === 'done') return '';
  const back = ob.i > 0
    ? '<button type="button" class="jp-btn jp-btn--secondary" id="obBack">Back</button>' : '';
  // "Who presses send?" has no Next — picking one of the two cards IS the answer.
  // Back still shows, so the keyboard is never a one-way street.
  const next = step === 'sending' ? '' :
    `<button type="button" class="jp-btn jp-btn--primary jp-spacer" id="obNext">${
      step === 'cv' && ob.profile ? 'Looks right' : 'Continue'}</button>`;
  if (!back && !next) return '';
  return `<div class="jp-ob-foot">${back}${next}</div>`;
}

function obRender({ focus = true } = {}) {
  const dots = $('#obDots');
  const count = $('#obCount');
  const chat = $('#obChat');
  const card = $('#obCard');
  if (!dots || !card) return;

  dots.innerHTML = [0, 1, 2, 3, 4]
    .map(i => `<span class="jp-step-dot${i <= ob.i ? ' is-on' : ''}"></span>`).join('');
  count.textContent = ob.i >= 5 ? 'Done' : `Question ${ob.i + 1} of 5`;
  chat.innerHTML = obChatHtml();
  card.innerHTML = obCardHtml() + obFootHtml();
  // Nothing left to skip once every question is answered.
  $('#obSkip')?.classList.toggle('jp-hidden', obStep() === 'done');
  window.scrollTo(0, 0);

  if (!focus) return;
  // Whatever this screen most wants them to do: the box to type in, the file to
  // pick, or — once the CV has been read — the button that says "looks right".
  const first = card.querySelector(
    obStep() === 'cv' && ob.profile ? '#obNext' : '#obInput, #obFinish, .jp-choice, #obChooseCv, #obNext');
  if (first) first.focus({ preventScroll: true });
}

/* ---------- Moving between questions -------------------------------------- */

// Anything typed into the free-text box counts as an answer, so nobody loses a
// line they typed but never turned into a chip.
function obCommitDraft() {
  const input = $('#obInput');
  if (!input) return;
  const text = input.value.trim();
  const step = obStep();
  if (step === 'name') { ob.name = text; return; }
  if (!text) return;
  const added = text.split(',').map(t => t.trim()).filter(Boolean);
  if (step === 'roles') {
    ob.roleChips = obUniq([...ob.roleChips, ...added]);
    ob.roles = obUniq([...ob.roles, ...added]);
  } else if (step === 'places') {
    ob.placeChips = obUniq([...ob.placeChips, ...added]);
    ob.places = obUniq([...ob.places, ...added]);
  }
}

async function obGo(delta) {
  if (ob.busy) return;
  obCommitDraft();
  const step = obStep();
  const target = Math.max(0, Math.min(OB_STEPS.length - 1, ob.i + delta));
  ob.busy = true;
  try {
    // Saved on every move, forwards and back, so nothing they answered is ever
    // only in the browser's memory.
    //
    // `welcomeDone: false` is written deliberately and on every move. Without
    // it, the server's "does this install look established?" rule sees the CV
    // and the answers land and decides — correctly, for an upgrade, wrongly for
    // someone mid-flow — that this person has already been welcomed. Setting it
    // explicitly means closing the browser at question three comes back to
    // question three instead of dropping them into a half-answered dashboard.
    await obSave({ welcomeDone: false, ...obPatch(step), onboarding: { step: OB_STEPS[target] } });
  } catch (err) {
    ob.busy = false;
    toast(err.message, true); // stay put rather than lose what they just typed
    return;
  }
  ob.busy = false;
  ob.i = target;
  obRender();
}

async function obPickSending(mode) {
  ob.sending = mode === 'jobpilot' ? 'jobpilot' : 'myself';
  await obGo(1);
}

// Skip: keep every answer given so far, don't ask again, land somewhere usable.
async function obSkip() {
  if (ob.busy) return;
  obCommitDraft();
  ob.busy = true;
  try {
    await obSave({ ...obPatch(obStep()), welcomeDone: true, onboarding: { step: '' } });
  } catch (err) { toast(err.message, true); }
  ob.busy = false;
  await refresh().catch(() => {});
  JobPilot.screens.go('home');
  toast("No problem — we've kept what you told us. You can fill in the rest whenever you like.");
}

async function obFinish() {
  if (ob.busy) return;
  ob.busy = true;
  try { await obSave({ welcomeDone: true, onboarding: { step: '' } }); }
  catch (err) { toast(err.message, true); }
  ob.busy = false;
  await refresh().catch(() => {});
  JobPilot.screens.go('home');
  obStartFirstSearch();
}

// The done screen's button is the first search. It goes through exactly the same
// button (and therefore the same "does this need a key?" gate) as every later one.
function obStartFirstSearch() {
  const btn = $('#smartBtn');
  if (!btn || btn.disabled) return;
  btn.click();
}

/* ---------- The CV ------------------------------------------------------- */

// Same upload the rest of the app uses; only the words are different, because
// "profile extracted — 7 skills found" is not a sentence for someone on their
// second minute with the app.
async function obUploadCv(file) {
  if (!file) return;
  const card = $('#obCard');
  if (card) card.innerHTML = `<div class="jp-loading"><span class="jp-spinner"></span> Reading your CV…</div>`;
  try {
    const fd = new FormData();
    fd.append('cv', file);
    const res = await fetch('/api/cv', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'We could not read that file. A PDF, Word file or plain text works best.');
    ob.profile = data.profile || null;
    ob.cvName = file.name || '';
    if (!ob.name && ob.profile?.name) ob.name = ob.profile.name;
    ob.roleChips = obUniq([
      ...(ob.profile?.target_roles || []),
      ob.profile?.title || '',
      ...ob.roleChips
    ]).slice(0, 8);
    obRender();
    refresh().catch(() => {});
  } catch (err) {
    obRender();
    toast(err.message, true);
  }
}

/* ---------- Wiring -------------------------------------------------------- */

$('#obCvInput')?.addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  obUploadCv(file);
});

$('#obSkip')?.addEventListener('click', () => obSkip());

$('#obCard')?.addEventListener('click', e => {
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    const kind = chip.dataset.chip;
    const value = chip.dataset.value;
    if (kind === 'remote') ob.remote = !ob.remote;
    else {
      const list = kind === 'role' ? ob.roles : ob.places;
      const at = list.indexOf(value);
      if (at >= 0) list.splice(at, 1); else list.push(value);
    }
    chip.classList.toggle('is-on');
    return;
  }
  const choice = e.target.closest('[data-send]');
  if (choice) { obPickSending(choice.dataset.send); return; }
  if (e.target.closest('#obNext')) { obGo(1); return; }
  if (e.target.closest('#obBack')) { obGo(-1); return; }
  if (e.target.closest('#obChooseCv')) { $('#obCvInput').click(); return; }
  if (e.target.closest('#obCvLater')) { obGo(1); return; }
  if (e.target.closest('#obFinish')) { obFinish(); return; }
});

// Enter moves on, everywhere except where Enter already means something else.
$('#obCard')?.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (['BUTTON', 'A', 'TEXTAREA', 'SUMMARY'].includes(e.target.tagName)) return;
  e.preventDefault();
  if (obStep() === 'done') obFinish(); else obGo(1);
});

// Drag a CV straight onto the box.
$('#obCard')?.addEventListener('dragover', e => {
  const drop = e.target.closest('#obDrop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.add('is-over');
});
$('#obCard')?.addEventListener('dragleave', e => {
  e.target.closest('#obDrop')?.classList.remove('is-over');
});
$('#obCard')?.addEventListener('drop', e => {
  const drop = e.target.closest('#obDrop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('is-over');
  obUploadCv(e.dataTransfer?.files?.[0]);
});

JobPilot.screens.register('welcome', {
  onEnter() {
    if (ob.hydrated) { obRender(); return; }
    $('#obCard').innerHTML = '<div class="jp-loading"><span class="jp-spinner"></span> One moment…</div>';
    obHydrate().then(() => obRender()).catch(err => {
      $('#obCard').innerHTML = `<p class="jp-lede">We couldn't reach JobPilot just now.</p>
        <p class="jp-note">${esc(err.message)}</p>`;
    });
  }
});

// The old sidebar's "Setup guide" button now replays the welcome questions.
$('#setupBtn')?.addEventListener('click', async () => {
  await obHydrate().catch(() => {});
  ob.i = 0;
  JobPilot.screens.go('welcome');
  obRender();
});

/* ===========================================================================
 * ASKED AT THE LAST MOMENT
 *
 * Two things JobPilot genuinely cannot do without, and neither is asked during
 * the welcome questions:
 *
 *   · an AI service — asked the first time a search has to read a job advert
 *   · email details — asked the first time applications are ready to go out
 *
 * Both hang off the buttons that start the work, on the capture phase, so the
 * existing handlers are untouched: if the answer is "yes, go ahead" the click is
 * simply replayed once the question is answered.
 * ======================================================================== */

let obGateFor = null;      // the button waiting on the answer
let obGateReplaying = false;
let obAiWaived = false;    // "carry on without one" — for this session
let obEmailWaived = false;

function obGateOpen(kind, btn, html) {
  obGateFor = btn;
  $('#obGateKicker').textContent = kind === 'ai' ? 'Before we look' : 'Before these go out';
  $('#obGateBody').innerHTML = html;
  $('#obGate').classList.remove('jp-hidden');
  const first = $('#obGateBody').querySelector('.jp-choice, input, button');
  if (first) first.focus({ preventScroll: true });
}

function obGateClose() {
  $('#obGate').classList.add('jp-hidden');
  obGateFor = null;
}

// Replay the click that was interrupted, now that the answer exists.
async function obGateProceed() {
  const btn = obGateFor;
  obGateClose();
  await refresh().catch(() => {});
  if (!btn || !document.contains(btn) || btn.disabled) return;
  obGateReplaying = true;
  btn.click();
  obGateReplaying = false;
}

function obAiGateHtml(s) {
  const cc = s.claudeCode || {};
  const plan = cc.plan ? ` on the ${cc.plan} plan` : '';
  return `
    <h2 class="jp-h2">Choose who writes for you</h2>
    <p class="jp-lede jp-ob-lede">JobPilot uses an AI service to read job adverts and write your CVs and
      emails. This is the first time it actually needs one — pick whichever suits you, and you can
      change it whenever you like.</p>
    ${cc.available ? `
      <button type="button" class="jp-choice is-on" data-ai="claude_code">
        <div class="jp-choice-title">Use your Claude subscription — nothing to paste</div>
        <div class="jp-choice-sub">You're already signed in to Claude on this computer${esc(plan)}, so
          there is nothing to set up and nothing more to pay.</div>
      </button>` : ''}
    <button type="button" class="jp-choice${cc.available ? '' : ' is-on'}" data-ai="groq">
      <div class="jp-choice-title">Get a free key from Groq</div>
      <div class="jp-choice-sub">Free to use. Make an account, copy the long code it shows you, paste it
        below — about two minutes.</div>
    </button>
    <div id="obAiKeyBox" class="${cc.available ? 'jp-hidden' : ''}">
      <label class="jp-field">
        <span class="jp-field-label">Paste the code here</span>
        <input class="jp-input jp-input--md" type="password" id="obGroqKey" autocomplete="off"
          placeholder="${s.groqKeySet ? 'already saved — paste a new one to replace it' : 'it starts with gsk_'}">
        <span class="jp-field-help"><a href="https://console.groq.com/keys" target="_blank" rel="noopener">Open
          the page that gives you one ↗</a></span>
      </label>
    </div>
    ${cc.available ? '' : `<p class="jp-note">Have a Claude Pro or Max subscription? You can use that
      instead of a key — sign in to Claude on this computer and it will show up here.</p>`}
    <div class="jp-btns jp-ob-gate-btns">
      <button type="button" class="jp-btn jp-btn--primary" id="obAiSave">Save and carry on</button>
      <button type="button" class="jp-btn jp-btn--link" id="obAiWaive">Carry on without one for now</button>
    </div>
    <p class="jp-note" id="obAiMsg" aria-live="polite"></p>
    <p class="jp-note jp-ob-gate-note">Without one we can still go and look, and show you what turns up.
      We just can't read each job closely or write your applications until you come back to this.</p>`;
}

function obEmailGateHtml(s) {
  return `
    <h2 class="jp-h2">Which email should these come from?</h2>
    <p class="jp-lede jp-ob-lede">We send each application from your own address, so replies come
      straight back to you and we can spot them. This is the first time we've needed it.</p>
    <label class="jp-field">
      <span class="jp-field-label">Your name, as it should appear on the email</span>
      <input class="jp-input jp-input--md" id="obFromName" value="${esc(s.fromName || ob.name || '')}" autocomplete="name">
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Your Gmail address</span>
      <input class="jp-input jp-input--md" id="obSmtpUser" type="email" autocomplete="off"
        value="${esc(s.smtpUser || '')}" placeholder="you@gmail.com">
    </label>
    <label class="jp-field">
      <span class="jp-field-label">The 16-letter password Google gives apps</span>
      <input class="jp-input jp-input--md" id="obSmtpPass" type="password" autocomplete="off"
        placeholder="abcd efgh ijkl mnop">
      <span class="jp-field-help">This is not your normal Google password, it only works for sending and
        reading mail, it stays on this computer, and you can cancel it at any time.</span>
    </label>
    <details class="jp-ob-help">
      <summary class="jp-note">Where do I find that?</summary>
      <ol class="jp-note">
        <li>Open your Google Account and go to <b>Security</b></li>
        <li>Switch on <b>2-Step Verification</b> if it isn't on already</li>
        <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App
          passwords</a> and make one called "JobPilot"</li>
        <li>Google shows you 16 letters — copy them into the box above</li>
      </ol>
    </details>
    <div class="jp-btns jp-ob-gate-btns">
      <button type="button" class="jp-btn jp-btn--primary" id="obEmailSave">Save and send them</button>
      <button type="button" class="jp-btn jp-btn--link" id="obEmailWaive">I'll send them myself</button>
    </div>
    <p class="jp-note" id="obEmailMsg" aria-live="polite"></p>
    <p class="jp-note jp-ob-gate-note">Without this JobPilot still writes every application and hands it
      to you to send by hand. That is a perfectly good way to use it.</p>`;
}

$('#obGateClose')?.addEventListener('click', () => obGateClose());
$('#obGate')?.addEventListener('click', e => { if (e.target.id === 'obGate') obGateClose(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#obGate')?.classList.contains('jp-hidden')) { e.preventDefault(); obGateClose(); }
});

$('#obGateBody')?.addEventListener('click', async e => {
  const choice = e.target.closest('[data-ai]');
  if (choice) {
    $('#obGateBody').querySelectorAll('[data-ai]').forEach(c => c.classList.toggle('is-on', c === choice));
    $('#obAiKeyBox').classList.toggle('jp-hidden', choice.dataset.ai !== 'groq');
    if (choice.dataset.ai === 'groq') $('#obGroqKey')?.focus();
    return;
  }
  if (e.target.closest('#obAiSave')) return obAiSave(e.target.closest('#obAiSave'));
  if (e.target.closest('#obAiWaive')) {
    obAiWaived = true;
    obGateProceed();
    return;
  }
  if (e.target.closest('#obEmailSave')) return obEmailSave(e.target.closest('#obEmailSave'));
  if (e.target.closest('#obEmailWaive')) {
    obEmailWaived = true;
    try { await obSave({ sendingMode: 'myself' }); } catch { /* the choice still holds for this session */ }
    obGateClose();
    await refresh().catch(() => {});
    toast("Fine — every one of them is written and waiting. Open a job to copy the message and take the CV, and send it whenever suits you.");
    return;
  }
});

async function obAiSave(btn) {
  const picked = $('#obGateBody').querySelector('[data-ai].is-on')?.dataset.ai || 'groq';
  const key = $('#obGroqKey')?.value.trim() || '';
  const msg = $('#obAiMsg');
  if (picked === 'groq' && !key) {
    msg.textContent = 'Paste the code from that page into the box first.';
    $('#obGroqKey')?.focus();
    return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="jp-spinner"></span> Checking…';
  msg.textContent = '';
  try {
    await obSave(picked === 'claude_code' ? { provider: 'claude_code' } : { provider: 'groq', groqKey: key });
    await api('/api/settings/test-ai', { method: 'POST' }); // one tiny real request — a bad paste says so now
    btn.disabled = false;
    btn.textContent = label;
    toast('All set — carrying on.');
    obGateProceed();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    msg.textContent = err.message;
  }
}

async function obEmailSave(btn) {
  const msg = $('#obEmailMsg');
  const user = $('#obSmtpUser').value.trim();
  const pass = $('#obSmtpPass').value.trim();
  if (!user) { msg.textContent = 'We need the address these should come from.'; $('#obSmtpUser').focus(); return; }
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="jp-spinner"></span> Checking…';
  msg.textContent = '';
  try {
    await obSave({ fromName: $('#obFromName').value.trim(), smtpUser: user, smtpPass: pass, sendingMode: 'jobpilot' });
    await api('/api/settings/test-email', { method: 'POST' }); // sends them one mail, so they can see it worked
    btn.disabled = false;
    btn.textContent = label;
    toast(`We sent a test to ${user} — have a look in your inbox (and the spam folder).`);
    obGateProceed();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    msg.textContent = err.message;
  }
}

// The interception itself. Capture phase on the document, so it runs before the
// button's own handler and can hold the click back without touching that code.
//
// Any screen can opt a button in: put `data-needs-ai` on anything that starts a
// search or writes something, and `data-needs-email` on anything that sends. The
// question is asked, the answer is saved, and then the click happens as normal.
document.addEventListener('click', e => {
  if (obGateReplaying) return;
  const btn = e.target.closest('#smartBtn, #searchBtn, [data-needs-ai], [data-needs-email]');
  if (!btn) return;
  const s = JobPilot.data?.settings;
  if (!s) return;
  const action = btn.hasAttribute('data-needs-email') ? 'send'
    : btn.hasAttribute('data-needs-ai') || btn.id === 'searchBtn' ? 'fetch'
    : (btn.dataset.action || 'fetch');
  const stop = () => { e.preventDefault(); e.stopPropagation(); };

  // "Add your CV" is the answer to a question, not something that needs one.
  if (action === 'cv') return;

  if (action === 'send') {
    // The gate is what stops real mail going out from an address nobody has
    // confirmed. It used to be skipped whenever `sendingMode` was anything but
    // 'jobpilot' — which is exactly the person who never agreed to send by
    // email at all. Only an address already set up, or an explicit "I'll send
    // them myself" answered here, closes it.
    if (s.smtpConfigured || obEmailWaived) return;
    stop();
    obGateOpen('email', btn, obEmailGateHtml(s));
    return;
  }
  if (!s.llmReady && !obAiWaived) {
    stop();
    obGateOpen('ai', btn, obAiGateHtml(s));
  }
}, true);
// Self-scheduling refresh: poll every 3s while a run step is executing (so the
// live status and counts update in near-real-time), otherwise every 30s.
function scheduleRefresh() {
  clearTimeout(state._refreshTimer);
  const delay = activeOp() ? 3000 : 30000;
  state._refreshTimer = setTimeout(async () => {
    try { await refresh(); } catch { /* keep looping through transient errors */ }
    scheduleRefresh();
  }, delay);
}

// First run: ask the five welcome questions instead of dropping someone into a
// dashboard full of empty columns. The server decides who sees them — finished
// or skipped means never again, and an install that already has a CV, some
// applications or any settings at all is left alone (see welcomeNeeded).
(async () => {
  await refresh();
  if (state.settings?.welcomeNeeded && JobPilot.screens.current() !== 'welcome') {
    JobPilot.screens.go('welcome');
  }
  scheduleRefresh();
})();

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


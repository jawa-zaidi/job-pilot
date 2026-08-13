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
 * MY JOBS — four row lists, and the slide-over panel for one job.
 *
 * The store keeps nine statuses; this screen shows four groups (see COLUMNS at
 * the top of the file) and never prints a status name at a person. A row opens
 * the panel, and the panel is the only place a job can be acted on — it carries
 * every action the old detail drawer had.
 *
 * Nothing here polls. It renders from the shared `jobpilot:data` snapshot, and
 * re-renders only when the markup would actually change, so a background
 * refresh never steals the scroll position or the sentence being typed.
 * ======================================================================== */

// ---------- Plain English ----------

// "SW" for Swiggy, "ZR" for Zerodha — the tile at the start of every row.
function initialsOf(name) {
  const parts = String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  // Two letters always: "Swiggy" → SW, "Postman Labs" → PL.
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// The match score never reaches a human. It becomes three words.
function fitWords(a) {
  const s = a.matchScore || 0;
  if (s >= 75) return { word: 'strong fit', badge: ' jp-badge--good', card: ' jp-card--good', why: '' };
  if (s >= 55) return { word: 'good fit', badge: ' jp-badge--warn', card: ' jp-card--warn', why: ' jp-why--warn' };
  return { word: 'weak fit', badge: '', card: '', why: ' jp-why--plain' };
}

// "today", "yesterday", "3 days ago", "3 weeks ago" — never a timestamp.
function agoWords(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return `${Math.round(d / 7)} weeks ago`;
}

// The same gap said as a length of time: "9 days", "3 weeks".
function spanWords(ts) {
  const d = Math.max(0, Math.floor((Date.now() - (ts || Date.now())) / 86400000));
  if (d < 14) return `${d} day${d === 1 ? '' : 's'}`;
  return `${Math.round(d / 7)} weeks`;
}

function nudgeWords(n) {
  if (!n) return '';
  return ' · nudged ' + (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
}

// A date that hasn't happened yet, said the way a person would.
function dayWords(ts) {
  const days = Math.round((ts - Date.now()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  const d = new Date(ts);
  if (days < 7) return 'on ' + d.toLocaleDateString(undefined, { weekday: 'long' });
  return 'on ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// The right-hand line on a row: what happened, in the fewest true words.
function jobStateWords(a) {
  const nudge = nudgeWords((a.followups || []).length);
  switch (a.status) {
    case 'action':     return a.recipientEmail && sendsHerself() ? 'yours to send' : 'apply on their site';
    case 'discovered': return `found ${agoWords(a.createdAt)}`;
    case 'approved':   return 'we write it next';
    case 'ready':      return 'ready to send';
    case 'applied':
    case 'followup':   return a.appliedAt ? `sent ${agoWords(a.appliedAt)}${nudge}` : 'ready to send';
    case 'replied':    return 'they replied';
    case 'interview':  return 'they want to meet you';
    case 'offer':      return 'they offered you the job';
    case 'rejected':   return 'they said no';
    case 'closed':     return a.appliedAt ? `no reply after ${spanWords(a.appliedAt)}` : 'closed';
    default:           return '';
  }
}

// The one line at the top of the open panel.
const PANEL_STATE_WORDS = {
  action: 'Waiting on you',
  discovered: 'We found this for you',
  approved: 'We write it next',
  ready: 'Ready to send',
  applied: 'Waiting to hear back',
  followup: 'Waiting to hear back',
  replied: 'They replied',
  interview: 'They want to meet you',
  offer: 'They offered you the job',
  rejected: 'They said no',
  closed: 'No reply'
};

// Where we found it, without naming a scraper.
function sourceWords(src) {
  const s = String(src || '');
  if (!s) return '';
  if (/career page/i.test(s)) return 'found on their own careers page';
  if (/linkedin/i.test(s)) return 'found on LinkedIn';
  if (/remotive|remoteok|arbeitnow/i.test(s)) return 'found on a free job board';
  return `found on ${s}`;
}

// ---------- The four buckets ----------

// Every job goes in exactly one bucket. An unrecognised status lands in
// "We're waiting" rather than disappearing off the screen.
function bucketise(apps) {
  const cols = COLUMNS.map(c => ({ ...c, rows: [] }));
  for (const a of apps || []) {
    const i = COLUMNS.findIndex(c => c.statuses.includes(a.status));
    cols[i === -1 ? WAITING_BUCKET : i].rows.push(a);
  }
  return cols;
}

function bucketNote(col, n) {
  const jobs = `${n} job${n === 1 ? '' : 's'}`;
  if (col.id === 'needsyou') return `${jobs} · about ${Math.max(2, Math.round(n * 1.5))} minutes`;
  if (col.id === 'waiting') return `${jobs} · nothing for you to do`;
  return jobs;
}

// ---------- The screen ----------

function jobRowHtml(a) {
  const fit = fitWords(a);
  const where = [a.company, a.location].filter(Boolean).join(' · ');
  return `
    <div class="jp-row jp-row--tap" data-job="${esc(a.id)}" role="button" tabindex="0">
      <span class="jp-avatar jp-avatar--sm">${esc(initialsOf(a.company))}</span>
      <div class="jp-row-main">
        <div class="jp-row-title jp-row-title--light">${esc(a.title)}</div>
        <div class="jp-row-sub jp-row-sub--sm">${esc(where)}</div>
      </div>
      <span class="jp-row-meta">${esc(jobStateWords(a))}</span>
      <span class="jp-badge${fit.badge}">${fit.word}</span>
    </div>`;
}

function jobsSkeletonHtml() {
  const row = `
    <div class="jp-skel-row">
      <div class="jp-skel jp-skel--avatar"></div>
      <div class="jp-skel-body"><div class="jp-skel jp-skel--title"></div><div class="jp-skel jp-skel--text"></div></div>
      <div class="jp-skel jp-skel--pill"></div>
    </div>`;
  return `
    <div class="jp-page">
      <h1 class="jp-title">My jobs</h1>
      <p class="jp-lede" style="margin:6px 0 26px">Everything JobPilot has found for you, in plain English.</p>
      <div class="jp-loading" style="margin-bottom:14px"><span class="jp-dot jp-dot--live"></span> Getting your jobs…</div>
      <div class="jp-card jp-card--flush">${row.repeat(3)}</div>
    </div>`;
}

function jobsEmptyHtml() {
  return `
    <div class="jp-page">
      <h1 class="jp-title">My jobs</h1>
      <p class="jp-lede" style="margin:6px 0 26px">Everything JobPilot finds for you will live here.</p>
      <div class="jp-empty">
        <div class="jp-empty-icon">✈</div>
        <h2 class="jp-h2">Nothing here yet — that's normal</h2>
        <p class="jp-lede">Your first search takes about a minute. We'll look at company career
          pages and free job boards, then show you what fits.</p>
        <button class="jp-btn jp-btn--primary" id="jobsFindFirst">Find my first jobs</button>
        <p class="jp-note jp-note--center" style="margin-top:16px">Nothing goes to a company until you say so.</p>
      </div>
    </div>`;
}

function jobsScreenHtml(data) {
  const apps = data.applications || [];
  if (!apps.length) return jobsEmptyHtml();

  const sent = data.stats ? data.stats.applied : 0;
  const sentLine = sent ? ` ${sent} sent so far.` : ' Nothing sent yet.';
  const running = data.currentRun && data.currentRun.activeOp === 'fetching'
    ? '<div class="jp-loading" style="margin-bottom:18px"><span class="jp-dot jp-dot--live"></span> Looking for more jobs for you right now…</div>'
    : '';

  const groups = bucketise(apps).filter(col => col.rows.length).map(col => {
    // The old board's bulk "✓ all applied" lives on the group it belongs to.
    // Say "sent" when the person is the one emailing them, "applied" when the
    // company only takes applications on its own form.
    const allByEmail = col.rows.every(a => a.recipientEmail) && sendsHerself(data);
    const bulk = col.id === 'needsyou' && col.rows.length > 1
      ? `<button class="jp-btn jp-btn--secondary jp-btn--xs jp-spacer" id="jobsAllApplied">${allByEmail
        ? "I've sent all of these" : "I've applied to all of these"}</button>`
      : '';
    return `
      <div style="margin-bottom:26px">
        <div class="jp-row-flex" style="gap:10px;margin-bottom:10px">
          <span class="jp-dot ${col.dot}"></span>
          <h2 class="jp-h-sans">${col.label}</h2>
          <span class="jp-muted" style="font-size:15px">${bucketNote(col, col.rows.length)}</span>
          ${bulk}
        </div>
        <div class="jp-card jp-card--flush">
          <div class="jp-list">${col.rows.map(jobRowHtml).join('')}</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="jp-page">
      <h1 class="jp-title">My jobs</h1>
      <p class="jp-lede" style="margin:6px 0 26px">Everything JobPilot has found for you, in plain English.${sentLine}</p>
      ${running}
      ${groups}
      <p class="jp-note jp-note--center">Open any job to read what we wrote, or to tell us what happened.</p>
    </div>`;
}

let jobsHtmlShowing = null; // skip the re-render when nothing actually changed

function renderJobsScreen() {
  const mount = JobPilot.mount('jobs');
  if (!mount) return;
  const html = JobPilot.data ? jobsScreenHtml(JobPilot.data) : jobsSkeletonHtml();
  if (html === jobsHtmlShowing) return;
  jobsHtmlShowing = html;
  mount.innerHTML = html;
  mount.querySelector('#jobsFindFirst')?.addEventListener('click', e => findJobsNow(e.currentTarget));
  mount.querySelector('#jobsAllApplied')?.addEventListener('click', markAllApplied);
}

// The empty state's one button — the same endpoint the big Find button uses.
async function findJobsNow(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span>Looking…';
  try {
    const r = await api('/api/batch/fetch', { method: 'POST', body: {} });
    state.lastRunCost = r.cost; state.lastRunLabel = 'find';
    if (r.reason) toast(r.reason, true);
    else if (r.added) toast(`Found ${r.added} jobs that suit you — have a look through them.` + costSuffix(r.cost));
    else toast('Nothing new that suits you right now. Try again later, or widen what you are looking for in Settings.' + costSuffix(r.cost));
    await refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = label;
}

// Bulk confirm for the "Needs you" group — carried over from the old board.
async function markAllApplied() {
  const waiting = state.applications.filter(a => a.status === 'action');
  const n = waiting.length;
  const allByEmail = n > 0 && waiting.every(a => a.recipientEmail) && sendsHerself();
  if (!confirm((allByEmail
    ? `Tell us you have sent all ${n} of these?\n\n`
    : `Tell us you have applied to all ${n} of these on the companies' own sites?\n\n`)
    + 'Only say yes if you really have — we start reminding you to chase them up from here.')) return;
  try {
    const r = await api('/api/applications/mark-all-applied', { method: 'POST' });
    // You applied to these yourself, so the nudges are yours too — we remind.
    toast(`${r.applied} job${r.applied === 1 ? '' : 's'} moved across — we'll remind you to nudge them on day 3, 5 and 10.`);
    refresh();
  } catch (err) { toast(err.message, true); }
}

// A row opens the panel. Delegated, so a re-render never loses the handler.
document.addEventListener('click', e => {
  const row = e.target.closest('#mount-jobs [data-job]');
  if (row) openDrawer(row.dataset.job);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest && e.target.closest('#mount-jobs [data-job]');
  if (!row) return;
  e.preventDefault();
  openDrawer(row.dataset.job);
});

JobPilot.screens.register('jobs', { onEnter: renderJobsScreen });
document.addEventListener('jobpilot:data', renderJobsScreen);

/* ---------------------------------------------------------------------------
 * The panel — one job, in full. Every action the old drawer had lives here.
 * ------------------------------------------------------------------------ */

let panelHtmlShowing = null;
let jobPanelDownOnScrim = false;

function openDrawer(id) {
  const a = state.applications.find(x => x.id === id);
  if (!a) return;
  state.openId = id;
  panelHtmlShowing = null;
  renderDrawer(a);
  $('#jobPanel').classList.remove('jp-hidden');
  // Always open at the top, even if the last job was read to the bottom.
  const box = document.querySelector('#jobPanel .jp-panel');
  if (box) box.scrollTop = 0;
  document.body.style.overflow = 'hidden'; // the page behind must not scroll
  $('#jobPanelClose')?.focus();
}

function closeDrawer() {
  state.openId = null;
  panelHtmlShowing = null;
  $('#jobPanel')?.classList.add('jp-hidden');
  document.body.style.overflow = '';
}

// Why we think it fits — the reasons the AI gave, as a tick list.
function whyFitHtml(a) {
  const fit = fitWords(a);
  const reasons = (a.matchReasons || []).filter(Boolean).slice(0, 6);
  if (!reasons.length) return '';
  const weak = fit.why === ' jp-why--plain';
  const head = !fit.why ? "A strong fit — here's why we think so"
    : fit.why === ' jp-why--warn' ? "A good fit — here's why we think so"
      : "Not a perfect fit — here's what we found";
  // A tick on "they want experience you do not have" would be a lie, so the
  // weak list gets a plain bullet.
  const mark = weak ? '·' : '✓';
  return `
    <div class="jp-card${fit.card}" style="margin-bottom:20px">
      <div class="jp-h-sans--sm jp-why${fit.why}" style="margin-bottom:8px">${head}</div>
      ${reasons.map(r => `<div class="jp-why-item"><span class="jp-why${fit.why}">${mark}</span><span>${esc(r)}</span></div>`).join('')}
    </div>`;
}

// The one card that says what to do next, if anything.
function actionCardHtml(a) {
  const t = a.tailored;
  const reply = a.replied && a.replied.summary
    ? `<div class="jp-card jp-card--good" style="margin-bottom:20px">
         <span class="jp-eyebrow jp-eyebrow--good">They wrote back</span>
         <p style="margin-top:8px">${esc(a.replied.summary)}</p>
       </div>`
    : '';

  // Yours to send: either the company only takes applications on its own site,
  // or the person told us they press send. Both end in the same honest place —
  // we prepare it, they send it, and nothing is recorded until they say so.
  const yoursToSend = a.status === 'action' || (sendsHerself() && t && !a.appliedAt && !a.applicationSent);
  if (yoursToSend) {
    const byEmail = !!a.recipientEmail;   // there IS somebody to write to
    // A prefilled draft in their own mail app is the shortest honest route from
    // "written" to "sent". The CV cannot ride along in a link, so we say so.
    const mailto = byEmail && t
      ? `mailto:${encodeURIComponent(a.recipientEmail)}?subject=${encodeURIComponent(t.email_subject || '')}&body=${encodeURIComponent(t.email_body || '')}`
      : '';
    const head = byEmail
      ? `This one is yours to send to ${esc(a.company)}`
      : `${esc(a.company)} only take applications on their own site`;
    const lede = byEmail
      ? (t
        ? `You send your own applications, so we have written it and left it here. Open it in your email, attach the CV below, and tell us once it has gone — we start the reminders from then.`
        : 'You send your own applications. Write it first, then it is ready to go whenever you are.')
      : (t
        ? "Everything is ready. Open their form, upload the CV we wrote, paste the message, then tell us you have done it — we keep track from there and tell you when it's time to nudge them."
        : "Open their form and apply, then tell us you have done it — we keep track from there and tell you when it's time to nudge them.");
    const openBtn = byEmail
      ? (mailto ? `<a class="jp-btn jp-btn--primary jp-btn--sm" href="${esc(mailto)}">Open it in your email</a>` : '')
      : (a.url ? `<a class="jp-btn jp-btn--primary jp-btn--sm" href="${esc(a.url)}" target="_blank" rel="noopener">Open their form</a>` : '');
    return reply + `
      <div class="jp-card jp-card--accent" style="margin-bottom:22px">
        <span class="jp-eyebrow jp-eyebrow--accent">Your turn</span>
        <div class="jp-h-sans" style="margin:6px 0">${head}</div>
        <p class="jp-lede" style="margin-bottom:16px">${lede}</p>
        <div class="jp-btns">
          ${openBtn}
          ${t ? `<a class="jp-btn jp-btn--quiet jp-btn--sm" href="/api/applications/${esc(a.id)}/cv.pdf">Download my CV (PDF)</a>` : ''}
          ${t ? '<button class="jp-btn jp-btn--quiet jp-btn--sm" id="jobCopyMsg">Copy the message</button>' : ''}
          ${t ? '<button class="jp-btn jp-btn--quiet jp-btn--sm" id="jobCopyCv">Copy the CV text</button>' : ''}
          ${t ? '' : '<button class="jp-btn jp-btn--quiet jp-btn--sm" id="jobWriteBtn">Write my CV and message</button>'}
          ${byEmail && !a.url ? '' : (byEmail && a.url ? `<a class="jp-btn jp-btn--quiet jp-btn--sm" href="${esc(a.url)}" target="_blank" rel="noopener">Read the advert</a>` : '')}
        </div>
        <button class="jp-btn jp-btn--good jp-btn--block jp-btn--sm" id="jobAppliedBtn" style="margin-top:12px">${byEmail
          ? "I've sent it — start tracking it" : "I've applied — start tracking it"}</button>
      </div>`;
  }

  if (!t && !a.appliedAt) {
    return reply + `
      <div class="jp-card jp-card--accent" style="margin-bottom:22px">
        <span class="jp-eyebrow jp-eyebrow--accent">Next</span>
        <div class="jp-h-sans" style="margin:6px 0">We haven't written your application yet</div>
        <p class="jp-lede" style="margin-bottom:16px">We rewrite your CV for this one job and draft a short message to go
          with it. Nothing invented — only what is already in your real CV.</p>
        <div class="jp-btns">
          <button class="jp-btn jp-btn--primary jp-btn--sm" id="jobWriteBtn">Write my CV and message</button>
          ${a.url ? `<a class="jp-btn jp-btn--quiet jp-btn--sm" href="${esc(a.url)}" target="_blank" rel="noopener">Read the advert</a>` : ''}
        </div>
      </div>`;
  }

  if (t && !a.applicationSent && !a.appliedAt) {
    return reply + `
      <div class="jp-card jp-card--accent" style="margin-bottom:22px">
        <span class="jp-eyebrow jp-eyebrow--accent">Ready</span>
        <div class="jp-h-sans" style="margin:6px 0">Your application is written and ready</div>
        <p class="jp-lede" style="margin-bottom:16px">${a.recipientEmail
      ? `We'll email it to ${esc(a.recipientEmail)} with your CV attached as a PDF, then chase it up on day 3, 5 and 10.`
      : 'Add an address below and we can send it for you, or apply on their own site and tell us you have done it.'}</p>
        <div class="jp-btns">
          <button class="jp-btn jp-btn--primary jp-btn--sm" id="jobSendBtn">Send it now</button>
          <a class="jp-btn jp-btn--quiet jp-btn--sm" href="/api/applications/${esc(a.id)}/cv.pdf">Download my CV (PDF)</a>
          <button class="jp-btn jp-btn--quiet jp-btn--sm" id="jobAppliedBtn">I applied myself — track it</button>
          <button class="jp-btn jp-btn--quiet jp-btn--sm" id="jobWriteBtn">Write it again</button>
        </div>
      </div>`;
  }

  // Already sent: the draft is still there to re-read, re-write or download.
  // Once a job is over, none of that is worth offering.
  const over = ['rejected', 'closed'].includes(a.status);
  return reply + (t && !over ? `
      <div class="jp-btns" style="margin-bottom:22px">
        <button class="jp-btn jp-btn--quiet jp-btn--sm" id="jobWriteBtn">Write it again</button>
        <a class="jp-btn jp-btn--quiet jp-btn--sm" href="/api/applications/${esc(a.id)}/cv.pdf">Download my CV (PDF)</a>
      </div>` : '');
}

function applicationSentWords(a) {
  const s = a.applicationSent;
  if (!s) return `You applied ${agoWords(a.appliedAt)}`;
  if (s.manual) return `You did it yourself, ${agoWords(s.at)}`;
  if (s.simulated) return `${agoWords(s.at)} — a practice run, so nothing really left this computer`;
  return `${agoWords(s.at)} → ${esc(s.to || 'them')}`;
}

// "What happens next": the real follow-up plan, with the real dates, and an
// "I've done it" button on anything due that has to be done by hand.
function nextStepsHtml(a) {
  const step = (tone, mark, title, sub, end = '') => `
    <div class="jp-row jp-row--top">
      <span class="jp-avatar jp-avatar--xs jp-avatar--round${tone ? ' jp-avatar--' + tone : ''}">${mark}</span>
      <div class="jp-row-main">
        <div class="jp-row-title jp-row-title--light">${title}</div>
        <div class="jp-row-sub jp-row-sub--sm">${sub}</div>
      </div>
      ${end ? `<div class="jp-row-end">${end}</div>` : ''}
    </div>`;

  const rows = [];
  const stopped = !!a.replied || ['replied', 'interview', 'offer', 'rejected', 'closed'].includes(a.status);
  // Not "is there an address" — "will JobPilot actually be the one emailing".
  // Those came apart the moment somebody chose to send their own applications.
  const byEmail = chasedByUs(a);
  const mine = sendsHerself();

  if (!a.appliedAt) {
    const yours = mine || a.status === 'action';
    rows.push(yours
      ? step('accent', '1',
        a.recipientEmail && mine ? 'You send it' : 'You apply on their site',
        a.recipientEmail && mine
          ? `The message and your CV are written — send it to ${esc(a.recipientEmail)} whenever suits you`
          : 'Two minutes with the CV and the message above')
      : step('accent', '1', a.recipientEmail ? 'We email it for you' : 'You send it, or we do',
        a.recipientEmail ? `Straight to ${esc(a.recipientEmail)}, with your CV attached as a PDF`
          : 'Add an address below and we send it — otherwise you apply on their own site'));
    rows.push(yours
      ? step('', '2', 'We remind you on day 3, 5 and 10', 'A line here each time, so nothing goes quiet by accident')
      : step('', '2', 'We remind them on day 3, 5 and 10', 'Politely, and we stop the moment somebody replies'));
    rows.push(step('', '3', 'We watch for a reply', 'Anything that comes back shows up here, in plain words'));
  } else {
    rows.push(step('good', '✓',
      a.applicationSent && a.applicationSent.manual ? 'You applied on their site' : 'Your application went out',
      applicationSentWords(a)));
    let n = 1;
    for (const day of [3, 5, 10]) {
      n++;
      const done = (a.followups || []).find(f => f.day === day);
      const due = a.appliedAt + day * 86400000;
      if (done) {
        const how = done.manual ? 'you did this one yourself'
          : done.simulated ? 'a practice run, so nothing really left this computer'
            : `sent to ${esc(done.to || 'them')}`;
        const letter = done.email ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:14px;color:var(--accent)">Read what we sent</summary>
            <div class="jp-doc jp-doc--sm jp-doc--scroll" style="margin-top:8px">${esc(done.email.subject || '')}\n\n${esc(done.email.body || '')}</div>
          </details>` : '';
        rows.push(step('good', String(n), `We nudged them on day ${day}`, `${agoWords(done.sentAt)} · ${how}${letter}`));
      } else if (stopped) {
        rows.push(step('', String(n), `The day ${day} nudge is off`,
          a.replied ? 'They wrote back, so we stopped chasing' : 'This one is finished, so we stopped chasing'));
      } else if (Date.now() >= due && !byEmail) {
        rows.push(step('warn', String(n), `Time to nudge them — day ${day}`,
          'Message them wherever you applied, then tell us it is done',
          `<button class="jp-btn jp-btn--good jp-btn--xs jp-fu-done" data-day="${day}">I've done it</button>`));
      } else if (Date.now() >= due) {
        rows.push(step('warn', String(n), `The day ${day} nudge is due`, 'It goes out on the next check — nothing for you to do'));
      } else {
        rows.push(step('', String(n), `We nudge them on day ${day}`,
          byEmail ? `${dayWords(due)}, automatically` : `${dayWords(due)} — we'll remind you here`));
      }
    }
    rows.push(step('', String(n + 1), 'We watch for a reply',
      byEmail ? 'We read your inbox for anything from them and tell you in plain words'
        : mine ? 'Replies come straight to you. Tell us the moment you hear anything and we stop chasing.'
          : 'Got an email from them? Paste their address below and we take over the chasing'));
  }

  return `
    <h2 class="jp-h-sans" style="margin:26px 0 4px">What happens next</h2>
    <div class="jp-list jp-list--ruled jp-list--flat">${rows.join('')}</div>`;
}

function renderDrawer(a) {
  const t = a.tailored;
  const where = [a.company, a.location, sourceWords(a.source)].filter(Boolean).join(' · ');

  const check = a.qualityCheck && a.qualityCheck.checked && !a.qualityCheck.ok
    ? `<div class="jp-card jp-card--warn" style="margin-bottom:20px">
         <div class="jp-h-sans--sm jp-why--warn" style="margin-bottom:6px">We corrected this draft</div>
         <p class="jp-note">Checking it against your real CV turned up: ${esc((a.qualityCheck.problems || []).slice(0, 3).join('; '))}. That has been fixed.</p>
       </div>`
    : '';

  const contact = a.recruiterName
    ? `<p class="jp-note" style="margin:-12px 0 18px">Their hiring contact: ${esc(a.recruiterName)}${a.recruiterUrl
      ? ` · <a href="${esc(a.recruiterUrl)}" target="_blank" rel="noopener">see their profile →</a>` : ''}</p>`
    : '';

  const letter = t ? `
    <h2 class="jp-h-sans" style="margin:0 0 6px">The message we wrote</h2>
    <p class="jp-note" style="margin-bottom:10px">Subject line: ${esc(t.email_subject || '')}</p>
    <div class="jp-doc">${esc(t.email_body || '')}</div>
    <div class="jp-row-flex" style="margin:12px 0 26px">
      <input class="jp-input jp-input--sm" id="jobFixInput" style="flex:1"
        placeholder="Want it different? e.g. &ldquo;shorter&rdquo;, &ldquo;mention my fintech work&rdquo;">
      <button class="jp-btn jp-btn--secondary jp-btn--sm" id="jobFixBtn">Rewrite it</button>
    </div>` : '';

  const keywords = t && (t.keywords_used || []).length
    ? ` We made sure their own words are in there: ${esc(t.keywords_used.slice(0, 6).join(', '))}.` : '';

  const cv = t ? `
    <h2 class="jp-h-sans" style="margin:0 0 6px">Your CV for this job</h2>
    <p class="jp-note" style="margin-bottom:10px">Same facts as your real CV — reordered so the things ${esc(a.company)}
      asked for come first. Nothing invented; we checked.${keywords}</p>
    <div class="jp-doc jp-doc--sm jp-doc--scroll">${esc(t.cv || '')}</div>
    <div class="jp-btns" style="margin-top:12px">
      <a class="jp-btn jp-btn--quiet jp-btn--sm" href="/api/applications/${esc(a.id)}/cv.pdf">Download my CV (PDF)</a>
      <button class="jp-btn jp-btn--quiet jp-btn--sm" id="jobCopyCv2">Copy the CV text</button>
    </div>` : '';

  const stillOpen = !['rejected', 'closed'].includes(a.status);

  const html = `
    <h1 class="jp-h2">${esc(a.title)}</h1>
    <p class="jp-lede" style="font-size:17px;margin:6px 0 20px">${esc(where)}${a.url
      ? ` · <a href="${esc(a.url)}" target="_blank" rel="noopener">read the advert →</a>` : ''}</p>
    ${contact}
    ${whyFitHtml(a)}
    ${check}
    ${actionCardHtml(a)}

    <label class="jp-field">
      <span class="jp-field-label">Who to email at the company</span>
      <input class="jp-input jp-input--sm" type="email" id="jobRecipient" value="${esc(a.recipientEmail || '')}"
        placeholder="${a.recipientEmail ? 'name@company.com' : 'nobody in the advert — paste an address and we can send it'}">
      <span class="jp-field-help">With an address here we send the application and every nudge by email, and we
        read the replies. Leave it empty and you apply on their own site instead.</span>
    </label>

    ${letter}
    ${cv}
    ${nextStepsHtml(a)}

    <h2 class="jp-h-sans" style="margin:26px 0 10px">What the advert says</h2>
    <div class="jp-doc jp-doc--sm jp-doc--scroll">${esc(a.description || 'The advert came without a description.')}</div>

    ${stillOpen ? `
      <div class="jp-card jp-card--quiet jp-card--tight" style="margin-top:22px">
        <div class="jp-row-flex">
          <div class="jp-row-main">
            <div class="jp-h-sans--sm">Heard something we haven't?</div>
            <div class="jp-note">Tell us and we stop chasing this one.</div>
          </div>
          <button class="jp-btn jp-btn--secondary jp-btn--xs jp-spacer" id="jobRejectBtn">They said no</button>
        </div>
      </div>` : ''}`;

  const stateEl = $('#jobPanelState');
  if (stateEl) stateEl.textContent = PANEL_STATE_WORDS[a.status] || 'This job';
  const body = $('#jobPanelBody');
  if (!body) return;

  // A background refresh must not wipe the sentence somebody is typing.
  if (html === panelHtmlShowing) return;
  const draft = $('#jobFixInput') ? $('#jobFixInput').value : '';
  panelHtmlShowing = html;
  body.innerHTML = html;
  if (draft && $('#jobFixInput')) $('#jobFixInput').value = draft;

  bindPanel(a);
}

function bindPanel(a) {
  const t = a.tailored;

  $('#jobRecipient')?.addEventListener('change', async e => {
    try {
      await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { recipientEmail: e.target.value } });
      toast(e.target.value.trim()
        ? 'Saved — we can email this one for you now'
        : 'Saved — you apply on their own site for this one');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  $('#jobWriteBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="jp-spinner"></span>Writing…';
    try {
      await api(`/api/applications/${a.id}/tailor`, { method: 'POST' });
      toast('Written — have a read below and change anything you like');
      await refresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = label; }
  });

  async function runFix() {
    const feedback = $('#jobFixInput').value.trim();
    if (!feedback) return toast('Tell us what to change first', true);
    const btn = $('#jobFixBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="jp-spinner"></span>Rewriting…';
    try {
      await api(`/api/applications/${a.id}/tailor`, { method: 'POST', body: { feedback } });
      panelHtmlShowing = null;
      $('#jobFixInput').value = ''; // the instruction is spent
      toast('Rewritten — have a look');
      await refresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Rewrite it'; }
  }
  $('#jobFixBtn')?.addEventListener('click', runFix);
  $('#jobFixInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runFix(); });

  $('#jobSendBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    const recipient = ($('#jobRecipient')?.value || '').trim();
    // Nothing goes out without a person saying yes to this exact sentence, and
    // nothing is recorded as sent when there is nobody to send it to.
    if (!recipient) {
      toast("There's nobody to send this one to yet. Put an address in the box above, or apply on their own site and tell us you've done it.", true);
      return;
    }
    if (!confirm(`Send this application to ${recipient} now, with your CV attached?`)) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="jp-spinner"></span>Sending…';
    try {
      if (recipient !== (a.recipientEmail || '')) {
        await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { recipientEmail: recipient } });
      }
      const res = await api(`/api/applications/${a.id}/apply`, { method: 'POST' });
      toast(res.simulated
        ? "Sent as a practice run, because your email isn't connected yet. We'll still chase it up on day 3, 5 and 10."
        : `Sent to ${recipient} — we'll chase it up on day 3, 5 and 10.`);
      await refresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Send it now'; }
  });

  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text || ''); toast(`${label} copied — paste it into their form`); }
    catch { toast('That did not copy — select the text below and copy it by hand', true); }
  };
  $('#jobCopyCv')?.addEventListener('click', () => copy(t && t.cv, 'Your CV'));
  $('#jobCopyCv2')?.addEventListener('click', () => copy(t && t.cv, 'Your CV'));
  $('#jobCopyMsg')?.addEventListener('click', () => copy(t && t.email_body, 'The message'));

  $('#jobAppliedBtn')?.addEventListener('click', async () => {
    const byEmail = !!a.recipientEmail && sendsHerself();
    if (!confirm((byEmail
      ? `Have you sent your application for ${a.title} at ${a.company}?\n\n`
      : `Have you applied for ${a.title} at ${a.company} on their own site?\n\n`)
      + "We'll start tracking it and remind you to chase them up.")) return;
    try {
      await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { manualApplied: true } });
      toast("Got it — we're tracking this one now");
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  for (const btn of document.querySelectorAll('#jobPanelBody .jp-fu-done')) {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/applications/${a.id}/followup-done`, { method: 'POST', body: { day: Number(btn.dataset.day) } });
        toast('Noted — that nudge is ticked off');
        await refresh();
      } catch (err) { toast(err.message, true); }
    });
  }

  $('#jobRejectBtn')?.addEventListener('click', async () => {
    if (!confirm(`Did ${a.company} turn you down for this one?\n\nWe'll stop chasing it and keep it under Closed.`)) return;
    try {
      await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { status: 'rejected' } });
      toast("Sorry to hear it — we've stopped chasing this one");
      await refresh();
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- The panel's own chrome ----------

$('#jobPanelClose')?.addEventListener('click', closeDrawer);

// Only a true backdrop click closes: a drag that starts inside the panel and
// ends on the scrim (selecting text) must not throw the whole thing away.
$('#jobPanel')?.addEventListener('mousedown', e => { jobPanelDownOnScrim = e.target.id === 'jobPanel'; });
$('#jobPanel')?.addEventListener('click', e => {
  if (jobPanelDownOnScrim && e.target.id === 'jobPanel') closeDrawer();
  jobPanelDownOnScrim = false;
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.openId) { e.preventDefault(); closeDrawer(); }
});

// "Not interested" — drop the job altogether. The old drawer's Remove.
$('#jobPanelDrop')?.addEventListener('click', async () => {
  const a = state.applications.find(x => x.id === state.openId);
  if (!a) return;
  if (!confirm(`Take ${a.title} at ${a.company} off your list?\n\n`
    + (a.appliedAt
      ? 'You have already applied to this one, so its history goes too.'
      : "We'll stop tracking it and it won't come back."))) return;
  try {
    await api(`/api/applications/${a.id}`, { method: 'DELETE' });
    closeDrawer();
    toast("Gone — we won't bring that one up again");
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ---------- Feedback / mode / target ----------

$('#feedbackBtn')?.addEventListener('click', async () => {
  const text = $('#feedbackInput').value.trim();
  if (!text) return toast('Write the rule first — one line is plenty.', true);
  const kind = $('#feedbackKind').value;
  try {
    await api('/api/feedback', { method: 'POST', body: { text, kind } });
    $('#feedbackInput').value = '';
    const label = { find: 'choosing which jobs to go for', cv: 'writing your CV',
      email: 'writing the message that goes with it' }[kind];
    toast(`Saved — we'll follow that from now on when ${label}.`);
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#modeSelect')?.addEventListener('change', async e => {
  const mode = e.target.value;
  if (mode === 'auto' && !confirm('Let JobPilot run on its own?\n\n'
    + 'It will find jobs, write your applications and send them without stopping to show you first. '
    + 'If your email is connected, those really do go out.')) {
    e.target.value = 'manual';
    return;
  }
  await api('/api/settings', { method: 'POST', body: { mode } });
  toast(mode === 'auto'
    ? "JobPilot will run rounds on its own from now on, and tell you how each one went."
    : "You're back in charge — nothing happens until you press the button.");
  refresh();
});


// ---------- Filters ----------

$('#stageFilter')?.addEventListener('change', e => { filters.stage = e.target.value; renderBoard(); });
$('#dateFrom')?.addEventListener('change', e => { filters.from = e.target.value; renderBoard(); });
$('#dateTo')?.addEventListener('change', e => { filters.to = e.target.value; renderBoard(); });
$('#clearFilters')?.addEventListener('click', () => {
  filters = { stage: 'all', from: '', to: '' };
  $('#stageFilter').value = 'all';
  $('#dateFrom').value = '';
  $('#dateTo').value = '';
  renderBoard();
});

// ---------- Improvement reports ----------

async function openReports() {
  const r = await api('/api/insights');
  $('#reportSub').textContent =
    `Auto-generated every ${r.config.every} applications and after each automated run` +
    (r.config.email ? `, emailed to ${r.config.email}` : '') +
    `. ${r.appliedSinceReport} application(s) since the last report.`;
  $('#reportList').innerHTML = (r.reports || []).map(rep => `
    <div class="report-item">
      <div class="r-head">${esc(rep.subject)}</div>
      <div class="r-sub">${timeAgo(rep.at)} · trigger: ${esc(rep.trigger)}</div>
      <details><summary style="cursor:pointer;font-size:12px;color:var(--accent)">Read report</summary>
      <pre class="doc" style="margin-top:8px">${esc(rep.body)}</pre></details>
    </div>`).join('') || '<p style="color:var(--muted);font-size:13px">No reports yet — apply to some jobs first, or generate one now.</p>';
  $('#reportOverlay').classList.remove('hidden');
}

// Close a modal on a true backdrop click only. A plain click handler also fires
// when a drag STARTS inside the modal (selecting text, sliding over an input)
// and ends on the backdrop — so require mousedown AND mouseup on the backdrop.
function bindOverlayClose(overlayId, close) {
  const el = $('#' + overlayId);
  if (!el) return;
  let downOnBackdrop = false;
  el.addEventListener('mousedown', e => { downOnBackdrop = e.target.id === overlayId; });
  el.addEventListener('click', e => {
    if (downOnBackdrop && e.target.id === overlayId) close();
    downOnBackdrop = false;
  });
}

$('#reportBtn')?.addEventListener('click', () => openReports().catch(err => toast(err.message, true)));
$('#reportClose')?.addEventListener('click', () => $('#reportOverlay').classList.add('hidden'));
bindOverlayClose('reportOverlay', () => $('#reportOverlay').classList.add('hidden'));

$('#reportRunBtn')?.addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Analyzing…';
  try {
    const r = await api('/api/insights/run', { method: 'POST' });
    toast(r.emailed ? `Report generated and emailed to ${r.to}` : 'Report generated — read it below (add Gmail in Settings to receive it by email)');
    await openReports();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = 'Generate report now';
});

// The old "Edit your profile" window is gone. Its only opener lived inside the
// hidden pre-revamp dashboard, so nobody could reach it — and everything it did
// is on the "You" screen, which is reachable from the header and from Settings.

const splitList = (v, sep) => v.split(sep).map(x => x.trim()).filter(Boolean);

// ---------- Collapsible sidebar ----------

function applyNavState() {
  document.body.classList.toggle('nav-collapsed', localStorage.getItem('jp_nav') === 'closed');
}
$('#navToggle')?.addEventListener('click', () => {
  localStorage.setItem('jp_nav', document.body.classList.contains('nav-collapsed') ? 'open' : 'closed');
  applyNavState();
});
applyNavState();

// The old sidebar's "⚙️ Settings & API keys" button now goes to the Settings
// screen. The window it used to open is gone — everything it held is on that
// screen, either in one of the four cards or under "Advanced".
$('#settingsBtn')?.addEventListener('click', () => JobPilot.screens.go('settings'));

/* ===========================================================================
 * SETTINGS — four cards, and one collapsed "Advanced".
 *
 * The old settings window was one scroll of thirty-odd fields under headings
 * like "AI provider & model". This is the same thirty-odd fields, but each of
 * the four things a person actually cares about is a card that says, in plain
 * words, what it is set to right now — and everything else sits in "Advanced",
 * shut, until somebody goes looking for it.
 *
 * Nothing was dropped on the way. Every control the old window had lives in one
 * of these, and every one of them still posts to the same /api/settings with
 * the same field names:
 *
 *   Your CV and details  → the "You" screen (name, CV, what you do)
 *   What you're looking for → jobTitles · jobLocations · remoteOk · atsCompanies
 *                             dailyTarget · maxJobAgeDays · preferLowCompetition
 *                             autoSearch · autoSearchHours
 *   Sending applications → sendingMode · fromName · smtpUser · smtpPass · test
 *   The writer           → provider (the Claude subscription included) · model
 *                          groqKey · openaiKey · anthropicKey · test
 *   Advanced             → sources · apifyToken · adzuna* · promptFind/CV/Email
 *                          factCheck · autoMinScore · companyCooldownDays · mode
 *                          insights* · devFeedbackEnabled · dataDir · reset
 * ======================================================================== */

// What each writer falls back to with the model box left empty. Model names are
// the one place a real name has to appear — there is no plainer word for them.
const SET_MODEL_HINTS = {
  groq: 'Leave it empty for llama-3.3-70b-versatile, the one we recommend. llama-3.1-8b-instant is quicker and rougher.',
  openai: 'Leave it empty for gpt-4o-mini, the one we recommend. gpt-4o writes better and costs more.',
  anthropic: 'Leave it empty for claude-haiku-4-5-20251001, the cheap one. claude-sonnet-5 writes the best CVs.',
  claude_code: 'Leave it empty for claude-haiku-4-5, the lightest on your usage limits. claude-sonnet-5 writes better CVs at no extra charge.'
};

// Which card / advanced row is open. Kept out of the DOM so a background
// refresh can decide not to redraw over somebody who is halfway through typing.
// `touched` records that they have opened or closed a card themselves, which is
// what stops "the writer" from re-opening itself under them (see below).
let setUi = { card: null, row: null, adv: false, touched: false };
let setProfile = null;      // last /api/profile — the CV card and the You screen
let setProfileLoaded = false;

const setMsg = (kind, text, isErr) => {
  const el = document.querySelector(`[data-set-msg="${kind}"]`);
  if (el) { el.textContent = text; el.classList.toggle('jp-set-msg--err', !!isErr); }
};
const setVal = id => ($('#' + id)?.value ?? '').trim();
const setOn = id => !!$('#' + id)?.checked;

async function setLoadProfile(force = false) {
  if (setProfileLoaded && !force) return setProfile;
  try {
    setProfile = (await api('/api/profile')).profile || null;
    setProfileLoaded = true;
  } catch { /* keep whatever we had; the card says "no CV yet" either way */ }
  return setProfile;
}

/* ---- The four state lines, in plain words -------------------------------- */

const setCount = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function setWordsCv(p) {
  if (!p || !p.name) return { text: "No CV yet — we can't write anything until there is one", tone: 'warn' };
  const bits = [p.title || "you haven't said what you do"];
  if (p.years_experience) bits.push(`${p.years_experience} years`);
  return { text: `${p.name} · ${bits.join(', ')}`, tone: '' };
}

function setWordsLooking(s) {
  const titles = (s.jobTitles || []).length;
  const places = (s.jobLocations || []).length;
  const what = titles ? `Looking for ${setCount(titles, 'kind of job', 'kinds of job')}` : 'Looking for whatever suits your CV';
  const where = places ? `in ${setCount(places, 'place', 'places')}` : 'anywhere in the world';
  return { text: `${what} ${where} · up to ${s.dailyTarget} at a time`, tone: '' };
}

function setWordsSending(s) {
  if (s.sendingMode !== 'jobpilot') return { text: 'You send them yourself — we write every one', tone: '' };
  if (s.smtpConfigured) return { text: `Sending as ${s.smtpUser}`, tone: 'good' };
  if (s.smtpUser) return { text: `Ready to send as ${s.smtpUser} — we just need the password Google gives apps`, tone: 'warn' };
  return { text: "We'll send them, but we don't have your email address yet", tone: 'warn' };
}

function setWordsWriter(s, stats) {
  const total = stats ? stats.costTotalUSD : 0;
  const spent = total ? ` · ${fmtCost(total)} spent so far` : ' · nothing spent so far';
  if (s.provider === 'claude_code' && s.claudeCode && s.claudeCode.available) {
    return { text: `Your Claude subscription — nothing more to pay${spent}`, tone: 'good' };
  }
  if (!s.llmReady) {
    return { text: 'Nobody is writing for you yet — this is the one thing still worth doing', tone: 'warn' };
  }
  const names = { groq: 'A free key from Groq', openai: 'Your OpenAI key', anthropic: 'Your Claude key from Anthropic' };
  return { text: `${names[s.provider] || 'Your own key'}${spent}`, tone: '' };
}

/* ---- The page ------------------------------------------------------------ */

const setToneClass = t => t === 'good' ? ' jp-set-state--good' : t === 'warn' ? ' jp-set-state--warn' : '';

// `c.attn` marks a card as unfinished — an accent border, an eyebrow above the
// title and a primary button, so it can never be mistaken for a card that is
// already set up. Only "the writer" uses it, and only until one is connected.
function setCardHtml(c, body) {
  const open = setUi.card === c.id;
  const tone = c.attn && !open ? 'jp-btn--primary' : 'jp-btn--secondary';
  return `
    <div class="jp-card jp-set-card${c.attn ? ' jp-card--accent' : ''}">
      <div class="jp-set-head">
        <span class="jp-avatar jp-avatar--${c.tone}" aria-hidden="true">${c.icon}</span>
        <div class="jp-set-main">
          ${c.attn ? `<span class="jp-eyebrow jp-eyebrow--accent jp-set-eyebrow">${c.attn}</span>` : ''}
          <div class="jp-h-sans--sm">${c.title}</div>
          <div class="jp-set-sub">${c.sub}</div>
          <div class="jp-set-state${setToneClass(c.state.tone)}">${esc(c.state.text)}</div>
        </div>
        ${c.go
          ? `<button type="button" class="jp-btn jp-btn--secondary jp-btn--sm" data-go="${c.go}">${c.cta}</button>`
          : `<button type="button" class="jp-btn ${tone} jp-btn--sm" data-set-card="${c.id}"
               aria-expanded="${open}">${open ? 'Close' : c.cta}</button>`}
      </div>
      ${open && body ? `<div class="jp-set-body">${body()}</div>` : ''}
    </div>`;
}

function setSaveRowHtml(kind, extra = '') {
  return `
    <div class="jp-set-actions">
      <button type="button" class="jp-btn jp-btn--primary jp-btn--sm" data-set-save="${kind}">Save</button>
      ${extra}
      <span class="jp-note" data-set-msg="${kind}" aria-live="polite"></span>
    </div>`;
}

function setLookingBody(s) {
  return `
    <label class="jp-field">
      <span class="jp-field-label">The kinds of job you want</span>
      <input class="jp-input jp-input--sm" id="setTitles" value="${esc((s.jobTitles || []).join(', '))}"
        placeholder="e.g. Frontend Engineer, React Developer">
      <span class="jp-field-help">Everyday words are fine — separate them with commas. Leave it empty and
        we'll go by what your CV says.</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Where you'd like to work</span>
      <input class="jp-input jp-input--sm" id="setPlaces" value="${esc((s.jobLocations || []).join(', '))}"
        placeholder="e.g. Bangalore, India">
      <span class="jp-field-help">Towns, cities or countries, separated by commas. This is the thing that
        keeps jobs to the places you want — leave it empty and jobs from anywhere in the world turn up.</span>
    </label>
    <label class="jp-check">
      <input type="checkbox" id="setRemote" ${s.remoteOk ? 'checked' : ''}>
      <span>Also bring me jobs I can do from home
        <span class="jp-field-help">Untick to hide anything advertised as remote.</span></span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Companies you'd like to work for</span>
      <textarea class="jp-textarea jp-textarea--md" id="setCompanies" rows="2"
        placeholder="stripe, razorpay, postman">${esc(s.atsCompanies || '')}</textarea>
      <span class="jp-field-help">We watch these companies' own careers pages, which is where replies come
        from most often. Use the short name that appears in their careers web address, separated by commas.
        Very big companies usually run a careers site we can't read — if we can't find one, we say so in
        the activity list.</span>
    </label>
    <div class="jp-inline">
      <span>Bring back up to</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="setTarget" type="number" min="1" max="200"
        value="${Number(s.dailyTarget) || 50}">
      <span>jobs each time we look</span>
    </div>
    <p class="jp-note jp-inline-note">One look = find, write, send. Jobs already waiting on you don't count
      towards it.</p>
    <div class="jp-inline">
      <span>Only jobs put up in the last</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="setMaxAge" type="number" min="1" max="90"
        value="${Number(s.maxJobAgeDays) || 30}">
      <span>days</span>
    </div>
    <p class="jp-note jp-inline-note">Fresh postings have far fewer people applying — a week or two is a
      good spot.</p>
    <label class="jp-check">
      <input type="checkbox" id="setLowComp" ${s.preferLowCompetition ? 'checked' : ''}>
      <span>Prefer jobs hardly anyone has applied to
        <span class="jp-field-help">Only LinkedIn tells us this one — it means fewer than ten people so far.</span></span>
    </label>
    <label class="jp-check">
      <input type="checkbox" id="setAutoSearch" ${s.autoSearch ? 'checked' : ''}>
      <span>Keep looking on your own, without me pressing anything
        <span class="jp-field-help">We have a look every few hours and put anything good on your board.</span></span>
    </label>
    <div class="jp-inline">
      <span>Have a look every</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="setAutoHours" type="number" min="1" max="24"
        value="${Number(s.autoSearchHours) || 6}">
      <span>hours</span>
    </div>
    ${setSaveRowHtml('looking')}`;
}

function setSendingBody(s) {
  const mine = s.sendingMode !== 'jobpilot';
  return `
    <button type="button" class="jp-choice${mine ? '' : ' is-on'}" data-send="jobpilot">
      <div class="jp-choice-title">JobPilot sends them for me</div>
      <div class="jp-choice-sub">We email each application from your address and chase it up after 3, 5 and
        10 days. Replies come straight back to you, and we spot them.</div>
    </button>
    <button type="button" class="jp-choice${mine ? ' is-on' : ''}" data-send="myself">
      <div class="jp-choice-title">I'll send them myself</div>
      <div class="jp-choice-sub">We still write every CV and message and remind you when to follow up. You
        press send. Perfectly fine choice.</div>
    </button>
    <div id="setMailBox" class="${mine ? 'jp-hidden' : ''}">
      <label class="jp-field">
        <span class="jp-field-label">Your name, as it should appear on the email</span>
        <input class="jp-input jp-input--sm" id="setFromName" value="${esc(s.fromName || '')}" autocomplete="name">
      </label>
      <label class="jp-field">
        <span class="jp-field-label">Your Gmail address</span>
        <input class="jp-input jp-input--sm" id="setSmtpUser" type="email" autocomplete="off"
          value="${esc(s.smtpUser || '')}" placeholder="you@gmail.com">
      </label>
      <label class="jp-field">
        <span class="jp-field-label">The 16-letter password Google gives apps</span>
        <input class="jp-input jp-input--sm" id="setSmtpPass" type="password" autocomplete="off"
          placeholder="${s.smtpConfigured ? 'already saved — type a new one to replace it' : 'abcd efgh ijkl mnop'}">
        <span class="jp-field-help">This is not your normal Google password, it only works for sending and
          reading mail, it stays on this computer, and you can cancel it at any time. We use it to send your
          applications and to spot the replies.</span>
      </label>
      <details class="jp-help">
        <summary class="jp-note">Where do I find that?</summary>
        <ol class="jp-note">
          <li>Open your Google Account and go to <b>Security</b></li>
          <li>Switch on <b>2-Step Verification</b> if it isn't on already</li>
          <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App
            passwords</a> and make one called "JobPilot"</li>
          <li>Google shows you 16 letters — copy them into the box above</li>
        </ol>
      </details>
    </div>
    ${setSaveRowHtml('sending',
      `<button type="button" class="jp-btn jp-btn--quiet jp-btn--sm" id="setTestEmail">Send myself a test</button>`)}
    <p class="jp-note jp-set-foot">We never send anything to a company without showing you first.</p>`;
}

// The whole thing — who writes, the box you paste the code into, and the button
// that proves it works — is in the card. It is the one setting that decides
// whether an application is worth sending, so it is never behind "Advanced".
//
// The order is honest about money: a Claude subscription they already pay for
// comes first when we can see it, then the free option, then the two you pay
// per use. The same three words the welcome questions use ("nothing to paste",
// "a free key from Groq") are used again here on purpose.
// Whether Claude is signed in on this computer, checked live by the server on
// every read of /api/settings. Its own sentences are written for a developer
// ("Claude Code CLI not found — …"), so the two states we expect get plain
// words here and anything unexpected falls back to what the server said,
// which will still be more use than a shrug.
function setClaudeWords(cc) {
  const detail = String(cc.detail || '');
  if (cc.available) return `Signed in on this computer${cc.plan ? ` on the ${cc.plan} plan` : ''} — ready to go.`;
  if (/not found/i.test(detail)) {
    return "We can't see Claude on this computer. Install it from claude.com/code and sign in, and this option starts working.";
  }
  if (/not signed in/i.test(detail)) {
    return 'Claude is on this computer but nobody is signed in yet. Sign in there and this option starts working.';
  }
  return detail || 'Having a look…';
}

function setWriterBody(s) {
  const cc = s.claudeCode || {};
  const plan = cc.plan ? ` on the ${cc.plan} plan` : '';
  const p = s.provider;
  const key = (id, who, label, placeholder, help) => `
    <div class="jp-set-key${p === who ? '' : ' jp-hidden'}" data-key-for="${who}">
      <label class="jp-field">
        <span class="jp-field-label">${label}</span>
        <input class="jp-input jp-input--sm" type="password" id="${id}" autocomplete="off"
          placeholder="${esc(placeholder)}">
        <span class="jp-field-help">${help}</span>
      </label>
    </div>`;

  const claude = `
    <button type="button" class="jp-choice${p === 'claude_code' ? ' is-on' : ''}" data-writer="claude_code">
      <div class="jp-choice-title">Use your Claude subscription — nothing to paste</div>
      <div class="jp-choice-sub">${cc.available
        ? `You're already signed in to Claude on this computer${esc(plan)}, so there is nothing to set up and
           nothing more to pay.`
        : `If you pay for Claude Pro or Max, JobPilot can use that instead of a key — sign in to Claude on
           this computer and this option starts working.`}</div>
      <div class="jp-choice-sub jp-set-detect jp-set-detect--${cc.available ? 'ok' : 'no'}">${esc(setClaudeWords(cc))}</div>
    </button>`;
  const groq = `
    <button type="button" class="jp-choice${p === 'groq' ? ' is-on' : ''}" data-writer="groq">
      <div class="jp-choice-title">Get a free key from Groq</div>
      <div class="jp-choice-sub">Free to use. Make an account, copy the long code it shows you, paste it
        below — about two minutes.</div>
    </button>
    ${key('setGroqKey', 'groq', 'Paste the code here',
      s.groqKeySet ? `already saved (${s.groqKeyMasked}) — paste a new one to replace it` : 'it starts with gsk_',
      '<a href="https://console.groq.com/keys" target="_blank" rel="noopener">Open the page that gives you one ↗</a>')}`;

  return `
    <p class="jp-set-stakes">This is the part that makes an application worth sending. With a writer
      connected, every CV is rewritten around the job in front of it and every message says why you fit
      that particular company. Without one we still find you jobs and show them to you, but the CV and
      message we hand over are rough stand-ins — not something you'd want a company to read.</p>
    ${cc.available ? claude + groq : groq + claude}
    <button type="button" class="jp-choice${p === 'openai' ? ' is-on' : ''}" data-writer="openai">
      <div class="jp-choice-title">A key from OpenAI, the people behind ChatGPT</div>
      <div class="jp-choice-sub">You pay them for what JobPilot uses — usually a couple of dollars a month
        at this rate. Worth it if you already have an account there.</div>
    </button>
    ${key('setOpenaiKey', 'openai', 'Paste the code here',
      s.openaiKeySet ? `already saved (${s.openaiKeyMasked}) — paste a new one to replace it` : 'it starts with sk-',
      '<a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">Open the page that gives you one ↗</a>')}
    <button type="button" class="jp-choice${p === 'anthropic' ? ' is-on' : ''}" data-writer="anthropic">
      <div class="jp-choice-title">A key from Anthropic, the people behind Claude</div>
      <div class="jp-choice-sub">Also paid by the use, and separate from a Claude subscription — if you have
        the subscription, pick that one instead and pay nothing.</div>
    </button>
    ${key('setAnthropicKey', 'anthropic', 'Paste the code here',
      s.anthropicKeySet ? `already saved (${s.anthropicKeyMasked}) — paste a new one to replace it` : 'it starts with sk-ant-',
      '<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Open the page that gives you one ↗</a>')}
    ${setSaveRowHtml('writer',
      `<button type="button" class="jp-btn jp-btn--quiet jp-btn--sm" id="setTestAi">Check it works</button>`)}
    <details class="jp-help jp-set-model">
      <summary class="jp-note">Use a different one of their writers</summary>
      <label class="jp-field">
        <span class="jp-field-label">Which one to use</span>
        <input class="jp-input jp-input--sm" id="setModel" value="${esc(s.model || '')}"
          placeholder="${esc(s.activeModel || '')}">
        <span class="jp-field-help" id="setModelHint">${esc(SET_MODEL_HINTS[p] || '')}</span>
      </label>
      <p class="jp-note">Saved with the Save button above.</p>
    </details>
    <p class="jp-note jp-set-foot">Whichever you pick, your CV and everything we write stays on this
      computer. Only the job advert and the words we need go out.</p>`;
}

/* ---- Advanced ------------------------------------------------------------ */

function setBoardsBody(s) {
  const src = s.sources || {};
  return `
    <label class="jp-check">
      <input type="checkbox" id="setSrcRemotive" ${src.remotive ? 'checked' : ''}>
      <span>Free job boards — Remotive, RemoteOK and Arbeitnow
        <span class="jp-field-help">Free, on to start with, nothing to set up.</span></span>
    </label>
    <div class="jp-card jp-card--warn jp-card--tight jp-adv-warn">
      <div class="jp-h-sans--sm">Worth knowing before you turn the next two on</div>
      <p class="jp-note">LinkedIn and Naukri do not allow other tools to read their listings, so switching
        these on may go against those sites' own terms. That is why they start off — it is your call,
        and the risk is yours. The free boards and company career pages carry no such question, and
        career pages tend to get the best replies anyway.</p>
    </div>
    <label class="jp-check">
      <input type="checkbox" id="setSrcLinkedin" ${src.linkedin ? 'checked' : ''}>
      <span>LinkedIn
        <span class="jp-field-help">Needs a free account with Apify — the service that reads LinkedIn for
          us — and the code it gives you, below.</span></span>
    </label>
    <label class="jp-check">
      <input type="checkbox" id="setSrcNaukri" ${src.naukri ? 'checked' : ''}>
      <span>Naukri
        <span class="jp-field-help">India's biggest job board. Uses the same Apify code as LinkedIn.</span></span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Your Apify code</span>
      <input class="jp-input jp-input--sm" type="password" id="setApifyToken" autocomplete="off"
        placeholder="${s.apifyTokenSet ? `already saved (${esc(s.apifyTokenMasked)}) — paste a new one to replace it` : 'apify_api_…'}">
    </label>
    <details class="jp-help">
      <summary class="jp-note">How to get the Apify code (two minutes)</summary>
      <ol class="jp-note">
        <li>Make a free account at <a href="https://apify.com" target="_blank" rel="noopener">apify.com</a></li>
        <li>Open <a href="https://console.apify.com/settings/integrations" target="_blank" rel="noopener">Settings
          → API &amp; Integrations</a> and copy your personal code</li>
        <li>Paste it in the box above and save</li>
        <li>Once only: open <a href="https://console.apify.com/actors/zn01OAlzP853oqn4Z?approvePermissions=true"
          target="_blank" rel="noopener">the LinkedIn reader page</a> and press Approve</li>
      </ol>
      <p class="jp-note">Apify gives you $5 of free credit a month — enough for a few thousand LinkedIn jobs.</p>
    </details>
    <p class="jp-note jp-adv-para">Adzuna is another job board, free to use, with good coverage in a lot of
      countries. It needs two codes from them — free at
      <a href="https://developer.adzuna.com" target="_blank" rel="noopener">developer.adzuna.com</a>: register,
      make an app, then copy the two it shows you.</p>
    <label class="jp-field">
      <span class="jp-field-label">Adzuna app ID</span>
      <input class="jp-input jp-input--sm" id="setAdzunaAppId" autocomplete="off"
        value="${esc(s.adzunaAppId || '')}" placeholder="from developer.adzuna.com">
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Adzuna app key</span>
      <input class="jp-input jp-input--sm" type="password" id="setAdzunaAppKey" autocomplete="off"
        placeholder="${s.adzunaKeySet ? 'already saved — paste a new one to replace it' : 'the second code they give you'}">
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Which country to ask Adzuna about</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="setAdzunaCountry" maxlength="2"
        value="${esc(s.adzunaCountry || 'in')}" placeholder="in">
      <span class="jp-field-help">Two letters — in, gb, us, de. This one only affects Adzuna; the places you
        chose still decide what you actually see.</span>
    </label>
    ${setSaveRowHtml('boards')}`;
}

function setPromptsBody(s) {
  return `
    <p class="jp-note jp-adv-para">Anything you write here is added to what we tell the writer, every time.
      Notes you save on the dashboard land in whichever of the three you picked there.</p>
    <label class="jp-field">
      <span class="jp-field-label">When we're choosing which jobs to go for</span>
      <textarea class="jp-textarea jp-textarea--md" id="setPromptFind" rows="3"
        placeholder="e.g.&#10;- Never apply to agencies or consultancies&#10;- Prefer product companies&#10;- Avoid anything asking for 10+ years">${esc(s.promptFind || '')}</textarea>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">When we're writing your CV</span>
      <textarea class="jp-textarea jp-textarea--md" id="setPromptCV" rows="3"
        placeholder="e.g.&#10;- Lead with my fintech dashboard work&#10;- Keep it to one page&#10;- Put numbers on everything">${esc(s.promptCV || '')}</textarea>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">When we're writing the message that goes with it</span>
      <textarea class="jp-textarea jp-textarea--md" id="setPromptEmail" rows="3"
        placeholder="e.g.&#10;- Under 120 words&#10;- Warm but not chatty&#10;- Always say why I want THIS company">${esc(s.promptEmail || '')}</textarea>
    </label>
    ${setSaveRowHtml('prompts')}`;
}

function setChecksBody(s) {
  return `
    <label class="jp-check">
      <input type="checkbox" id="setFactCheck" ${s.factCheck ? 'checked' : ''}>
      <span>Read every CV and message back against your real CV before it goes out
        <span class="jp-field-help">Catches anything invented — a skill you never claimed, a job you never
          had. Costs one extra piece of AI work per application.</span></span>
    </label>
    <div class="jp-inline">
      <span>Don't approach the same company again within</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="setCooldown" type="number" min="0" max="90"
        value="${Number(s.companyCooldownDays) || 0}">
      <span>days</span>
    </div>
    <label class="jp-check">
      <input type="checkbox" id="setAutoMode" ${s.mode === 'auto' ? 'checked' : ''}>
      <span>Let JobPilot send the strong ones without asking me first
        <span class="jp-field-help">Off to start with. With it off, everything waits on your board until you
          press send.</span></span>
    </label>
    <div class="jp-inline">
      <span>…and only when the job is at least</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="setAutoMinScore" type="number" min="0" max="95"
        value="${Number(s.autoMinScore) || 0}">
      <span>out of 100 a match</span>
    </div>
    <p class="jp-note jp-inline-note">Weaker matches still turn up on your board — they just wait for you.</p>
    ${setSaveRowHtml('checks')}`;
}

function setReportsBody(s) {
  return `
    <label class="jp-check">
      <input type="checkbox" id="setInsightsEnabled" ${s.insightsEnabled ? 'checked' : ''}>
      <span>Look at how my search is going and email me what to change</span>
    </label>
    <div class="jp-inline">
      <span>Every</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="setInsightsEvery" type="number" min="5" max="500"
        value="${Number(s.insightsEvery) || 50}">
      <span>applications</span>
    </div>
    <label class="jp-field">
      <span class="jp-field-label">Send them to</span>
      <input class="jp-input jp-input--sm" id="setInsightsEmail" type="email" value="${esc(s.insightsEmail || '')}"
        placeholder="you@gmail.com">
      <span class="jp-field-help">Also sent after JobPilot has had a look on its own. You can always read
        them in the app instead.</span>
    </label>
    ${setSaveRowHtml('reports',
      `<button type="button" class="jp-btn jp-btn--quiet jp-btn--sm" id="setOpenReports">Read them here</button>`)}`;
}

function setDevBody(s) {
  return `
    <label class="jp-check">
      <input type="checkbox" id="setDevFeedback" ${s.devFeedbackEnabled ? 'checked' : ''}>
      <span>Send the person who makes JobPilot a few numbers, about every six days</span>
    </label>
    <p class="jp-note jp-adv-para">Off unless you tick it. Counts only — how many jobs were found and sent,
      which boards they came from, what went wrong and what it cost. Never your name, the companies, the job
      titles or a word of anything written for you. It goes from your own Gmail, so they do see the address
      it came from.</p>
    ${setSaveRowHtml('dev')}`;
}

function setDataBody(s) {
  return `
    <p class="jp-note jp-adv-para">Everything JobPilot knows about you is in this one folder: your settings
      at the top, and a folder for each separate search under <code>profiles/</code> with its jobs, its
      history and the CV file you gave us.</p>
    <div class="jp-set-path"><code>${esc(s.dataDir || '')}</code>
      <button type="button" class="jp-btn jp-btn--quiet jp-btn--xs" id="setCopyDir">Copy</button></div>
    <p class="jp-note jp-adv-para">Moving to a new computer: copy this folder to the same place there, run
      the setup there, and everything opens exactly as you left it. Back it up like you would photos.</p>
    <div class="jp-set-actions">
      <button type="button" class="jp-btn jp-btn--secondary jp-btn--sm" id="setReset">Empty this search and start again</button>
      <span class="jp-note">Throws away the CV, every job and every application in the search you're in now.
        It can't be undone.</span>
    </div>`;
}

function setReachBody() {
  return `
    <p class="jp-note jp-adv-para">JobPilot answers on this computer only — nothing about you is on the
      internet, and nobody else on your network can open it. It's the reason your CV and your email password
      are safe sitting here in plain view.</p>
    <p class="jp-note jp-adv-para">If you really want to open it from your phone on the same wifi, start
      JobPilot with <code>JOBPILOT_LAN=1</code> in front of the command. Anyone on that network could then
      read your CV, change these settings and send email as you, so we don't do it for you.</p>`;
}

function setInstallBody() {
  return `
    <p class="jp-note jp-adv-para">Puts JobPilot in your Dock or Start menu with its own window and its own
      icon. Same app, same data — just no browser tabs around it.</p>
    <div class="jp-set-actions">
      <button type="button" class="jp-btn jp-btn--secondary jp-btn--sm" id="setInstallApp">Install it</button>
    </div>`;
}

function setAdvRows(s) {
  const src = s.sources || {};
  const on = [];
  if (src.remotive) on.push('free boards');
  if (src.ats) on.push('career pages');
  if (src.linkedin) on.push('LinkedIn');
  if (src.naukri) on.push('Naukri');
  if (src.adzuna) on.push('Adzuna');
  const written = [s.promptFind, s.promptCV, s.promptEmail].filter(x => (x || '').trim()).length;
  const rows = [
    { id: 'boards', title: 'Extra job boards',
      sub: 'LinkedIn, Naukri and Adzuna. They need an account and a code from them.',
      state: on.length ? on.join(', ') : 'none on', body: () => setBoardsBody(s) },
    { id: 'prompts', title: 'Your own instructions to the writer',
      sub: 'Rules like "no agency jobs" or "keep messages short".',
      state: written ? `${written} of 3 written` : 'none yet', body: () => setPromptsBody(s) },
    { id: 'checks', title: 'Quality checks',
      sub: "Reading every CV back before it goes, and not pestering the same company twice.",
      state: s.factCheck ? 'on' : 'off', body: () => setChecksBody(s) },
    { id: 'reports', title: 'Progress reports by email',
      sub: 'A short read on what is and is not working, sent to you.',
      state: s.insightsEnabled ? `every ${s.insightsEvery} applications` : 'off', body: () => setReportsBody(s) },
    { id: 'dev', title: 'Sharing usage numbers with the developer',
      sub: 'Counts only — never your name, the companies, or anything written for you.',
      state: s.devFeedbackEnabled ? 'on' : 'off', body: () => setDevBody(s) },
    { id: 'data', title: 'Where your data lives',
      sub: 'One folder on this computer — copy it to move to another one.',
      state: 'on this computer', body: () => setDataBody(s) },
    { id: 'reach', title: 'Who can reach JobPilot',
      sub: 'Only this computer, and that is deliberate.',
      state: 'this computer only', body: () => setReachBody() }
  ];
  if (window.jobPilotInstall && window.jobPilotInstall.canInstall()) {
    rows.push({ id: 'install', title: 'Install JobPilot as an app',
      sub: 'Its own window and its own icon, same data.',
      state: 'you can', body: () => setInstallBody() });
  }
  return rows;
}

function setAdvRowHtml(r) {
  const open = setUi.row === r.id;
  return `
    <div class="jp-adv-row">
      <button type="button" class="jp-adv-head" data-set-row="${r.id}" aria-expanded="${open}">
        <span class="jp-adv-main">
          <span class="jp-adv-title">${r.title}</span>
          <span class="jp-adv-sub">${r.sub}</span>
        </span>
        <span class="jp-adv-state">${esc(r.state)} ${open ? '▲' : '▼'}</span>
      </button>
      ${open ? `<div class="jp-adv-open">${r.body()}</div>` : ''}
    </div>`;
}

function setAdvancedHtml(s) {
  return `
    <div class="jp-card jp-card--flush jp-adv">
      <button type="button" class="jp-adv-toggle" data-set-adv aria-expanded="${setUi.adv}">
        <span class="jp-h-sans--sm">Advanced</span>
        <span class="jp-note jp-adv-hint">Job boards with keys, your own instructions to the writer, data folder</span>
        <span class="jp-note jp-spacer">${setUi.adv ? '▲' : '▼'}</span>
      </button>
      ${setUi.adv ? `
        <div class="jp-adv-body">
          <p class="jp-note jp-adv-lede">You almost certainly don't need anything in here. It's for people
            who want to plug in paid job boards or change how the writer writes.</p>
          ${setAdvRows(s).map(setAdvRowHtml).join('')}
        </div>` : ''}
    </div>`;
}

function settingsSkeletonHtml() {
  return `
    <div class="jp-page jp-page--narrow">
      <h1 class="jp-title">Settings</h1>
      <p class="jp-lede jp-set-lede">Four things, and you can ignore all of them. Everything stays on this
        computer.</p>
      ${[0, 1, 2, 3].map(() => `
        <div class="jp-card jp-set-card">
          <div class="jp-set-head">
            <div class="jp-skel jp-skel--avatar"></div>
            <div class="jp-set-main">
              <div class="jp-skel jp-skel--title"></div>
              <div class="jp-skel jp-skel--text"></div>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderSettingsScreen() {
  const mount = JobPilot.mount('settings');
  if (!mount) return;
  const d = JobPilot.data;
  if (!d || !d.settings) { mount.innerHTML = settingsSkeletonHtml(); return; }
  const s = d.settings;
  // Nobody writing yet? Then the one card that matters opens itself, rather
  // than hiding the paste box behind a button on a page of four calm cards.
  // The moment they open or close a card themselves, we stop doing that.
  if (!s.llmReady && !setUi.touched && !setUi.card) setUi.card = 'writer';
  mount.innerHTML = `
    <div class="jp-page jp-page--narrow">
      <h1 class="jp-title">Settings</h1>
      <p class="jp-lede jp-set-lede">Four things, and you can ignore all of them. Everything stays on this
        computer.</p>
      ${setCardHtml({ id: 'cv', icon: '📄', tone: 'accent', title: 'Your CV and details',
        sub: 'What we tell companies about you. Read from the file you gave us.',
        state: setWordsCv(setProfile), cta: 'Open', go: 'you' })}
      ${setCardHtml({ id: 'looking', icon: '🎯', tone: 'accent', title: "What you're looking for",
        sub: 'Job titles, places, and how many applications feel right at a time.',
        state: setWordsLooking(s), cta: 'Change' }, () => setLookingBody(s))}
      ${setCardHtml({ id: 'sending', icon: '✉️', tone: 'good', title: 'Sending applications',
        sub: 'We send from your own email address so replies come straight to you.',
        state: setWordsSending(s), cta: 'Change' }, () => setSendingBody(s))}
      ${setCardHtml({ id: 'writer', icon: '✍️', tone: s.llmReady ? 'accent' : 'warn', title: 'The writer',
        sub: 'The AI that reads job adverts and writes your CVs and messages. It is what decides whether an application is worth sending.',
        state: setWordsWriter(s, d.stats), cta: s.llmReady ? 'Change' : 'Set this up',
        attn: s.llmReady ? '' : 'Two minutes, and worth it' }, () => setWriterBody(s))}
      ${setAdvancedHtml(s)}
    </div>`;
}

/* ---- Saving -------------------------------------------------------------- */

// One shape per section. Same field names the old window posted, so the server
// and everything reading these settings is untouched.
function setBodyFor(kind, s) {
  if (kind === 'looking') return {
    jobTitles: setVal('setTitles'),
    jobLocations: setVal('setPlaces'),
    remoteOk: setOn('setRemote'),
    atsCompanies: setVal('setCompanies'),
    dailyTarget: setVal('setTarget'),
    maxJobAgeDays: setVal('setMaxAge'),
    preferLowCompetition: setOn('setLowComp'),
    autoSearch: setOn('setAutoSearch'),
    autoSearchHours: setVal('setAutoHours')
  };
  if (kind === 'sending') {
    const mode = document.querySelector('[data-send].is-on')?.dataset.send || 'myself';
    return {
      sendingMode: mode,
      fromName: setVal('setFromName'),
      smtpUser: setVal('setSmtpUser'),
      smtpPass: setVal('setSmtpPass')
    };
  }
  if (kind === 'writer') return {
    provider: document.querySelector('[data-writer].is-on')?.dataset.writer || s.provider,
    model: setVal('setModel'),
    groqKey: setVal('setGroqKey'),
    openaiKey: setVal('setOpenaiKey'),
    anthropicKey: setVal('setAnthropicKey')
  };
  if (kind === 'boards') return {
    sources: { remotive: setOn('setSrcRemotive'), linkedin: setOn('setSrcLinkedin'), naukri: setOn('setSrcNaukri') },
    apifyToken: setVal('setApifyToken'),
    adzunaAppId: setVal('setAdzunaAppId'),
    adzunaAppKey: setVal('setAdzunaAppKey'),
    adzunaCountry: setVal('setAdzunaCountry')
  };
  if (kind === 'prompts') return {
    promptFind: setVal('setPromptFind'), promptCV: setVal('setPromptCV'), promptEmail: setVal('setPromptEmail')
  };
  if (kind === 'checks') return {
    factCheck: setOn('setFactCheck'),
    companyCooldownDays: setVal('setCooldown'),
    mode: setOn('setAutoMode') ? 'auto' : 'manual',
    autoMinScore: setVal('setAutoMinScore')
  };
  if (kind === 'reports') return {
    insightsEnabled: setOn('setInsightsEnabled'),
    insightsEvery: setVal('setInsightsEvery'),
    insightsEmail: setVal('setInsightsEmail')
  };
  if (kind === 'dev') return { devFeedbackEnabled: setOn('setDevFeedback') };
  return {};
}

function setSavedWords(kind, body) {
  if (kind === 'looking') return "Saved — that's what we'll look for from now on.";
  if (kind === 'sending') return body.sendingMode === 'jobpilot'
    ? "Saved — we'll send your applications from that address."
    : "Saved — we'll write them all and leave the sending to you.";
  if (kind === 'writer') return 'Saved — that\'s who writes for you now. "Check it works" proves it.';
  if (kind === 'boards') return "Saved — that's where we'll look.";
  if (kind === 'prompts') return "Saved — we'll follow those every time from now on.";
  if (kind === 'checks') return 'Saved.';
  if (kind === 'reports') return body.insightsEnabled ? "Saved — we'll email you one every so often." : 'Saved — no more reports by email.';
  if (kind === 'dev') return body.devFeedbackEnabled ? 'Saved — thank you.' : 'Saved — nothing is shared.';
  return 'Saved.';
}

async function setSave(kind, btn) {
  const s = JobPilot.data?.settings || {};
  const body = setBodyFor(kind, s);
  // The one rule the old window enforced too: those two boards can't work
  // without the Apify code, and silently saving an "on" that does nothing is
  // worse than saying so.
  if (kind === 'boards' && (body.sources.linkedin || body.sources.naukri) && !s.apifyTokenSet && !body.apifyToken) {
    setMsg(kind, `${body.sources.linkedin ? 'LinkedIn' : 'Naukri'} can't work without the Apify code — there are steps for it just below.`, true);
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span> Saving…';
  setMsg(kind, '');
  try {
    await api('/api/settings', { method: 'POST', body });
    setUi.card = null;
    setUi.row = null;
    await refresh();          // re-renders the screen with the new state lines
    toast(setSavedWords(kind, body));
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    setMsg(kind, err.message, true);
  }
}

/* ---- Clicks -------------------------------------------------------------- */

document.getElementById('mount-settings')?.addEventListener('click', async e => {
  const card = e.target.closest('[data-set-card]');
  if (card) {
    setUi.touched = true;   // they are driving now — stop opening "the writer" for them
    setUi.card = setUi.card === card.dataset.setCard ? null : card.dataset.setCard;
    renderSettingsScreen();
    return;
  }
  if (e.target.closest('[data-set-adv]')) {
    setUi.adv = !setUi.adv;
    if (!setUi.adv) setUi.row = null;
    renderSettingsScreen();
    return;
  }
  const row = e.target.closest('[data-set-row]');
  if (row) {
    setUi.row = setUi.row === row.dataset.setRow ? null : row.dataset.setRow;
    renderSettingsScreen();
    return;
  }
  const save = e.target.closest('[data-set-save]');
  if (save) return setSave(save.dataset.setSave, save);

  // Picking a card-shaped choice: no re-render, so nothing typed is lost.
  const send = e.target.closest('[data-send]');
  if (send) {
    for (const c of document.querySelectorAll('[data-send]')) c.classList.toggle('is-on', c === send);
    $('#setMailBox')?.classList.toggle('jp-hidden', send.dataset.send !== 'jobpilot');
    return;
  }
  const writer = e.target.closest('[data-writer]');
  if (writer) {
    const who = writer.dataset.writer;
    for (const c of document.querySelectorAll('[data-writer]')) c.classList.toggle('is-on', c === writer);
    for (const box of document.querySelectorAll('[data-key-for]')) {
      box.classList.toggle('jp-hidden', box.dataset.keyFor !== who);
    }
    const hint = $('#setModelHint');
    if (hint) hint.textContent = SET_MODEL_HINTS[who] || '';
    return;
  }

  if (e.target.closest('#setTestEmail')) return setTestEmail(e.target.closest('#setTestEmail'));
  if (e.target.closest('#setTestAi')) return setTestAi(e.target.closest('#setTestAi'));
  if (e.target.closest('#setOpenReports')) {
    openReports().catch(err => toast(err.message, true));
    return;
  }
  if (e.target.closest('#setCopyDir')) {
    const path = JobPilot.data?.settings?.dataDir || '';
    try {
      await navigator.clipboard.writeText(path);
      toast('Copied — paste it into Finder or Explorer to open the folder.');
    } catch { toast('Select the line and copy it by hand — this browser wouldn\'t let us.', true); }
    return;
  }
  if (e.target.closest('#setReset')) {
    if (!confirm('Throw away the CV, every job and every application in this search? It cannot be undone.')) return;
    try {
      await api('/api/demo/reset', { method: 'POST' });
      location.reload();
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.closest('#setInstallApp')) {
    window.jobPilotInstall?.install();
  }
});

async function setTestEmail(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span> Sending…';
  setMsg('sending', '');
  try {
    // Save first, so the test uses what is on screen rather than what was
    // saved last time — otherwise "send a test" tests the wrong address.
    await api('/api/settings', { method: 'POST', body: setBodyFor('sending', JobPilot.data?.settings || {}) });
    const res = await api('/api/settings/test-email', { method: 'POST' });
    setMsg('sending', `Sent one to ${res.to} — have a look in your inbox, and the spam folder.`);
    refresh().catch(() => {});
  } catch (err) { setMsg('sending', err.message, true); }
  btn.disabled = false;
  btn.textContent = label;
}

async function setTestAi(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span> Checking…';
  setMsg('writer', '');
  try {
    await api('/api/settings', { method: 'POST', body: setBodyFor('writer', JobPilot.data?.settings || {}) });
    const res = await api('/api/settings/test-ai', { method: 'POST' });
    setMsg('writer', res.message || 'That works.');
    refresh().catch(() => {});
  } catch (err) { setMsg('writer', err.message, true); }
  btn.disabled = false;
  btn.textContent = label;
}

JobPilot.screens.register('settings', {
  onEnter() {
    renderSettingsScreen();
    setLoadProfile().then(() => {
      if (JobPilot.screens.current() === 'settings' && !setUi.card && !setUi.row) renderSettingsScreen();
    });
  }
});

/* ===========================================================================
 * YOU — the name, the CV, and the details we put in front of companies.
 *
 * Everything the old profile window held, plus the profile switcher that used
 * to be a <select> in the sidebar. Same /api/profile and /api/profiles calls.
 * ======================================================================== */

function youFieldsHtml(p) {
  const list = (v, sep = ', ') => (Array.isArray(v) ? v : []).join(sep);
  return `
    <label class="jp-field">
      <span class="jp-field-label">Your name</span>
      <input class="jp-input jp-input--sm" id="youName" value="${esc(p.name || '')}" autocomplete="name">
      <span class="jp-field-help">The name companies see on everything we send.</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Your email address</span>
      <input class="jp-input jp-input--sm" id="youEmail" type="email" value="${esc(p.email || '')}" autocomplete="off">
      <span class="jp-field-help">The one on your CV, so people can write back to you.</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">What you do</span>
      <input class="jp-input jp-input--sm" id="youTitle" value="${esc(p.title || '')}">
      <span class="jp-field-help">The one-line answer to "what's your job?"</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">How long you have been doing it</span>
      <input class="jp-input jp-input--sm jp-inline-num" id="youYears" type="number" min="0" max="60"
        value="${p.years_experience ?? ''}">
      <span class="jp-field-help">In years. Roughly is fine.</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Things you are good at</span>
      <textarea class="jp-textarea jp-textarea--md" id="youSkills" rows="2"
        placeholder="React, TypeScript, Node.js">${esc(list(p.skills))}</textarea>
      <span class="jp-field-help">Separated by commas. We match these against what each job asks for.</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">The kinds of job this suits</span>
      <textarea class="jp-textarea jp-textarea--md" id="youRoles" rows="2"
        placeholder="Senior Software Engineer, Full Stack Developer">${esc(list(p.target_roles))}</textarea>
      <span class="jp-field-help">Separated by commas. We search for these when you haven't said otherwise
        in Settings.</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">A sentence about you</span>
      <textarea class="jp-textarea jp-textarea--md" id="youSummary" rows="3">${esc(p.summary || '')}</textarea>
      <span class="jp-field-help">This often becomes the first line of your message.</span>
    </label>
    <label class="jp-field">
      <span class="jp-field-label">Things you are proud of</span>
      <textarea class="jp-textarea jp-textarea--md" id="youAchievements" rows="4"
        placeholder="Cut how long the payments page took to load by 42%&#10;Led a team of three">${esc(list(p.top_achievements, '\n'))}</textarea>
      <span class="jp-field-help">One per line. These are what we lead with when a job matches them.</span>
    </label>`;
}

function youProfilesHtml(profiles) {
  const rows = (profiles || []).map(p => `
    <div class="jp-row">
      <span class="jp-avatar jp-avatar--sm${p.active ? ' jp-avatar--accent' : ''}">${esc(initialsOf(p.name))}</span>
      <div class="jp-row-main">
        <div class="jp-row-title jp-row-title--light">${esc(p.name)}</div>
        <div class="jp-row-sub jp-row-sub--sm">${esc(p.title)} · ${setCount(p.applications, 'job', 'jobs')}</div>
      </div>
      <div class="jp-row-end">
        ${p.active
          ? `<span class="jp-badge jp-badge--accent">the one you're in</span>
             <button type="button" class="jp-btn jp-btn--quiet jp-btn--xs" data-you-rename="${esc(p.id)}">Rename</button>`
          : `<button type="button" class="jp-btn jp-btn--secondary jp-btn--xs" data-you-switch="${esc(p.id)}">Switch to this</button>`}
        ${(profiles.length > 1 && p.active)
          ? `<button type="button" class="jp-btn jp-btn--quiet jp-btn--xs" data-you-delete="${esc(p.id)}">Delete</button>` : ''}
      </div>
    </div>`).join('');
  return `
    <div class="jp-card">
      <div class="jp-h-sans--sm">More than one search</div>
      <p class="jp-set-sub">You can keep separate searches — one for backend jobs and one for design work,
        say, or one for here and one for abroad. Each has its own CV, its own jobs and its own history.</p>
      <div class="jp-list jp-list--ruled">${rows}</div>
      <div class="jp-set-actions">
        <button type="button" class="jp-btn jp-btn--secondary jp-btn--sm" id="youNewProfile">Start another search</button>
        <span class="jp-note">You give the new one its own CV after switching to it.</span>
      </div>
    </div>`;
}

function renderYouScreen() {
  const mount = JobPilot.mount('you');
  if (!mount) return;
  const p = setProfile || {};
  const has = !!p.name;
  const profiles = JobPilot.data?.profiles || [];
  mount.innerHTML = `
    <div class="jp-page jp-page--narrow">
      <h1 class="jp-title">You</h1>
      <p class="jp-lede jp-set-lede">This is what we tell companies about you. Change anything that reads wrong.</p>
      <input type="file" id="youCvInput" accept=".pdf,.docx,.txt,.md" hidden>
      ${has ? `
        <div class="jp-card jp-card--lg">
          <div class="jp-row-flex jp-you-head">
            <span class="jp-avatar jp-avatar--lg jp-avatar--round jp-avatar--accent">${esc(initialsOf(p.name))}</span>
            <div>
              <div class="jp-h-sans">${esc(p.name)}</div>
              <div class="jp-row-sub">${esc([p.title, p.years_experience ? `${p.years_experience} years` : '']
                .filter(Boolean).join(' · '))}</div>
            </div>
            <label class="jp-btn jp-btn--secondary jp-btn--sm jp-spacer" for="youCvInput">Replace my CV</label>
          </div>
          ${youFieldsHtml(p)}
          <div class="jp-set-actions jp-you-save">
            <button type="button" class="jp-btn jp-btn--primary jp-btn--sm" id="youSave">Save</button>
            <span class="jp-note" data-set-msg="you" aria-live="polite">Kept on this computer — nothing is uploaded anywhere.</span>
          </div>
        </div>`
      : `
        <div class="jp-card jp-card--lg">
          <h2 class="jp-h2">We haven't read a CV yet</h2>
          <p class="jp-lede jp-you-empty-lede">Give us one file, once. We read it to learn what you do, then
            rewrite it to fit each job. It stays on this computer.</p>
          <div class="jp-card jp-card--dashed">
            <p class="jp-lede">PDF, Word or plain text</p>
            <div class="jp-btns jp-ob-drop-btns">
              <label class="jp-btn jp-btn--primary" for="youCvInput">Choose a file</label>
            </div>
          </div>
        </div>`}
      ${youProfilesHtml(profiles)}
    </div>`;
}

async function youSave(btn) {
  const splitLines = v => v.split('\n').map(x => x.trim()).filter(Boolean);
  const profile = {
    ...(setProfile || {}),   // keep everything the writer extracted that this form doesn't show
    name: setVal('youName'),
    email: setVal('youEmail'),
    title: setVal('youTitle'),
    years_experience: Number(setVal('youYears')) || 0,
    skills: splitList(setVal('youSkills'), ','),
    target_roles: splitList(setVal('youRoles'), ','),
    summary: setVal('youSummary'),
    top_achievements: splitLines($('#youAchievements')?.value || '')
  };
  if (!profile.name) { setMsg('you', 'We need a name to put on your applications.', true); return; }
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span> Saving…';
  try {
    await api('/api/profile', { method: 'PUT', body: { profile } });
    setProfile = profile;
    setProfileLoaded = true;
    toast('Saved — that\'s what we\'ll tell companies from now on.');
    await refresh().catch(() => {});
    renderYouScreen();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    setMsg('you', err.message, true);
  }
}

// The You screen's own CV upload: the shared one announces itself in words
// ("Profile extracted — 7 skills found") that belong to the old dashboard.
async function youUploadCv(file) {
  toast('Reading your CV…');
  const fd = new FormData();
  fd.append('cv', file);
  const res = await fetch('/api/cv', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `That file wouldn't open (${res.status})`);
  setProfile = data.profile;
  setProfileLoaded = true;
  toast("Read it — have a look below and fix anything that isn't right.");
  await refresh().catch(() => {});
  renderYouScreen();
}

document.getElementById('mount-you')?.addEventListener('change', async e => {
  if (e.target.id !== 'youCvInput') return;
  const file = e.target.files[0];
  if (!file) return;
  try { await youUploadCv(file); } catch (err) { toast(err.message, true); }
  e.target.value = '';
});

document.getElementById('mount-you')?.addEventListener('click', async e => {
  if (e.target.closest('#youSave')) return youSave(e.target.closest('#youSave'));

  const rename = e.target.closest('[data-you-rename]');
  const switchTo = e.target.closest('[data-you-switch]');
  const del = e.target.closest('[data-you-delete]');
  const add = e.target.closest('#youNewProfile');
  if (!rename && !switchTo && !del && !add) return;
  try {
    if (rename) {
      const current = (JobPilot.data?.profiles || []).find(p => p.id === rename.dataset.youRename);
      const label = prompt('What should this search be called? (e.g. "Backend jobs in India")', current?.name || '');
      if (label === null) return;
      await api(`/api/profiles/${rename.dataset.youRename}`, { method: 'PATCH', body: { label } });
      toast('Renamed.');
      await refresh();
      renderYouScreen();
      return;
    }
    if (add) {
      if (!confirm('Start a separate search? You give it its own CV once you have switched to it.')) return;
      await api('/api/profiles', { method: 'POST' });
      toast('Made a new one — switch to it and give it a CV.');
      await refresh();
      renderYouScreen();
      return;
    }
    if (del) {
      const p = (JobPilot.data?.profiles || []).find(x => x.id === del.dataset.youDelete);
      if (!confirm(`Delete "${p?.name}" and every job and application in it? This cannot be undone.`)) return;
      await api(`/api/profiles/${del.dataset.youDelete}`, { method: 'DELETE' });
      location.reload();
      return;
    }
    await api(`/api/profiles/${switchTo.dataset.youSwitch}/activate`, { method: 'POST' });
    location.reload();   // every screen is showing the old search's data
  } catch (err) { toast(err.message, true); }
});

JobPilot.screens.register('you', {
  onEnter() {
    renderYouScreen();
    setLoadProfile(true).then(() => {
      if (JobPilot.screens.current() === 'you') renderYouScreen();
    });
  }
});

// One snapshot, both screens. Never redraw over somebody who is halfway
// through typing — an open card or advanced row means leave it alone.
document.addEventListener('jobpilot:data', () => {
  if (JobPilot.screens.current() === 'settings' && !setUi.card && !setUi.row) renderSettingsScreen();
});

// One upload path for the old dashboard's entry points (sidebar, profile editor)
// so the extracted profile is reported back the same way each time. The welcome
// questions have their own (obUploadCv) because they say it in plainer words.
async function uploadCvFile(file) {
  toast('Uploading CV & extracting profile…');
  const fd = new FormData();
  fd.append('cv', file);
  const res = await fetch('/api/cv', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  toast(`Profile extracted — ${data.profile.skills.length} skills found`);
  await refresh();
  return data.profile;
}

$('#cvInput')?.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await uploadCvFile(file);
  } catch (err) { toast(err.message, true); }
  e.target.value = '';
});

$('#searchBtn')?.addEventListener('click', doSearch);
$('#searchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const btn = $('#searchBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span>Looking…';
  try {
    const q = $('#searchInput').value.trim();
    const res = await api('/api/jobs/search', { method: 'POST', body: { query: q } });
    if (!res.added && res.note) {
      toast(res.note, true); // nothing found — show the actual cause, not a shrug
    } else if (res.added) {
      toast(`Found ${res.added} job${res.added === 1 ? '' : 's'} for "${res.query}" that suit you`
        + `${res.skipped ? ` — we left out ${res.skipped} that didn't` : ''}. They're under My jobs.`);
    } else {
      toast(`Nothing new for "${res.query}" just now. Try different words, or widen where you'd work in Settings.`);
    }
    refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = 'Search';
}

$('#resetBtn')?.addEventListener('click', async () => {
  if (!confirm('Start this search from scratch?\n\n'
    + 'Your CV, every job we found, every application and its history go for good. There is no undo.')) return;
  await api('/api/demo/reset', { method: 'POST' });
  location.reload();
});

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

/* ===========================================================================
 * HOME — the timeline, and HOW IT'S GOING — the short read.
 *
 * Home answers three questions, in this order: is anything waiting on me, what
 * has JobPilot been doing, and what happens next. Everything on it is derived
 * from the one shared snapshot — no polling of its own, no second store.
 *
 * Two things are worth knowing before changing anything here:
 *
 *  1. THE BIG BUTTON (#smartBtn) AND #syncBtn ARE NEVER RE-CREATED. They are
 *     written once in index.html and only ever MOVED between slots
 *     (homePlace()), so the click handler bound at load, the run-status lock
 *     and the deferred AI / email questions all keep working. Re-rendering them
 *     as markup would silently break the product's core loop.
 *  2. NOTHING THE SERVER LOGS REACHES THE SCREEN AS-IS. The activity feed is
 *     written for a developer ("Batch generate: 7 tailored CVs & emails
 *     ready…"); homeEvent() turns each line into a sentence a person would
 *     say. Anything unrecognised falls back to a plain sentence for its type —
 *     a raw string must never leak through.
 * ======================================================================== */

// ---------- Numbers as words, for sentences that are about the number -------
const HOME_NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const HOME_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numWords(n) {
  n = Math.round(Number(n) || 0);
  if (n < 0 || n >= 1000) return String(n);
  if (n <= 20) return HOME_NUM[n];
  if (n < 100) {
    const r = n % 10;
    return HOME_TENS[Math.floor(n / 10)] + (r ? '-' + HOME_NUM[r] : '');
  }
  const r = n % 100;
  return `${HOME_NUM[Math.floor(n / 100)]} hundred${r ? ' and ' + numWords(r) : ''}`;
}
const capFirst = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The same, with the number in words — for sentences where the number is the
// point ("Two jobs are waiting on you").
const pluralWords = (n, one, many) => `${numWords(n)} ${n === 1 ? one : many}`;

// Money the way a person writes it. The old dashboard's fmtCost() prints
// "$0.330" for a third of a dollar, which reads like a bug.
function fmtMoney(usd) {
  const n = Number(usd) || 0;
  if (!n) return '$0.00';
  if (n < 0.01) return 'under $0.01';
  return '$' + n.toFixed(2);
}

// ---------- Days and clock times, said the way a person says them ----------
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

function dayLabel(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
const clockTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// The person's first name — what they told us it is, or failing that the name
// on their CV. Never the profile's label: that is the name of a *search*
// ("New profile", "US remote"), and greeting somebody by it would be wrong.
function homeFirstName(data) {
  const name = (data.settings && data.settings.fromName) || state.cvName || '';
  const first = String(name).trim().split(/\s+/)[0] || '';
  return /^(unknown|n\/?a|none)$/i.test(first) ? '' : first;
}

/* ---------------------------------------------------------------------------
 * The activity feed, rewritten.
 *
 * Every line the server logs is matched against the rules below and comes out
 * as { icon, tone, text, sub } — plus, where the line is about one job, the id
 * of that job, so the row opens it. First rule that matches wins.
 * ------------------------------------------------------------------------ */

// The server writes "<title> at <company>" into most of its lines. Rather than
// parsing that back out (titles contain " at " often enough), look for a job
// whose own words appear in the line — the longest match wins.
function findJobInText(text, apps) {
  let best = null;
  for (const a of apps || []) {
    const needle = `${a.title} at ${a.company}`;
    if (needle.length > 4 && text.includes(needle) &&
      (!best || needle.length > `${best.title} at ${best.company}`.length)) best = a;
  }
  return best;
}

// What a job's internal status is called when we have to name it out loud.
const HOME_MOVED_WORDS = {
  rejected: 'they said no', closed: 'no reply', applied: 'you applied',
  replied: 'they replied', interview: 'they want to meet you', offer: 'they offered you the job',
  ready: 'ready to send', action: 'yours to apply for', discovered: 'found',
  approved: 'ready for us to write', followup: 'waiting to hear back'
};

const HOME_RULES = [
  // ---- something came back from a company -------------------------------
  [/^\u{1F389} Interview invitation for .+?(?:\s\(.+?\))?! ?([\s\S]*)$/u, (m, c) => ({
    icon: '\u{1F389}', tone: 'good', text: `${c.co} want to meet you`,
    sub: m[1].trim() || 'They asked to talk — have a read.', cta: 'Read the message'
  })],
  [/^Reply (?:received|detected)/, (m, c) => ({
    icon: '★', tone: 'good', text: `${c.co} wrote back`,
    sub: 'A real person replied. We stopped chasing this one.', cta: 'Read the message'
  })],
  [/^Rejection received for/, (m, c) => ({
    icon: '✕', text: `${c.co} said no`, sub: 'Nothing for you to do. We stopped chasing it.'
  })],
  [/^✓ Application confirmed received/, (m, c) => ({
    icon: '✓', text: `${c.co} confirmed they got your application`,
    sub: 'No answer from a person yet — we keep watching.'
  })],
  [/^\u{1F4CE} Contact captured for/u, (m, c) => ({
    icon: '✉', text: `We found who to email at ${c.co}`,
    sub: "From here we chase this one up by email, so you don't have to."
  })],
  [/^Inbox synced: (\d+) applications checked, (\d+) replies found/, m => ({
    icon: '↻',
    text: Number(m[2]) ? `Read your inbox — ${plural(Number(m[2]), 'reply', 'replies')} came back` : 'Read your inbox — nothing new',
    sub: `We looked over ${plural(Number(m[1]), 'application', 'applications')}.`
  })],

  // ---- nudges ------------------------------------------------------------
  [/^Auto follow-up \(day (\d+)\) (sent \(simulated\)|emailed to .+?) for/, (m, c) => ({
    icon: '↻', text: `Nudged ${c.co} again`,
    sub: `Day ${m[1]} reminder` + (m[2].startsWith('sent (')
      ? ' — a practice run, so nothing really left this computer.' : ', sent for you.')
  })],
  [/^⏰ Follow-up due \(day (\d+)\)/, (m, c) => ({
    // The day matters: without it the day 3, 5 and 10 reminders for the same
    // company are three identical rows in the feed.
    icon: '✋', tone: 'warn', text: `Time to nudge ${c.co}`,
    sub: `Day ${m[1]} reminder — this one is yours to send, wherever you applied.`, cta: 'Show me'
  })],
  [/^✓ Day-(\d+) follow-up marked done/, (m, c) => ({
    icon: '✓', tone: 'good', text: `You nudged ${c.co}`, sub: `Day ${m[1]} reminder, done by hand.`
  })],
  [/^No response after final follow-up/, (m, c) => ({
    icon: '·', text: `No reply from ${c.co}`,
    sub: "We asked three times and heard nothing, so we've stopped."
  })],

  // ---- applications going out --------------------------------------------
  [/^Application (sent \(simulated\)|emailed to .+?) for/, (m, c) => ({
    icon: '✉', text: `Applied to ${c.co} for you`,
    sub: (c.job ? `${c.job.title} · ` : '') + (m[1].startsWith('sent (')
      ? 'a practice run, so nothing really left this computer'
      : 'your CV went with it as a PDF')
  })],
  [/^Batch send: (\d+) emailed for real, (\d+) simulated(?:, (\d+) expired postings skipped)?(?:, (\d+) failed)?/, m => {
    const real = Number(m[1]), sim = Number(m[2]), gone = Number(m[3] || 0), bad = Number(m[4] || 0);
    const total = real + sim;
    const extra = [
      gone ? `${pluralWords(gone, 'advert had', 'adverts had')} already closed` : '',
      bad ? `${numWords(bad)} didn't go through` : ''
    ].filter(Boolean).join(', ');
    return {
      icon: '✉',
      text: total ? `Applied to ${plural(total, 'job', 'jobs')} for you` : 'Nothing went out this time',
      sub: (total
        ? (sim && !real ? 'A practice run — nothing really left this computer. ' : 'Your CV went with every one. ')
          + "We'll remind them on day 3, 5 and 10."
        : 'Nothing was ready to send.') + (extra ? ` ${capFirst(extra)}.` : '')
    };
  }],
  // You sent these, so the nudges are yours too — we keep the diary, not the pen.
  [/^✋→✓ You applied on the platform/, (m, c) => ({
    icon: '✓', tone: 'good', text: `You applied to ${c.co} yourself`,
    sub: "We're tracking it now, and we'll tell you when it's time to nudge them."
  })],
  [/^✋→✓ (\d+) platform applications? confirmed/, m => ({
    icon: '✓', tone: 'good', text: `You applied to ${plural(Number(m[1]), 'job', 'jobs')} yourself`,
    sub: "We'll remind you to nudge them on day 3, 5 and 10."
  })],

  // ---- finding jobs -------------------------------------------------------
  [/^Batch fetch done: (\d+) new matches \((\d+) poor fits filtered\)/, m => {
    const added = Number(m[1]), poor = Number(m[2]);
    return {
      icon: '\u{1F50D}',
      text: added ? `Found ${plural(added, 'job', 'jobs')} that suit you` : 'Nothing new that suits you this time',
      sub: poor ? `We read ${plural(poor, 'other', 'others')} and they weren't close enough.` : "We'll keep looking."
    };
  }],
  [/^(?:Batch fetch|Job search|Auto search) "([\s\S]+?)" via (.+?): (\d+) good matches added/, m => ({
    icon: '\u{1F50D}', text: `Looked for "${m[1]}" jobs`,
    sub: `${plural(Number(m[3]), 'one that suits', 'that suit')} you, ${sourceWords(m[2]) || 'found for you'}.`
  })],
  [/^(?:Batch fetch|Job search|Auto search) "([\s\S]+?)": (\d+) jobs? found but ALL filtered out/, m => ({
    icon: '\u{1F50D}', tone: 'warn',
    text: `Found ${plural(Number(m[2]), 'job', 'jobs')} for "${m[1]}" — but not where you want to work`,
    sub: 'Add more places, or allow older postings, under what you are looking for in Settings.'
  })],
  [/^(\d+) jobs approved for CV & email generation/, m => ({
    icon: '·', text: `${plural(Number(m[1]), 'job is', 'jobs are')} ready for us to write`,
    sub: 'Nothing for you to do.'
  })],

  // ---- writing ------------------------------------------------------------
  [/^Batch generate: (\d+) tailored CVs & emails ready(?: \((\d+) corrected by fact-check\))?(?:, (\d+) for you to send yourself[^,]*)?(?:, (\d+) failed)?/, m => {
    const done = Number(m[1]), fixed = Number(m[2] || 0), yours = Number(m[3] || 0), bad = Number(m[4] || 0);
    return {
      icon: '✍',
      text: done ? `Wrote ${plural(done, 'application', 'applications')} for you` : 'Nothing to write just now',
      sub: [
        done ? 'Your real CV, reordered so each company sees what they asked for first.' : '',
        fixed ? `We checked them against your CV and corrected ${numWords(fixed)}.` : '',
        yours ? `${capFirst(numWords(yours))} of them are yours to send.` : '',
        bad ? `${capFirst(numWords(bad))} didn't work — we'll try again.` : ''
      ].filter(Boolean).join(' ')
    };
  }],
  [/^Ready for you to send: (\d+) written and waiting/, m => ({
    icon: '✋', tone: 'warn',
    text: `${capFirst(pluralWords(Number(m[1]), 'application is', 'applications are'))} ready for you to send`,
    sub: 'We wrote every one. Nothing was emailed — that part is yours.', cta: 'Show me', go: 'jobs'
  })],
  [/^Tailored CV \+ email generated for/, (m, c) => ({
    icon: '✍', text: `Wrote your application for ${c.co}`,
    sub: c.job ? c.job.title : 'A CV and a short message, ready for you to read.', cta: 'Read it'
  })],
  [/^Revised CV\/email for .+ per your feedback: "([\s\S]+)"$/, (m, c) => ({
    icon: '✍', text: `Rewrote your application for ${c.co}`, sub: `You asked for: "${m[1]}"`, cta: 'Read it'
  })],

  // ---- your details -------------------------------------------------------
  [/^CV uploaded \(([\s\S]+?)\) — profile extracted: (\d+) skills found/, m => ({
    icon: '\u{1F4C4}', text: 'You added your CV',
    sub: `We read it and picked out ${plural(Number(m[2]), 'thing', 'things')} you're good at.`
  })],
  [/^Profile edited and saved$/, () => ({
    icon: '\u{1F4C4}', text: 'You changed your details', sub: 'Every application from now on uses them.'
  })],
  [/^New profile created/, () => ({
    icon: '\u{1F4C4}', text: 'You started a second search', sub: 'Add a CV for it whenever you like.'
  })],

  // ---- settings -----------------------------------------------------------
  [/^Setup finished/, () => ({
    icon: '✓', tone: 'good', text: "You're all set up",
    sub: 'From here we only ask when we genuinely need you.'
  })],
  [/^AI instruction for (.+?) added: "([\s\S]+)"$/, m => ({
    icon: '⚙',
    text: `You gave us a rule for ${({ 'job finding': 'finding jobs', 'CV writing': 'writing your CV', 'email writing': 'writing your messages' })[m[1]] || 'writing'}`,
    sub: `"${m[2]}"`
  })],
  [/^AI connection test passed/, () => ({
    icon: '⚙', tone: 'good', text: 'The writing is connected',
    sub: 'We can read adverts and write your applications now.'
  })],
  [/^Settings updated$/, () => ({ icon: '⚙', text: 'You changed something in Settings' })],

  // ---- reports ------------------------------------------------------------
  [/^\u{1F4CA} Improvement report generated \(([\s\S]+?)\)(?: and emailed to (.+))?$/u, m => ({
    icon: '\u{1F4CA}', text: 'We looked at how your search is going',
    sub: m[2] ? `Sent to ${m[2]}.` : 'A short read on what is working and what is not.',
    cta: 'Read it', go: 'report'
  })],
  [/^\u{1F4EE} Anonymous usage feedback/u, () => ({
    icon: '\u{1F4EE}', text: 'Sent the anonymous usage numbers',
    sub: 'Counts only — no names, no companies, no messages. You can switch this off in Settings.'
  })],

  // ---- things that did not work ------------------------------------------
  [/^⚠️? Career page "([\s\S]+?)" — no public job board found/, m => ({
    icon: '⚠', tone: 'warn', text: `We couldn't read ${m[1]}'s careers page`,
    sub: "Big companies often run their own site that JobPilot can't read. Check the spelling in Settings, or take it off the list."
  })],
  [/^⚠️? Fetch skipped: (\d+) jobs already/, m => ({
    icon: '⚠', tone: 'warn',
    text: `We didn't look for more — ${plural(Number(m[1]), 'job is', 'jobs are')} already waiting`,
    sub: "Work through the ones you have (or drop the ones you don't want), and we'll look again."
  })],
  [/^Skipped .+ — /, (m, c) => ({
    icon: '·', text: `The ${c.co} advert had already closed`, sub: "So we didn't send anything."
  })],
  [/ moved to "([a-z_]+)"$/, (m, c) => ({
    icon: '·', text: `${c.co} — ${HOME_MOVED_WORDS[m[1]] || 'moved on'}`,
    sub: c.job ? c.job.title : ''
  })],
  [/^⚠/, () => ({
    icon: '⚠', tone: 'warn', text: "One of the places we look didn't answer",
    sub: 'Nothing is lost — we try again on the next round.'
  })],

  // ---- said better elsewhere: the run itself carries these ----------------
  [/^Auto cycle complete:/, () => null],
  [/^\u{1F4D2} Run complete/u, () => null]
];

// Anything the rules do not know is still said in words, never raw.
const HOME_FALLBACK = {
  search: { icon: '\u{1F50D}', text: 'We went looking for jobs for you' },
  move: { icon: '·', text: 'One of your jobs moved on' },
  apply: { icon: '✉', text: 'An application went out' },
  tailor: { icon: '✍', text: 'We wrote one of your applications' },
  cv: { icon: '\u{1F4C4}', text: 'Your details changed' },
  settings: { icon: '⚙', text: 'Something in Settings changed' },
  reply: { icon: '★', tone: 'good', text: 'A company got back to you' },
  followup: { icon: '↻', text: 'We chased one of your applications' },
  insights: { icon: '\u{1F4CA}', text: 'We looked at how your search is going' },
  run: { icon: '✓', text: 'A round finished' },
  error: {
    icon: '⚠', tone: 'warn', text: "Something didn't work",
    sub: 'Nothing is lost — we try again on the next round.'
  },
  info: { icon: '·', text: 'JobPilot was busy in the background' }
};

// The company's name is in the line itself — "…for Client Success Advisor at
// Corvus Group — …" — which is what keeps a line readable after the job it was
// about has been deleted ("Not interested" removes the record entirely).
function companyInText(raw) {
  // The name runs to the first punctuation, or to one of the few clauses the
  // server appends straight after it with no punctuation in between.
  const m = /\bat ([^—:"()]+?)(?:\s*[—:(]|\s+moved to\b|\s+closed\b|\s+per your feedback\b|[.!?]?\s*$)/.exec(String(raw));
  const name = m ? m[1].trim() : '';
  return name && name.length > 1 && name.length < 60 ? name : '';
}

function homeEvent(entry, apps) {
  const raw = String(entry.text || '');
  const job = findJobInText(raw, apps);
  const co = job ? job.company : companyInText(raw);
  const ctx = { job, co, raw };
  for (const [re, build] of HOME_RULES) {
    const m = re.exec(raw);
    if (!m) continue;
    // Every rule that takes a context uses the company's name in its sentence.
    // Without one those read "Nudged them again" and "them — you applied", so
    // we drop to the plain sentence for this kind of event instead: it names
    // nobody, which is the honest thing when we no longer know who it was.
    if (!co && build.length >= 2) break;
    const out = build(m, ctx);
    if (!out) return null;                       // deliberately not shown
    return { at: entry.at, jobId: out.go ? '' : (job ? job.id : ''), ...out };
  }
  const fb = HOME_FALLBACK[entry.type] || HOME_FALLBACK.info;
  return { at: entry.at, jobId: job ? job.id : '', ...fb };
}

// A finished round, from the run ledger rather than the activity feed.
function homeRunEvent(r) {
  const sent = (r.sent || 0) + (r.simulated || 0);
  const bits = [
    r.found ? `${r.found} found` : '',
    r.tailored ? `${r.tailored} written` : '',
    sent ? `${sent} sent` : '',
    r.manualQueued ? `${r.manualQueued} left for you to send` : ''
  ].filter(Boolean).join(' · ');
  return {
    at: r.endedAt || r.startedAt, icon: '✓', tone: 'good', jobId: '',
    text: r.mode === 'auto' ? 'JobPilot ran a whole round on its own' : 'That round is finished',
    sub: (bits || 'Nothing came of this one') + (r.costTotal ? ` · cost ${fmtMoney(r.costTotal)}` : '')
  };
}

function homeTimeline(data) {
  const apps = data.applications || [];
  const out = [];
  for (const entry of (data.stats && data.stats.activity) || []) {
    const it = homeEvent(entry, apps);
    if (it) out.push(it);
  }
  for (const r of data.runs || []) {
    if (r.endedAt) out.push(homeRunEvent(r));
  }
  return out.sort((a, b) => b.at - a.at);
}

/* ---------------------------------------------------------------------------
 * The screen
 * ------------------------------------------------------------------------ */

const FOLLOW_UP_DAYS_UI = [3, 5, 10];

// Applications you made on a company's own site, where a nudge is due and only
// you can send it.
function homeNudgesDue(apps) {
  const out = [];
  for (const a of apps) {
    // Not "has no address" — "JobPilot is not the one chasing this". Somebody
    // who sends their own applications owns every nudge, address or not.
    if (!a.appliedAt || chasedByUs(a) || a.replied) continue;
    if (['replied', 'interview', 'offer', 'rejected', 'closed'].includes(a.status)) continue;
    for (const day of FOLLOW_UP_DAYS_UI) {
      if (Date.now() < a.appliedAt + day * 86400000) continue;
      if ((a.followups || []).some(f => f.day === day)) continue;
      out.push({ app: a, day });
      break;
    }
  }
  return out.sort((x, y) => x.app.appliedAt - y.app.appliedAt);
}

// Everything that genuinely wants a human, in the order it is worth doing.
// `slot: true` means the big button itself belongs on that row.
function homeNeedsItems(data) {
  const apps = data.applications || [];
  const items = [];
  const mine = sendsHerself(data);
  // "Ready" means ready for US to email. When the person sends, there is no such
  // state — those are their own to send, and they join the rows below instead of
  // being offered behind a button that would say "Send this application".
  const ready = mine ? 0 : apps.filter(a => a.status === 'ready').length;
  const towrite = apps.filter(a => ['discovered', 'approved'].includes(a.status)).length;

  if (ready > 0) {
    items.push({
      icon: '✉', slot: true,
      title: `${capFirst(pluralWords(ready, 'application is', 'applications are'))} written and ready`,
      sub: `We email ${ready === 1 ? 'it' : 'each one'} from your address and chase it up. `
        + 'Nothing goes to a company until you press the button.'
    });
  } else if (towrite > 0) {
    items.push({
      icon: '✍', slot: true,
      title: `${capFirst(pluralWords(towrite, 'job is', 'jobs are'))} waiting for us to write`,
      sub: "We rewrite your CV for each one and draft a short message to go with it. It takes about a minute."
    });
  }

  // Anything written and waiting on the person: the companies with no address,
  // plus — when they send their own — everything else that has been written.
  const action = apps.filter(a => a.status === 'action' || (mine && a.status === 'ready'));
  for (const a of action.slice(0, 4)) {
    items.push({
      job: a.id, initials: initialsOf(a.company), isJob: true,
      title: `${a.title} at ${a.company}`,
      sub: a.recipientEmail && mine
        ? 'Written and waiting — the message and your CV are ready for you to send'
        : a.tailored
          ? 'They only take applications on their own site — everything is ready to paste in'
          : 'They only take applications on their own site',
      cta: a.recipientEmail && mine ? 'Send it' : 'Do it now'
    });
  }
  if (action.length > 4) {
    items.push({
      icon: '✋', go: 'jobs', title: `${capFirst(numWords(action.length - 4))} more like these`,
      sub: mine ? 'All written and waiting on you' : "All waiting on the companies' own forms", cta: 'Show me'
    });
  }

  for (const { app: a, day } of homeNudgesDue(apps).slice(0, 3)) {
    items.push({
      job: a.id, initials: initialsOf(a.company), isJob: true,
      title: `Time to nudge ${a.company}`,
      sub: `You applied on their own site ${agoWords(a.appliedAt)} — the day ${day} reminder is yours to send`,
      cta: 'Show me'
    });
  }
  return items;
}

function homeNeedsRowHtml(it) {
  const end = it.slot
    ? '<span class="jp-home-slot" id="homeSmartSlot"></span>'
    : `<button class="jp-btn jp-btn--primary jp-btn--sm">${esc(it.cta || 'Open')}</button>`;
  const tap = it.job ? ` data-job="${esc(it.job)}" role="button" tabindex="0"`
    : it.go ? ` data-go="${esc(it.go)}" role="button" tabindex="0"` : '';
  const mark = it.initials
    ? `<span class="jp-avatar">${esc(it.initials)}</span>`
    : `<span class="jp-avatar jp-avatar--accent">${it.icon || '·'}</span>`;
  return `
    <div class="jp-row${it.job || it.go ? ' jp-row--tap' : ''}"${tap}>
      ${mark}
      <div class="jp-row-main">
        <div class="jp-row-title">${esc(it.title)}</div>
        <div class="jp-row-sub">${esc(it.sub || '')}</div>
      </div>
      <div class="jp-row-end">${end}</div>
    </div>`;
}

function homeNeedsHtml(data, items) {
  const first = homeFirstName(data);
  const who = first ? `, ${esc(first)}` : '';
  const n = items.length;
  const mins = Math.max(2, Math.round(n * 1.5));
  const allJobs = items.every(i => i.isJob);
  const head = allJobs
    ? `${capFirst(numWords(n))} ${n === 1 ? 'job is' : 'jobs are'} waiting on you${who}`
    : `${capFirst(numWords(n))} ${n === 1 ? 'thing needs' : 'things need'} you${who}`;
  return `
    <div class="jp-card jp-card--accent jp-card--shadow jp-home-block">
      <div class="jp-row-flex jp-home-eyebrow">
        <span class="jp-eyebrow jp-eyebrow--accent">Needs you</span>
        <span class="jp-note">· about ${mins} minutes</span>
      </div>
      <h2 class="jp-h2 jp-home-needs-head">${head}</h2>
      <div class="jp-list jp-list--ruled">${items.map(homeNeedsRowHtml).join('')}</div>
    </div>`;
}

// Nothing waiting is the normal state, and it should feel like good news.
function homeCalmHtml(data) {
  // Exactly the number on the "waiting to hear back" tile above — counted the
  // same way, from the same place. Counting every `appliedAt` instead put
  // "we're waiting on 3 companies and chasing them for you" under a tile
  // reading 0, for three jobs that were closed and rejected.
  const by = (data.stats && data.stats.byStatus) || {};
  const out = (by.applied || 0) + (by.followup || 0);
  const mine = sendsHerself(data);
  const waiting = mine
    ? `We're waiting to hear from ${plural(out, 'company', 'companies')}. We'll tell you when it's worth nudging them.`
    : `We're waiting on ${plural(out, 'company', 'companies')} and chasing them for you. Anything that needs a person lands here.`;
  return `
    <div class="jp-card jp-card--quiet jp-home-block">
      <div class="jp-row-flex">
        <span class="jp-avatar jp-avatar--good">✓</span>
        <div class="jp-row-main">
          <div class="jp-h-sans">Nothing needs you right now</div>
          <div class="jp-note">${out ? waiting
      : 'Anything that needs a person will land here. Everything else we do ourselves.'}</div>
        </div>
      </div>
    </div>`;
}

function homeEmptyHtml(data) {
  // Skipping the CV used to land here, on "Find my first jobs", which could only
  // come back with an error. The CV is the thing that is actually missing, so
  // that is what this state is about — and the big button asks for it.
  if (!hasCv(data)) return `
    <div class="jp-empty jp-home-block">
      <div class="jp-empty-icon">📄</div>
      <h2 class="jp-h2">First, your CV</h2>
      <p class="jp-lede">It is the one thing we can't work without — every application we write starts
        from it, and it is how we tell which jobs are worth your time. One file, one time.</p>
      <span class="jp-home-slot" id="homeSmartSlot"></span>
      <p class="jp-note jp-note--center jp-home-empty-note">PDF, Word or plain text. It stays on this
        computer, and you can swap it for a better one whenever you like.</p>
    </div>`;
  return `
    <div class="jp-empty jp-home-block">
      <div class="jp-empty-icon">✈</div>
      <h2 class="jp-h2">Nothing here yet — that's normal</h2>
      <p class="jp-lede">Your first search takes about a minute. We'll look at company career
        pages and free job boards, then show you what fits.</p>
      <span class="jp-home-slot" id="homeSmartSlot"></span>
      <p class="jp-note jp-note--center jp-home-empty-note">Nothing goes to a company until you say so.</p>
    </div>`;
}

// The round in progress, as the comp's step checklist.
function homeRunHtml(data) {
  const r = data.currentRun;
  const op = r && r.activeOp;
  if (!op || !OP_LABELS[op]) return '';
  const order = ['fetching', 'generating', 'sending'];
  const at = order.indexOf(op);
  const sent = (r.sent || 0) + (r.simulated || 0);
  const steps = [
    { text: 'Looking for jobs that suit you', note: r.found ? `${r.found} found` : '' },
    { text: 'Writing your CV and message for each one', note: r.tailored ? `${r.tailored} written` : '' },
    { text: 'Sending them off', note: sent ? `${sent} sent` : '' }
  ].map((s, i) => {
    const state = i === at ? 'now' : (i < at || s.note) ? 'done' : 'next';
    return `
      <div class="jp-row-flex jp-home-step is-${state}">
        <span class="jp-home-step-mark">${state === 'done' ? '✓' : state === 'now' ? '•' : '·'}</span>
        <span>${s.text}</span>
        <span class="jp-note jp-spacer">${esc(s.note)}</span>
      </div>`;
  }).join('');

  const secs = Math.max(0, Math.round((Date.now() - (r.activeSince || Date.now())) / 1000));
  const elapsed = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} minutes so far`;
  return `
    <div class="jp-card jp-card--lg jp-home-block">
      <div class="jp-row-flex jp-home-run-head">
        <span class="jp-dot jp-dot--live"></span>
        <div class="jp-h-sans">${esc(OP_LABELS[op].text)}…</div>
        <span class="jp-note jp-spacer">${esc(elapsed)}</span>
      </div>
      ${steps}
      <p class="jp-note jp-home-run-foot">You can close this — we'll keep going and tell you when it's done.</p>
    </div>`;
}

function homeFeedHtml(items) {
  const days = [];
  for (const it of items) {
    const label = dayLabel(it.at);
    let day = days.find(d => d.label === label);
    if (!day) { day = { label, items: [] }; days.push(day); }
    if (day.items.length < 8) day.items.push(it);
  }
  const shown = days.slice(0, 3);
  const html = shown.map(day => `
      <div class="jp-home-day">
        <div class="jp-eyebrow jp-tl-day">${esc(day.label)}</div>
        ${day.items.map(it => {
    const tap = it.jobId ? ` data-job="${esc(it.jobId)}" role="button" tabindex="0"`
      : it.go ? ` data-go="${esc(it.go)}" role="button" tabindex="0"` : '';
    return `
          <div class="jp-tl-item">
            <div class="jp-tl-rail">
              <span class="jp-tl-icon${it.tone ? ' jp-tl-icon--' + it.tone : ''}">${it.icon || '·'}</span>
              <div class="jp-tl-line"></div>
            </div>
            <div class="jp-tl-body">
              <div class="jp-tl-card${it.tone === 'good' ? ' jp-tl-card--good' : ''}${tap ? ' jp-row--tap' : ''}"${tap}>
                <div class="jp-row-main">
                  <div class="jp-row-title jp-row-title--light">${esc(it.text)}</div>
                  ${it.sub ? `<div class="jp-row-sub jp-row-sub--sm">${esc(it.sub)}</div>` : ''}
                </div>
                <span class="jp-row-meta">${esc(clockTime(it.at))}</span>
                ${it.cta ? `<button class="jp-btn jp-btn--quiet jp-btn--xs">${esc(it.cta)}</button>` : ''}
              </div>
            </div>
          </div>`;
  }).join('')}
      </div>`).join('');
  return { days: shown.length, html };
}

// Move a control (never re-create one) into whichever slot the current layout
// offers. Held by reference, because the slot it was in a moment ago may have
// just been replaced.
const homeSmartBtn = document.getElementById('smartBtn');
function homePlace(el, slotId) {
  const slot = document.getElementById(slotId);
  if (el && slot && el.parentNode !== slot) slot.appendChild(el);
}

const homeShowing = { needs: null, run: null, feed: null, stats: null, head: null };

function renderHome() {
  const needs = document.getElementById('homeNeeds');
  if (!needs) return;                    // Home's frame is not in the page
  const data = JobPilot.data;
  if (!data) return;                     // the frame's own skeleton is showing
  const apps = data.applications || [];
  const stats = data.stats || {};
  const by = stats.byStatus || {};
  const isEmpty = !apps.length;
  const timeline = homeTimeline(data);

  // ---- the greeting and the date line ----
  const first = homeFirstName(data);
  const hour = new Date().getHours();
  const greeting = (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + (first ? `, ${first}` : '');
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const todays = timeline.filter(it => dayLabel(it.at) === 'Today');
  const since = todays.length ? todays[todays.length - 1].at : 0;
  const dateLine = data.currentRun && data.currentRun.activeOp
    ? `${today} · JobPilot is working on it right now`
    : since ? `${today} · JobPilot has been working since ${clockTime(since)}`
      : timeline.length ? `${today} · nothing has happened yet today`
        : today;
  if (greeting + dateLine !== homeShowing.head) {
    homeShowing.head = greeting + dateLine;
    document.getElementById('homeTitle').textContent = greeting;
    document.getElementById('homeDate').textContent = dateLine;
  }

  // ---- three plain-word numbers ----
  const statCards = isEmpty ? [] : [
    { num: (by.applied || 0) + (by.followup || 0), label: 'waiting to hear back' },
    { num: stats.interviews || 0, label: stats.interviews === 1 ? 'interview booked' : 'interviews booked' },
    { num: stats.applied || 0, label: 'sent in total' }
  ];
  if (stats.offers) statCards.push({ num: stats.offers, label: stats.offers === 1 ? 'job offer' : 'job offers' });
  const statsHtml = statCards.map(s =>
    `<div><div class="jp-stat-num">${s.num}</div><div class="jp-stat-label">${esc(s.label)}</div></div>`).join('');
  if (statsHtml !== homeShowing.stats) {
    homeShowing.stats = statsHtml;
    document.getElementById('homeStats').innerHTML = statsHtml;
  }

  // ---- the round in progress ----
  const runHtml = homeRunHtml(data);
  if (runHtml !== homeShowing.run) {
    homeShowing.run = runHtml;
    document.getElementById('homeRun').innerHTML = runHtml;
  }

  // ---- needs you / the empty state ----
  const items = homeNeedsItems(data);
  const needsHtml = isEmpty ? homeEmptyHtml(data)
    : items.length ? homeNeedsHtml(data, items)
      : homeCalmHtml(data);
  if (needsHtml !== homeShowing.needs) {
    homeShowing.needs = needsHtml;
    needs.innerHTML = needsHtml;
  }

  // ---- the big button goes wherever the next thing to do is ----
  homePlace(homeSmartBtn, document.getElementById('homeSmartSlot') ? 'homeSmartSlot' : 'homeRuleSlot');

  // ---- what's been happening ----
  //
  // The rule row carries the app's two primary controls as well as this
  // heading, so it is NEVER hidden: hiding it took "Find more jobs" and "Check
  // for replies" off Home entirely, which is the state every brand-new user
  // starts in. Only the heading and its divider come and go with the feed.
  const feed = homeFeedHtml(timeline);
  document.getElementById('homeRule').classList.toggle('jp-rule--bare', !timeline.length);
  if (feed.html !== homeShowing.feed) {
    homeShowing.feed = feed.html;
    document.getElementById('homeFeed').innerHTML = feed.html;
    document.getElementById('homeFeedFoot').innerHTML = feed.days
      ? `That's the last ${feed.days === 1 ? 'day' : `${feed.days} days`}. <a href="#/jobs" data-go="jobs">See every job →</a>`
      : '';
  }
  document.getElementById('homeMore').classList.toggle('jp-hidden', isEmpty && !timeline.length);
}

JobPilot.screens.register('home', { onEnter: renderHome });
document.addEventListener('jobpilot:data', renderHome);

// A "Needs you" line or a timeline card opens the one job panel. The jobs
// screen has its own listener for its own rows; the two never overlap.
document.addEventListener('click', e => {
  const el = e.target.closest('#mount-home [data-job], #mount-report [data-job]');
  if (el) openDrawer(el.dataset.job);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest && e.target.closest('#mount-home [data-job], #mount-report [data-job]');
  if (!el) return;
  e.preventDefault();
  openDrawer(el.dataset.job);
});

/* ===========================================================================
 * HOW IT'S GOING — the same numbers the improvement report is built from, read
 * out in a minute. Three parts, exactly as the comp: one sentence in serif,
 * where your replies come from, and the two things most worth changing.
 *
 * The written report (the AI's own long version) is still here, folded away
 * under the advice — it is honest about being longer and more technical.
 * ======================================================================== */

let reportInsights = null;      // /api/insights — reports + how often they run
let reportInsightsTried = false;
let reportShowing = null;

// Where a job came from, grouped into names a person recognises.
function reportSourceGroup(src) {
  const s = String(src || '');
  if (/career page/i.test(s)) return 'Company career pages';
  if (/remotive|remoteok|arbeitnow/i.test(s)) return 'Free job boards';
  if (/linkedin/i.test(s)) return 'LinkedIn';
  if (/naukri/i.test(s)) return 'Naukri';
  if (/adzuna/i.test(s)) return 'Adzuna';
  return 'Somewhere else';
}

function reportBars(apps) {
  const groups = new Map();
  for (const a of apps) {
    if (!a.appliedAt) continue;
    const key = reportSourceGroup(a.source);
    const g = groups.get(key) || { label: key, applied: 0, replied: 0 };
    g.applied++;
    if (a.replied || ['replied', 'interview', 'offer'].includes(a.status)) g.replied++;
    groups.set(key, g);
  }
  const list = [...groups.values()].map(g => ({ ...g, rate: g.applied ? g.replied / g.applied : 0 }));
  // The bar is each source's share of the replies, which is what the heading
  // promises — not its reply rate. A rate bar would put "one out of one" above
  // a career-page column built out of forty. The rate is what the sentence
  // underneath is about.
  const replies = list.reduce((n, g) => n + g.replied, 0);
  list.sort((a, b) => b.replied - a.replied || b.applied - a.applied);
  list.forEach((g, i) => {
    g.width = replies ? Math.max(4, Math.round(g.replied / replies * 100)) : 4;
    g.tone = !g.replied ? ' jp-bar-fill--warn' : i === 0 ? ' jp-bar-fill--good' : '';
  });
  return list;
}

// Only say "three times more often" when the numbers can carry it.
function reportBarsNote(bars) {
  const solid = bars.filter(b => b.applied >= 5).sort((a, b) => b.rate - a.rate);
  if (solid.length < 2) return "Once a few more have gone out we can tell you which of these is worth your time.";
  const [top, next] = solid;
  if (!next.rate) {
    return top.rate
      ? `Everything that has come back so far came from ${top.label.toLowerCase()}.`
      : "Nothing's come back from anywhere yet — early days.";
  }
  const times = top.rate / next.rate;
  if (times < 1.5) return 'They are all replying at about the same rate so far.';
  const word = times >= 2.5 && times < 3.5 ? 'three times' : times >= 3.5 ? `${numWords(Math.round(times))} times` : 'about twice';
  return `${top.label} reply ${word} more often than ${next.label.toLowerCase()}.`;
}

function reportLeadSentence(data) {
  const stats = data.stats || {};
  const applied = stats.applied || 0;
  const replies = stats.replied || 0;
  const interviews = stats.interviews || 0;
  if (!applied) {
    return "Nothing has gone out yet, so there's nothing to read into. "
      + "Once your first few applications are sent, this page tells you what's working and what isn't.";
  }
  if (!replies) {
    return `Nobody has written back yet — ${numWords(applied)} ${applied === 1 ? 'application is' : 'applications are'} out there waiting. `
      + (applied < 10
        ? 'That is completely normal this early — replies usually take a week or two.'
        : 'Two changes below are where the difference usually comes from.');
  }
  const rate = replies / applied * 100;
  const judgement = applied < 10 ? "It's early days, so don't read too much into it yet."
    : rate >= 15 ? "That's well above average for this kind of search."
      : rate >= 8 ? "That's about average for this kind of search."
        : "That's a little under average — the ideas below are where the difference usually comes from.";
  return `${capFirst(numWords(replies))} of your ${applied === replies ? '' : 'last '}${numWords(applied)} `
    + `${applied === 1 ? 'application' : 'applications'} got a reply`
    + (interviews ? ` — and ${numWords(interviews)} turned into ${interviews === 1 ? 'an interview' : 'interviews'}` : '')
    + `. ${judgement}`;
}

// The advice, from the real numbers. First two win, exactly as the comp.
function reportAdvice(data, bars) {
  const apps = data.applications || [];
  const s = data.settings || {};
  const stats = data.stats || {};
  const applied = apps.filter(a => a.appliedAt);
  const out = [];

  const action = apps.filter(a => a.status === 'action').length;
  if (action) {
    out.push({
      title: `${capFirst(pluralWords(action, 'job is', 'jobs are'))} waiting on you`,
      sub: 'These companies only take applications on their own site. Each one is about two minutes, '
        + 'and everything is written and ready to paste in.',
      cta: 'Show me', go: 'jobs'
    });
  }

  const simulated = applied.filter(a => a.applicationSent && a.applicationSent.simulated).length;
  if (simulated && !s.smtpConfigured) {
    out.push({
      title: 'Nothing has actually been emailed yet',
      sub: `Your email isn't connected, so ${pluralWords(simulated, 'application was', 'applications were')} a practice run — `
        + 'written and filed, but never sent. Connect it and they go out for real.',
      cta: 'Connect my email', go: 'settings'
    });
  }

  const pages = bars.find(b => b.label === 'Company career pages');
  const boards = bars.find(b => b.label === 'Free job boards');
  const companies = String(s.atsCompanies || '').split(',').map(x => x.trim()).filter(Boolean).length;
  if (pages && boards && pages.rate > boards.rate * 1.5 && companies < 25) {
    out.push({
      title: `Add ${companies ? 'five more companies you like' : 'a few companies you like'}`,
      sub: `Applying straight to a company's own careers page gets you ${pages.rate > boards.rate * 2.5 ? 'about three times' : 'roughly twice'} `
        + `the replies. You watch ${companies ? numWords(companies) : 'none'} at the moment — twenty-five is a good number.`,
      cta: 'Add companies', go: 'settings'
    });
  }

  const noAddress = applied.filter(a => !a.recipientEmail).length;
  if (applied.length >= 5 && noAddress > applied.length / 2) {
    out.push({
      title: 'Most of these had nobody to email',
      sub: `${capFirst(pluralWords(noAddress, 'application', 'applications'))} went out with no named person on the other end. `
        + 'Career pages and LinkedIn adverts often name a hiring contact — those get read far more often.',
      cta: 'Where we look', go: 'settings'
    });
  }

  if (applied.length >= 3 && !(stats.followupsSent || 0)) {
    out.push({
      title: 'Nobody has been nudged yet',
      sub: 'A short reminder on day 3, 5 and 10 is the single biggest thing that gets a reply. '
        + 'We do it for you by email, and remind you about the ones you sent by hand.',
      cta: 'Check for replies', go: 'home'
    });
  }

  const avg = applied.length
    ? Math.round(applied.reduce((n, a) => n + (a.matchScore || 0), 0) / applied.length) : 0;
  if (applied.length >= 8 && avg < 65) {
    out.push({
      title: "You're applying for jobs that aren't a close fit",
      sub: "On the whole these adverts asked for things your CV doesn't say you have. "
        + 'Narrowing what you are looking for gets fewer jobs, and more replies.',
      cta: 'Change what I want', go: 'settings'
    });
  }

  if (!out.length) {
    out.push({
      title: 'Nothing needs changing yet',
      sub: "Keep going — once forty or fifty applications are out we can tell what's working and what isn't.",
      cta: 'See my jobs', go: 'jobs'
    });
  }
  return out.slice(0, 2);
}

function reportRunsHtml(runs) {
  const rows = (runs || []).filter(r => r.endedAt).slice(0, 8).map(r => {
    const sent = (r.sent || 0) + (r.simulated || 0);
    const bits = [
      r.found ? `${r.found} found` : '',
      r.tailored ? `${r.tailored} written` : '',
      sent ? `${sent} sent` : ''
    ].filter(Boolean).join(' · ') || 'nothing came of it';
    return `
      <div class="jp-row">
        <div class="jp-row-main">
          <div class="jp-row-title jp-row-title--light">${esc(dayLabel(r.endedAt))} at ${esc(clockTime(r.endedAt))}</div>
          <div class="jp-row-sub jp-row-sub--sm">${esc(bits)}${r.mode === 'auto' ? ' · JobPilot did this one on its own' : ''}</div>
        </div>
        <span class="jp-row-meta">${fmtMoney(r.costTotal || 0)}</span>
      </div>`;
  }).join('');
  return rows || '<p class="jp-note">Nothing has run yet.</p>';
}

function reportScreenHtml(data) {
  const apps = data.applications || [];
  const stats = data.stats || {};
  if (!apps.length) {
    return `
      <div class="jp-page">
        <h1 class="jp-title">How it's going</h1>
        <p class="jp-lede jp-report-lede">Read in a minute. Written for you, not for a spreadsheet.</p>
        <div class="jp-empty">
          <div class="jp-empty-icon">📊</div>
          <h2 class="jp-h2">Nothing to say yet — that's normal</h2>
          <p class="jp-lede">Once your first applications are out, this page tells you which ones are
            getting replies, and the one or two things worth changing.</p>
          <button class="jp-btn jp-btn--primary" data-go="home">Start on the home page</button>
        </div>
      </div>`;
  }

  const bars = reportBars(apps);
  const advice = reportAdvice(data, bars);
  const cost = stats.costTotalUSD || 0;
  const followups = stats.followupsSent || 0;
  const applied = stats.applied || 0;
  const reports = (reportInsights && reportInsights.reports) || [];
  const latest = reports[0];

  const barsHtml = bars.length ? bars.map(b => `
    <div class="jp-bar">
      <div class="jp-bar-head"><span>${esc(b.label)}</span><span class="jp-muted">${b.replied} of ${b.applied}</span></div>
      <div class="jp-bar-track"><div class="jp-bar-fill${b.tone}" style="width:${b.width}%"></div></div>
    </div>`).join('') + `<p class="jp-note jp-report-note">${esc(reportBarsNote(bars))}</p>`
    : '<p class="jp-note">Nothing has gone out yet, so there is nothing to compare.</p>';

  return `
    <div class="jp-page">
      <h1 class="jp-title">How it's going</h1>
      <p class="jp-lede jp-report-lede">Read in a minute. Written for you, not for a spreadsheet.</p>

      <div class="jp-card jp-card--lg jp-report-lead">
        <p class="jp-lead-serif">${esc(reportLeadSentence(data))}</p>
      </div>

      <div class="jp-grid-2 jp-report-grid">
        <div class="jp-card">
          <h2 class="jp-h-sans--sm jp-report-h">Where your replies come from</h2>
          ${barsHtml}
        </div>
        <div class="jp-card">
          <h2 class="jp-h-sans--sm jp-report-h">${advice.length === 1 ? 'One thing worth changing' : 'Two things worth changing'}</h2>
          ${advice.map(a => `
            <div class="jp-report-advice">
              <div class="jp-row-title jp-row-title--light">${esc(a.title)}</div>
              <div class="jp-row-sub">${esc(a.sub)}</div>
              <button class="jp-btn jp-btn--quiet jp-btn--xs jp-report-cta" data-go="${esc(a.go)}">${esc(a.cta)}</button>
            </div>`).join('')}
        </div>
      </div>

      <div class="jp-card jp-card--quiet jp-card--tight jp-report-cost">
        <details class="jp-report-details">
          <summary class="jp-report-cost-head">
            <div class="jp-row-main">
              <div class="jp-h-sans--sm">${cost
    ? `Everything so far has cost you ${fmtMoney(cost)}`
    : "It hasn't cost you anything so far"}</div>
              <div class="jp-note">${applied ? `${plural(applied, 'application', 'applications')}, ` : ''}${followups
    ? `${plural(followups, 'nudge', 'nudges')}, ` : ''}${applied || followups
    // With nothing sent yet both counts are empty, and a bare "and all the
    // reading…" is the first thing a new user reads on this screen.
    ? 'and all the reading and writing in between'
    : 'That covers all the reading and the writing'}. Sending email is free.</div>
            </div>
            <span class="jp-btn jp-btn--secondary jp-btn--sm jp-spacer">See the details</span>
          </summary>
          <div class="jp-list jp-list--flat jp-report-runs">${reportRunsHtml(data.runs)}</div>
        </details>
      </div>

      <div class="jp-card jp-report-long">
        <div class="jp-row-flex">
          <div class="jp-row-main">
            <div class="jp-h-sans--sm">${latest ? 'The longer write-up' : 'Want a longer write-up?'}</div>
            <div class="jp-note">${latest
    ? `Written ${agoWords(latest.at)} by the same writer that does your applications. More detail than this page, and a little more technical.`
    : "We can go through everything you've sent and write you a longer, more detailed read."}</div>
          </div>
          <button class="jp-btn jp-btn--secondary jp-btn--sm jp-spacer" id="reportRunNow" data-needs-ai>Have another look</button>
        </div>
        ${latest ? `
          <details class="jp-report-details jp-report-body">
            <summary class="jp-note">Read it</summary>
            <div class="jp-doc jp-doc--sm jp-doc--scroll">${esc(latest.body || '')}</div>
          </details>` : ''}
      </div>
    </div>`;
}

function renderReportScreen() {
  const mount = JobPilot.mount('report');
  if (!mount) return;
  const data = JobPilot.data;
  if (!data) return;                       // the frame's own skeleton is showing
  const html = reportScreenHtml(data);
  if (html === reportShowing) return;
  reportShowing = html;
  mount.innerHTML = html;
}

// The written reports are not part of the shared snapshot — one fetch when the
// screen is first opened, and again after a new one is written. No polling.
async function reportLoadInsights() {
  try {
    reportInsights = await api('/api/insights');
    reportShowing = null;
    renderReportScreen();
  } catch { /* the page reads fine without the long version */ }
}

JobPilot.screens.register('report', {
  onEnter() {
    renderReportScreen();
    if (!reportInsightsTried) { reportInsightsTried = true; reportLoadInsights(); }
  }
});
document.addEventListener('jobpilot:data', () => {
  if (JobPilot.screens.current() === 'report') renderReportScreen();
});

// "Have another look" — the old sidebar's "Generate report now".
document.addEventListener('click', async e => {
  const btn = e.target.closest('#reportRunNow');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="jp-spinner"></span>Reading it all…';
  try {
    const r = await api('/api/insights/run', { method: 'POST' });
    toast(r.emailed ? `Done — we also sent it to ${r.to}.` : 'Done — it is at the bottom of this page.');
    await reportLoadInsights();
    await refresh();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = 'Have another look';
  }
});

// JobPilot dashboard
const COLUMNS = [
  { id: 'discovered', label: 'Discovered', statuses: ['discovered'], color: '#4f8cff' },
  { id: 'approved',   label: 'Approved',   statuses: ['approved'],   color: '#9d7bff' },
  { id: 'ready',      label: 'CV Ready',   statuses: ['ready'],      color: '#7c5cff' },
  { id: 'action',     label: 'Your action ✋', statuses: ['action'],  color: '#e0653c' },
  { id: 'applied',    label: 'Applied',    statuses: ['applied'],    color: '#3fb96f' },
  { id: 'followup',   label: 'Follow-up',  statuses: ['followup'],   color: '#e0a53c' },
  { id: 'replied',    label: 'Replied ⭐',  statuses: ['replied'],    color: '#f2c94c' },
  { id: 'interview',  label: 'Interview',  statuses: ['interview', 'offer'], color: '#38c6d0' },
  { id: 'closed',     label: 'Closed',     statuses: ['closed', 'rejected'], color: '#5a6577' }
];

let state = { applications: [], stats: null, openId: null, settings: null, lastRunCost: null, lastRunLabel: '' };
let filters = { stage: 'all', from: '', to: '' };

const $ = s => document.querySelector(s);

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
  renderStats(stats);
  renderBoard();
  renderSmartButton();
  renderCostLine();
  renderProfiles(profilesData.profiles);
  renderActivity(stats.activity);
  state.currentRun = runsData.current || null;
  renderRuns(runsData);
  renderRunStatus();
  renderProfileCard();
  renderSideStatus(settings);
  const badge = $('#modeBadge');
  badge.textContent = stats.mockMode ? 'AI: mock mode' : `AI: ${stats.provider.provider} · ${stats.provider.model}`;
  badge.className = 'badge ' + (stats.mockMode ? 'mock' : 'live');
  if (state.settings) {
    $('#modeSelect').value = state.settings.mode;
  }
  if (state.openId) {
    const a = state.applications.find(x => x.id === state.openId);
    if (a) renderDrawer(a);
  }
}

// ---------- The smart button ----------

function pipelineCounts() {
  const by = {};
  for (const a of state.applications) by[a.status] = (by[a.status] || 0) + 1;
  return { disc: by.discovered || 0, appr: by.approved || 0, ready: by.ready || 0, action: by.action || 0 };
}

function renderSmartButton() {
  const { disc, appr, ready } = pipelineCounts();
  const btn = $('#smartBtn');
  if (ready > 0) {
    btn.dataset.action = 'send';
    btn.textContent = `📧 Email ${ready} application${ready > 1 ? 's' : ''}`;
    btn.className = 'btn btn-green smart-btn';
  } else if (disc + appr > 0) {
    btn.dataset.action = 'generate';
    btn.textContent = `⚡ Generate ${disc + appr} CV${disc + appr > 1 ? 's' : ''} & email${disc + appr > 1 ? 's' : ''}`;
    btn.className = 'btn btn-primary smart-btn';
  } else {
    btn.dataset.action = 'fetch';
    btn.textContent = '🔍 Find jobs';
    btn.className = 'btn btn-primary smart-btn';
  }
}

function renderCostLine() {
  const total = state.stats ? state.stats.costTotalUSD : 0;
  const last = state.lastRunCost && state.lastRunCost.usd
    ? `<span class="last">last ${state.lastRunLabel}: ${fmtCost(state.lastRunCost.usd)}</span> · ` : '';
  $('#costLine').innerHTML = `${last}API cost so far: <b>${fmtCost(total)}</b>`;
}

$('#smartBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>Working…';
  try {
    if (action === 'fetch') {
      const r = await api('/api/batch/fetch', { method: 'POST', body: {} });
      state.lastRunCost = r.cost; state.lastRunLabel = 'find';
      if (r.reason) {
        toast(r.reason, true); // fetch didn't run — tell the user exactly why
      } else {
        toast((r.added
          ? `Found ${r.added} good new matches (${r.skipped} poor fits filtered). Remove any you don't like (✕), then hit the button again.`
          : `No new matches right now — ${r.skipped} jobs were screened but didn't fit, and good ones may already be on your board. Try a manual search with a different term.`)
          + costSuffix(r.cost));
      }
    } else if (action === 'generate') {
      const r = await api('/api/batch/generate', { method: 'POST' });
      state.lastRunCost = r.cost; state.lastRunLabel = 'generate';
      if (r.done === 0 && r.error) {
        toast(r.error, true);
      } else {
        toast(`Generated ${r.done} tailored CVs & emails${r.fixed ? ` (${r.fixed} corrected by fact-check)` : ''}${r.failed ? ` (${r.failed} failed: ${esc(r.error)})` : ''}.`
          + (r.manualQueued ? ` ${r.manualQueued} have no recruiter email — they're in "Your action ✋": apply on the platform, then confirm on the card.` : '')
          + ' Review the drafts, then hit Send.' + costSuffix(r.cost));
      }
    } else if (action === 'send') {
      const ready = state.applications.filter(a => a.status === 'ready').length;
      const { action: actionCount } = pipelineCounts();
      if (!confirm(`Email ${ready} application${ready > 1 ? 's' : ''} with the tailored CV attached as PDF?`
        + (actionCount ? `\n(${actionCount} more in "Your action" need you to apply on the platform yourself.)` : ''))) {
        btn.disabled = false; btn.textContent = oldText; return;
      }
      const r = await api('/api/batch/send', { method: 'POST' });
      const runCost = r.run ? { usd: r.run.costTotal, ai: r.run.costAI, source: r.run.costSource } : r.cost;
      toast(`Sent: ${r.sent} real, ${r.simulated} simulated${r.expired ? `, ${r.expired} expired postings skipped` : ''}${r.failed ? `, ${r.failed} failed` : ''} — follow-ups on day 3, 5, 10.`
        + (r.run ? ` Run total: AI ${fmtCost(r.run.costAI)} + sources ${fmtCost(r.run.costSource)} = ${fmtCost(r.run.costTotal)}` : costSuffix(runCost)));
    }
    await refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  renderSmartButton();
});

// ---------- Sync button: due follow-ups + inbox + reload ----------

$('#syncBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Syncing…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    let msg = `Sync done: ${r.followupsSent} due follow-up${r.followupsSent === 1 ? '' : 's'} sent`;
    if (r.inbox) {
      const i = r.inbox;
      const bits = [];
      if (i.repliesFound) bits.push(`${i.repliesFound} repl${i.repliesFound === 1 ? 'y' : 'ies'}`);
      if (i.interviews) bits.push(`${i.interviews} interview invite${i.interviews === 1 ? '' : 's'} 🎉`);
      if (i.rejections) bits.push(`${i.rejections} rejection${i.rejections === 1 ? '' : 's'}`);
      if (i.confirmations) bits.push(`${i.confirmations} received-confirmation${i.confirmations === 1 ? '' : 's'}`);
      if (i.contactsCaptured) bits.push(`${i.contactsCaptured} contact${i.contactsCaptured === 1 ? '' : 's'} captured from platform replies`);
      msg += `, inbox read (${bits.join(', ') || 'nothing new'})`;
    }
    else if (r.inboxError) msg += ` — inbox check failed: ${r.inboxError}`;
    else msg += ' (add Gmail in Settings to also read replies)';
    toast(msg);
    await refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = '🔄 Sync — follow-ups & inbox';
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

$('#profileSelect').addEventListener('change', async e => {
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

async function renderProfileCard() {
  const { profile } = await api('/api/profile');
  const el = $('#profileCard');
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
      <button class="btn-link" id="editProfileBtn" style="padding:0">✏️ Edit profile</button>
      <label class="btn-link" for="cvInput" style="padding:0">Re-upload CV</label>
    </div>
  `;
  $('#editProfileBtn')?.addEventListener('click', () => openProfileEditor(profile));
}

// ---------- Stats / board / activity ----------

function renderStats(s) {
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
  const srcHtml = [
    { on: s.sources.ats, name: 'Career pages (ATS)', note: s.sources.ats ? 'live' : 'add companies' },
    { on: s.sources.remotive, name: 'Free boards ×3', note: s.sources.remotive ? 'live' : 'off' },
    { on: s.sources.adzuna, name: 'Adzuna', note: s.sources.adzuna ? 'live' : 'add API keys' },
    { on: s.sources.linkedin && s.apifyTokenSet, name: 'LinkedIn (Apify)', note: s.sources.linkedin ? (s.apifyTokenSet ? 'live' : 'needs token') : 'off' },
    { on: s.sources.naukri && s.apifyTokenSet, name: 'Naukri (Apify)', note: s.sources.naukri ? (s.apifyTokenSet ? 'live' : 'needs token') : 'off' }
  ].map(x =>
    `<div class="source ${x.on ? 'on' : ''}"><span class="dot ${x.on ? 'green' : 'gray'}"></span>${x.name} <small>${x.note}</small></div>`
  ).join('');
  document.querySelector('.source-list').innerHTML = srcHtml;

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
  const visible = state.applications.filter(matchesFilters);
  const filtering = filters.stage !== 'all' || filters.from || filters.to;
  $('#filterCount').textContent = filtering ? `${visible.length} of ${state.applications.length} shown` : '';

  board.innerHTML = COLUMNS.map(col => {
    const cards = visible.filter(a => col.statuses.includes(a.status));
    const bulkBtn = col.id === 'action' && cards.length
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

  board.querySelectorAll('.card').forEach(el => {
    el.addEventListener('dragstart', e => { el.classList.add('dragging'); e.dataTransfer.setData('id', el.dataset.id); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('click', () => openDrawer(el.dataset.id));
  });
  board.querySelectorAll('.card-link').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation()); // open the posting, not the drawer
  });
  board.querySelectorAll('.card-x').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      await api(`/api/applications/${el.dataset.id}`, { method: 'DELETE' });
      refresh();
    });
  });
  board.querySelectorAll('.column').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('id');
      const colDef = COLUMNS.find(c => c.id === col.dataset.col);
      const status = colDef.id === 'closed' ? 'rejected' : colDef.statuses[0];
      try {
        await api(`/api/applications/${id}`, { method: 'PATCH', body: { status } });
        refresh();
      } catch (err) { toast(err.message, true); }
    });
  });
}

function cardHtml(a) {
  const cls = a.matchScore >= 75 ? 'hi' : a.matchScore >= 55 ? 'mid' : 'lo';
  const pips = [3, 5, 10].map(d =>
    `<span class="pip ${(a.followups || []).some(f => f.day === d) ? 'sent' : ''}" title="Day ${d} follow-up"></span>`).join('');
  const removable = ['discovered', 'approved'].includes(a.status);
  return `
    <div class="card" draggable="true" data-id="${esc(a.id)}">
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

// Is a run step executing right now? Returns its label, or null.
const OP_LABELS = {
  fetching:   { icon: '🔍', text: 'Finding jobs', count: r => `${r.found} found so far` },
  generating: { icon: '⚡', text: 'Generating CVs & emails', count: r => `${r.tailored} done` },
  sending:    { icon: '📧', text: 'Sending applications', count: r => `${r.sent + r.simulated} sent` }
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
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${L.text}…`;
  } else if (r) {
    // a cycle is open but no step executing — say exactly what it's waiting for
    const { disc, appr, ready } = pipelineCounts();
    const cost = `cost so far ${fmtCost((r.costAI || 0) + (r.costSource || 0))}`;
    let msg;
    if (disc + appr > 0) {
      msg = `🔎 Found <b>${disc + appr}</b> jobs — waiting for your review. Remove bad fits (✕), then hit <b>⚡ Generate</b>.`;
    } else if (ready > 0) {
      msg = `📝 <b>${ready}</b> tailored draft${ready > 1 ? 's' : ''} waiting for your review — open the cards to check CV &amp; email, then hit <b>📧 Email</b>.`;
    } else {
      msg = `Finishing up — the run closes automatically once everything is sent or handed to you.`;
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
  $('#activityFeed').innerHTML = (items || []).slice(0, 12).map(a =>
    `<li><span class="when">${timeAgo(a.at)}</span><span>${esc(a.text)}</span></li>`).join('') ||
    '<li><span>No activity yet — upload your CV and hit Find jobs.</span></li>';
}

// ---------- Drawer ----------

function openDrawer(id) {
  state.openId = id;
  const a = state.applications.find(x => x.id === id);
  if (!a) return;
  renderDrawer(a);
  $('#drawerOverlay').classList.remove('hidden');
}

function closeDrawer() {
  state.openId = null;
  $('#drawerOverlay').classList.add('hidden');
}

function renderDrawer(a) {
  const t = a.tailored;
  const fuStopped = a.replied || ['replied', 'interview', 'offer', 'rejected', 'closed'].includes(a.status);
  const followupHtml = a.appliedAt && !a.recipientEmail ? `
    <h3>Follow-ups — you applied on the platform (day 3, 5, 10)</h3>
    <ul class="timeline">
      ${[3, 5, 10].map(d => {
        const f = (a.followups || []).find(x => x.day === d);
        const due = a.appliedAt + d * 86400000;
        if (f) return `
          <li class="sent">
            <div class="t-head">Day ${d} follow-up — done ✓ (on platform)</div>
            <div class="t-sub">${timeAgo(f.sentAt)}</div>
          </li>`;
        if (fuStopped) return `
          <li><div class="t-head">Day ${d} follow-up — cancelled</div>
          <div class="t-sub">${a.replied ? 'they replied' : 'application closed'}</div></li>`;
        if (Date.now() >= due) return `
          <li>
            <div class="t-head" style="color:var(--amber)">Day ${d} follow-up — DUE ⏰</div>
            <div class="t-sub">Follow up on the platform (or message the recruiter), then
              <button class="btn btn-green btn-sm fu-done-btn" data-day="${d}" style="margin-left:6px">✓ Mark done</button>
            </div>
          </li>`;
        return `
          <li><div class="t-head">Day ${d} follow-up — scheduled</div>
          <div class="t-sub">due ${new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} (you'll see a reminder here and in Activity)</div></li>`;
      }).join('')}
    </ul>
    <p style="font-size:12px;color:var(--muted)">💡 Got an email from the company (confirmation, recruiter reply)? Paste the sender's address into
    "Recruiter email" above — remaining follow-ups and reply tracking switch to automatic email.</p>` : a.appliedAt ? `
    <h3>Follow-up schedule (auto: day 3, 5, 10)</h3>
    <ul class="timeline">
      ${[3, 5, 10].map(d => {
        const f = (a.followups || []).find(x => x.day === d);
        const due = new Date(a.appliedAt + d * 86400000);
        return f ? `
          <li class="sent">
            <div class="t-head">Day ${d} follow-up — sent ✓</div>
            <div class="t-sub">${timeAgo(f.sentAt)}${f.simulated ? ' (simulated)' : ` → ${esc(f.to)}`}</div>
            <details><summary>View email</summary><pre class="doc">Subject: ${esc(f.email.subject)}\n\n${esc(f.email.body)}</pre></details>
          </li>` : `
          <li>
            <div class="t-head">Day ${d} follow-up — ${a.replied || ['replied','interview','offer','rejected','closed'].includes(a.status) ? 'cancelled' : 'scheduled'}</div>
            <div class="t-sub">${a.replied ? 'stopped — they replied' : `due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} (sent automatically, or click Sync)`}</div>
          </li>`;
      }).join('')}
    </ul>` : '';

  $('#drawerContent').innerHTML = `
    <h2>${esc(a.title)}</h2>
    <div class="sub">${esc(a.company)} · ${esc(a.location)} · via ${esc(a.source)}
      ${a.url ? `· <a href="${esc(a.url)}" target="_blank" style="color:var(--accent)">view posting ↗</a>` : ''}</div>

    <div class="match-panel">
      <strong>Match score: ${a.matchScore}%</strong> · stage: ${stageOf(a).replace('_', ' ')}
      ${a.replied ? ` · <span style="color:var(--green)">replied ⭐</span>` : ''}
      <ul>${(a.matchReasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>

    <div class="recipient-row">
      <span style="font-size:12.5px;color:var(--muted);white-space:nowrap">Recruiter email:</span>
      <input type="email" id="recipientInput" placeholder="${a.status === 'action' || (!a.recipientEmail && !a.appliedAt) ? 'none found in posting — paste one to switch to email apply' : 'recruiter@company.com'}"
        value="${esc(a.recipientEmail || '')}">
    </div>
    ${a.recruiterName ? `<div style="font-size:12px;color:var(--muted);margin:-6px 0 8px">Hiring contact: ${esc(a.recruiterName)}${a.recruiterUrl ? ` · <a href="${esc(a.recruiterUrl)}" target="_blank" style="color:var(--accent)">LinkedIn ↗</a>` : ''}</div>` : ''}

    ${a.status === 'action' && t ? `
      <div class="action-box">
        <strong>✋ Your action needed</strong> — this posting has no recruiter email, so apply on the platform yourself.
        The tailored CV &amp; message below are ready to copy in.
        <div class="fix-row" style="margin-top:8px">
          ${a.url ? `<a class="btn btn-primary btn-sm" href="${esc(a.url)}" target="_blank">Open posting &amp; apply ↗</a>` : ''}
          <a class="btn btn-ghost btn-sm" href="/api/applications/${esc(a.id)}/cv.pdf" title="Saved to Downloads with the company & role in the filename">⬇ Download CV (PDF)</a>
          <button class="btn btn-ghost btn-sm" id="copyCvBtn">📋 Copy CV text</button>
          <button class="btn btn-ghost btn-sm" id="copyEmailBtn">📋 Copy message</button>
          <button class="btn btn-green btn-sm" id="confirmAppliedBtn">✓ I applied — start tracking</button>
        </div>
      </div>` : ''}

    ${a.qualityCheck && a.qualityCheck.checked && !a.qualityCheck.ok ? `
      <div style="font-size:12px;color:var(--amber);margin:0 0 8px">
        ⚠ Fact-check corrected this draft: ${esc((a.qualityCheck.problems || []).slice(0, 3).join('; '))}
      </div>` : ''}

    <div class="drawer-actions">
      ${!t ? `<button class="btn btn-primary" id="tailorBtn">⚡ Generate tailored CV &amp; email</button>`
           : `<button class="btn btn-ghost btn-sm" id="tailorBtn">↻ Regenerate</button>`}
      ${t && a.status !== 'action' ? `<a class="btn btn-ghost btn-sm" href="/api/applications/${esc(a.id)}/cv.pdf">⬇ CV PDF</a>` : ''}
      ${t && !a.applicationSent && a.status !== 'action' ? `<button class="btn btn-green" id="applyBtn">📧 Send application (CV attached as PDF)</button>` : ''}
      ${a.applicationSent ? `<span class="tag done" style="align-self:center">${a.applicationSent.manual ? 'Applied on platform ✋' : 'Sent'} ${timeAgo(a.applicationSent.at)}${a.applicationSent.manual ? '' : a.applicationSent.simulated ? ' (simulated)' : ' → ' + esc(a.applicationSent.to)}</span>` : ''}
      ${!['rejected', 'closed'].includes(a.status) ? `<button class="btn btn-ghost btn-sm" id="rejectBtn" style="color:var(--red)">Mark rejected</button>` : ''}
      <button class="btn btn-ghost btn-sm" id="deleteBtn" style="margin-left:auto;color:var(--red)">Remove</button>
    </div>

    ${t ? `
      <div class="review-box">
        <strong>Review — not happy with this draft?</strong>
        <div class="fix-row">
          <input type="text" id="fixInput" placeholder='e.g. "make the email shorter", "emphasize my fintech work", "drop the salary line"'>
          <button class="btn btn-primary btn-sm" id="fixBtn">✏️ Ask AI to fix</button>
        </div>
        <small>The AI rewrites this CV &amp; email with your change. Repeat until you're happy, then Send.</small>
      </div>
      <h3>Application email</h3>
      <pre class="doc">Subject: ${esc(t.email_subject)}\n\n${esc(t.email_body)}</pre>
      <h3>Tailored ATS CV ${t.keywords_used?.length ? `<span style="text-transform:none;letter-spacing:0">— keywords: ${esc(t.keywords_used.slice(0, 6).join(', '))}</span>` : ''}</h3>
      <pre class="doc">${esc(t.cv)}</pre>
      <div style="margin-top:8px">
        <a class="btn btn-ghost btn-sm" href="/api/applications/${esc(a.id)}/cv.pdf">⬇ Download this CV as PDF</a>
      </div>` : ''}

    ${followupHtml}

    <h3>Job description</h3>
    <div class="jd">${esc(a.description)}</div>
  `;

  $('#recipientInput')?.addEventListener('change', async e => {
    try {
      await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { recipientEmail: e.target.value } });
      toast('Recruiter email saved');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  $('#tailorBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Generating…';
    try {
      await api(`/api/applications/${a.id}/tailor`, { method: 'POST' });
      toast('Tailored CV & email generated');
      await refresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = '⚡ Generate tailored CV & email'; }
  });

  async function runFix() {
    const feedback = $('#fixInput').value.trim();
    if (!feedback) return toast('Type what to change first', true);
    const btn = $('#fixBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Fixing…';
    try {
      await api(`/api/applications/${a.id}/tailor`, { method: 'POST', body: { feedback } });
      toast('Revised — review the updated draft above');
      await refresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = '✏️ Ask AI to fix'; }
  }
  $('#fixBtn')?.addEventListener('click', runFix);
  $('#fixInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runFix(); });

  $('#applyBtn')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    const recipient = $('#recipientInput').value.trim();
    if (recipient && !confirm(`Send this application email for real to ${recipient}?`)) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Sending…';
    try {
      if (recipient !== (a.recipientEmail || '')) {
        await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { recipientEmail: recipient } });
      }
      const res = await api(`/api/applications/${a.id}/apply`, { method: 'POST' });
      toast(res.simulated
        ? 'Application sent (simulated) — follow-ups scheduled for day 3, 5, 10'
        : `Application emailed to ${recipient} — follow-ups scheduled for day 3, 5, 10`);
      await refresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = '📧 Send application'; }
  });

  // "Your action" column: copy the tailored docs, confirm once applied
  const copyToClipboard = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`${label} copied — paste it into the application form`); }
    catch { toast('Copy failed — select the text below and copy manually', true); }
  };
  $('#copyCvBtn')?.addEventListener('click', () => copyToClipboard(t.cv, 'CV'));
  $('#copyEmailBtn')?.addEventListener('click', () => copyToClipboard(t.email_body, 'Message'));
  $('#confirmAppliedBtn')?.addEventListener('click', async () => {
    if (!confirm(`Confirm you applied to ${a.title} at ${a.company} on the platform? It moves to Applied and gets tracked.`)) return;
    try {
      await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { manualApplied: true } });
      toast('Marked as applied — now tracked on the board ✓');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  // manual follow-up reminders: "✓ Mark done" per due day
  document.querySelectorAll('.fu-done-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/applications/${a.id}/followup-done`, { method: 'POST', body: { day: Number(btn.dataset.day) } });
        toast(`Day-${btn.dataset.day} follow-up recorded ✓`);
        await refresh();
      } catch (err) { toast(err.message, true); }
    });
  });

  $('#rejectBtn')?.addEventListener('click', async () => {
    await api(`/api/applications/${a.id}`, { method: 'PATCH', body: { status: 'rejected' } });
    toast('Marked rejected');
    refresh();
  });

  $('#deleteBtn')?.addEventListener('click', async () => {
    await api(`/api/applications/${a.id}`, { method: 'DELETE' });
    closeDrawer();
    refresh();
  });
}

// ---------- Feedback / mode / target ----------

$('#feedbackBtn').addEventListener('click', async () => {
  const text = $('#feedbackInput').value.trim();
  if (!text) return toast('Type an instruction first', true);
  const kind = $('#feedbackKind').value;
  try {
    await api('/api/feedback', { method: 'POST', body: { text, kind } });
    $('#feedbackInput').value = '';
    const label = { find: 'job finding', cv: 'CV writing', email: 'email writing' }[kind];
    toast(`Saved to your ${label} instructions — the AI follows it from now on.`);
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#modeSelect').addEventListener('change', async e => {
  const mode = e.target.value;
  if (mode === 'auto' && !confirm('Auto mode fetches, generates AND sends applications without review, on the discovery schedule. Real emails go out if Gmail + recipient emails are set. Continue?')) {
    e.target.value = 'manual';
    return;
  }
  await api('/api/settings', { method: 'POST', body: { mode } });
  toast(mode === 'auto' ? 'Autopilot ON — full cycle runs automatically; you get a report email after each run' : 'Manual mode — the big button walks you through each step');
  refresh();
});


// ---------- Filters ----------

$('#stageFilter').addEventListener('change', e => { filters.stage = e.target.value; renderBoard(); });
$('#dateFrom').addEventListener('change', e => { filters.from = e.target.value; renderBoard(); });
$('#dateTo').addEventListener('change', e => { filters.to = e.target.value; renderBoard(); });
$('#clearFilters').addEventListener('click', () => {
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
  let downOnBackdrop = false;
  el.addEventListener('mousedown', e => { downOnBackdrop = e.target.id === overlayId; });
  el.addEventListener('click', e => {
    if (downOnBackdrop && e.target.id === overlayId) close();
    downOnBackdrop = false;
  });
}

$('#reportBtn').addEventListener('click', () => openReports().catch(err => toast(err.message, true)));
$('#reportClose').addEventListener('click', () => $('#reportOverlay').classList.add('hidden'));
bindOverlayClose('reportOverlay', () => $('#reportOverlay').classList.add('hidden'));

$('#reportRunBtn').addEventListener('click', async e => {
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

// ---------- Profile editor (friendly form, no JSON) ----------

let editingProfile = null; // keeps fields the form doesn't show

function openProfileEditor(profile) {
  editingProfile = profile || {};
  $('#pfName').value = profile.name || '';
  $('#pfEmail').value = profile.email || '';
  $('#pfTitle').value = profile.title || '';
  $('#pfYears').value = profile.years_experience ?? '';
  $('#pfSkills').value = (profile.skills || []).join(', ');
  $('#pfRoles').value = (profile.target_roles || []).join(', ');
  $('#pfSummary').value = profile.summary || '';
  $('#pfAchievements').value = (profile.top_achievements || []).join('\n');
  $('#profileOverlay').classList.remove('hidden');
}

$('#profileClose').addEventListener('click', () => $('#profileOverlay').classList.add('hidden'));
bindOverlayClose('profileOverlay', () => $('#profileOverlay').classList.add('hidden'));

const splitList = (v, sep) => v.split(sep).map(x => x.trim()).filter(Boolean);

$('#profileSave').addEventListener('click', async () => {
  const profile = {
    ...editingProfile, // preserve anything the AI extracted that the form doesn't show
    name: $('#pfName').value.trim(),
    email: $('#pfEmail').value.trim(),
    title: $('#pfTitle').value.trim(),
    years_experience: Number($('#pfYears').value) || 0,
    skills: splitList($('#pfSkills').value, ','),
    target_roles: splitList($('#pfRoles').value, ','),
    summary: $('#pfSummary').value.trim(),
    top_achievements: splitList($('#pfAchievements').value, '\n')
  };
  if (!profile.name) return toast('Please fill in your name', true);
  try {
    await api('/api/profile', { method: 'PUT', body: { profile } });
    toast('Profile saved');
    $('#profileOverlay').classList.add('hidden');
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ---------- Collapsible sidebar ----------

function applyNavState() {
  document.body.classList.toggle('nav-collapsed', localStorage.getItem('jp_nav') === 'closed');
}
$('#navToggle').addEventListener('click', () => {
  localStorage.setItem('jp_nav', document.body.classList.contains('nav-collapsed') ? 'open' : 'closed');
  applyNavState();
});
applyNavState();

// ---------- Settings modal ----------

const MODEL_HINTS = {
  groq: 'Groq defaults: llama-3.3-70b-versatile. Others: llama-3.1-8b-instant (faster).',
  openai: 'OpenAI defaults: gpt-4o-mini. Others: gpt-4o, gpt-4.1-mini.',
  anthropic: 'Anthropic defaults: claude-haiku-4-5-20251001 (budget). Best results: claude-sonnet-5.'
};

async function openSettings(welcome = false) {
  const s = await api('/api/settings');
  $('#welcomeBox').classList.toggle('hidden', !welcome);
  $('#settingsTitle').textContent = welcome ? 'Set up JobPilot' : 'Settings';
  $('#dataDirPath').textContent = s.dataDir;
  $('#srcRemotive').checked = s.sources.remotive;
  $('#srcLinkedin').checked = s.sources.linkedin;
  $('#srcNaukri').checked = s.sources.naukri;
  $('#setApifyToken').value = '';
  $('#setApifyToken').placeholder = s.apifyTokenSet ? `configured ✓ (${s.apifyTokenMasked}) — paste to replace` : 'apify_api_…';
  $('#setAtsCompanies').value = s.atsCompanies || '';
  $('#setAdzunaAppId').value = s.adzunaAppId || '';
  $('#setAdzunaAppKey').value = '';
  $('#setAdzunaAppKey').placeholder = s.adzunaKeySet ? 'configured ✓ — paste to replace' : 'your Adzuna app key';
  $('#setAdzunaCountry').value = s.adzunaCountry || 'in';
  $('#setAutoMinScore').value = s.autoMinScore;
  $('#setFactCheck').checked = s.factCheck;
  $('#setCooldown').value = s.companyCooldownDays;
  $('#setJobTitles').value = (s.jobTitles || []).join(', ');
  $('#setJobLocations').value = (s.jobLocations || []).join(', ');
  $('#setRemoteOk').checked = s.remoteOk;
  $('#setMaxAge').value = s.maxJobAgeDays;
  $('#setLowComp').checked = s.preferLowCompetition;
  $('#setProvider').value = s.provider;
  $('#setModel').value = s.model;
  $('#setModel').placeholder = s.activeModel;
  $('#modelHint').textContent = MODEL_HINTS[s.provider];
  $('#setGroqKey').value = '';
  $('#setGroqKey').placeholder = s.groqKeySet ? `configured ✓ (${s.groqKeyMasked}) — paste to replace` : 'gsk_…';
  $('#setOpenaiKey').value = '';
  $('#setOpenaiKey').placeholder = s.openaiKeySet ? `configured ✓ (${s.openaiKeyMasked}) — paste to replace` : 'sk-…';
  $('#setAnthropicKey').value = '';
  $('#setAnthropicKey').placeholder = s.anthropicKeySet ? `configured ✓ (${s.anthropicKeyMasked}) — paste to replace` : 'sk-ant-…';
  $('#setPromptFind').value = s.promptFind;
  $('#setPromptCV').value = s.promptCV;
  $('#setPromptEmail').value = s.promptEmail;
  $('#setAutoSearch').checked = s.autoSearch;
  $('#setAutoSearchHours').value = s.autoSearchHours;
  $('#setDailyTarget').value = s.dailyTarget;
  $('#setInsightsEnabled').checked = s.insightsEnabled;
  $('#setInsightsEvery').value = s.insightsEvery;
  $('#setInsightsEmail').value = s.insightsEmail;
  $('#setDevFeedback').checked = s.devFeedbackEnabled;
  $('#setFromName').value = s.fromName;
  $('#setSmtpUser').value = s.smtpUser;
  $('#setSmtpPass').value = '';
  $('#setSmtpPass').placeholder = s.smtpConfigured ? 'configured ✓ — paste to replace' : '16-character app password';
  $('#settingsOverlay').classList.remove('hidden');
}

$('#setProvider').addEventListener('change', e => { $('#modelHint').textContent = MODEL_HINTS[e.target.value]; });
$('#settingsBtn').addEventListener('click', () => openSettings());
$('#settingsClose').addEventListener('click', () => $('#settingsOverlay').classList.add('hidden'));
bindOverlayClose('settingsOverlay', () => $('#settingsOverlay').classList.add('hidden'));

$('#settingsSave').addEventListener('click', async () => {
  try {
    if (($('#srcLinkedin').checked || $('#srcNaukri').checked) && !state.settings?.apifyTokenSet && !$('#setApifyToken').value.trim()) {
      return toast(`${$('#srcLinkedin').checked ? 'LinkedIn' : 'Naukri'} needs an Apify token — see the steps under the LinkedIn checkbox`, true);
    }
    await api('/api/settings', { method: 'POST', body: {
      provider: $('#setProvider').value,
      model: $('#setModel').value,
      groqKey: $('#setGroqKey').value,
      openaiKey: $('#setOpenaiKey').value,
      anthropicKey: $('#setAnthropicKey').value,
      promptFind: $('#setPromptFind').value,
      promptCV: $('#setPromptCV').value,
      promptEmail: $('#setPromptEmail').value,
      fromName: $('#setFromName').value,
      smtpUser: $('#setSmtpUser').value,
      smtpPass: $('#setSmtpPass').value,
      autoSearch: $('#setAutoSearch').checked,
      autoSearchHours: $('#setAutoSearchHours').value,
      dailyTarget: $('#setDailyTarget').value,
      insightsEnabled: $('#setInsightsEnabled').checked,
      insightsEvery: $('#setInsightsEvery').value,
      insightsEmail: $('#setInsightsEmail').value,
      devFeedbackEnabled: $('#setDevFeedback').checked,
      sources: {
        remotive: $('#srcRemotive').checked,
        linkedin: $('#srcLinkedin').checked,
        naukri: $('#srcNaukri').checked
      },
      apifyToken: $('#setApifyToken').value,
      atsCompanies: $('#setAtsCompanies').value,
      adzunaAppId: $('#setAdzunaAppId').value,
      adzunaAppKey: $('#setAdzunaAppKey').value,
      adzunaCountry: $('#setAdzunaCountry').value,
      autoMinScore: $('#setAutoMinScore').value,
      factCheck: $('#setFactCheck').checked,
      companyCooldownDays: $('#setCooldown').value,
      jobTitles: $('#setJobTitles').value,
      jobLocations: $('#setJobLocations').value,
      remoteOk: $('#setRemoteOk').checked,
      maxJobAgeDays: $('#setMaxAge').value,
      preferLowCompetition: $('#setLowComp').checked
    }});
    toast('Settings saved');
    $('#settingsOverlay').classList.add('hidden');
    refresh();
  } catch (err) { toast(err.message, true); }
});

$('#testEmailBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Sending…';
  try {
    const res = await api('/api/settings/test-email', { method: 'POST' });
    toast(`Test email sent to ${res.to} ✓ — check your inbox`);
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = 'Send test email to myself';
});

// ---------- Misc wiring ----------

$('#drawerClose').addEventListener('click', closeDrawer);
bindOverlayClose('drawerOverlay', closeDrawer);

$('#cvInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  toast('Uploading CV & extracting profile…');
  const fd = new FormData();
  fd.append('cv', file);
  try {
    const res = await fetch('/api/cv', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`Profile extracted — ${data.profile.skills.length} skills found`);
    $('#profileOverlay').classList.add('hidden');
    refresh();
  } catch (err) { toast(err.message, true); }
  e.target.value = '';
});

$('#searchBtn').addEventListener('click', doSearch);
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const btn = $('#searchBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const q = $('#searchInput').value.trim();
    const res = await api('/api/jobs/search', { method: 'POST', body: { query: q } });
    if (!res.added && res.note) {
      toast(res.note, true); // nothing found — show the actual cause, not a shrug
    } else {
      toast(`Found ${res.added} new good matches via ${res.source} for "${res.query}"${res.skipped ? ` (${res.skipped} filtered out)` : ''}`);
    }
    refresh();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = 'Search';
}

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Reset ALL data for the current profile (CV, jobs, applications, reports)?')) return;
  await api('/api/demo/reset', { method: 'POST' });
  location.reload();
});

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

// First run: no data found → walk the user straight into setup
(async () => {
  await refresh();
  if (state.settings?.firstRun && !sessionStorage.getItem('jp_welcomed')) {
    sessionStorage.setItem('jp_welcomed', '1');
    openSettings(true);
  }
  scheduleRefresh();
})();

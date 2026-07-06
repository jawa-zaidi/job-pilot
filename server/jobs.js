// Job sources, user-selectable in Settings → Job sources.
// - Remotive: free public API, on by default, no key needed.
// - LinkedIn via Apify: activates when the user pastes an Apify token (beta).
// - Naukri: coming soon (Apify scraper or Playwright).
const crypto = require('crypto');
const { load, logActivity } = require('./db');

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fallback jobs so the demo works even offline.
const SAMPLE_JOBS = [
  { title: 'Senior Frontend Engineer', company: 'Nova Labs', location: 'Remote', url: 'https://example.com/jobs/1',
    description: 'We need a React + TypeScript engineer to build our fintech dashboard. Experience with Node.js, GraphQL and testing required. You will own features end to end and work with designers.' },
  { title: 'Full Stack Developer', company: 'Brightpath', location: 'Remote (EU)', url: 'https://example.com/jobs/2',
    description: 'Full stack role: Node.js, Express, React, PostgreSQL, AWS. You will build APIs and dashboards for our logistics platform. 3+ years experience.' },
  { title: 'Product Engineer', company: 'Loopwork', location: 'Remote', url: 'https://example.com/jobs/3',
    description: 'Product-minded engineer comfortable across the stack (JavaScript, Python). Ship fast, talk to users, own outcomes. Startup experience a plus.' },
  { title: 'Backend Engineer (Python)', company: 'DataForge', location: 'Remote (Worldwide)', url: 'https://example.com/jobs/4',
    description: 'Python, Django, SQL, data pipelines. Build the backend powering our analytics product. Docker and AWS experience valued.' },
  { title: 'Mobile Developer', company: 'Swiftly', location: 'Remote', url: 'https://example.com/jobs/5',
    description: 'Flutter or React Native developer for our consumer app. Ship polished mobile experiences with a small team.' }
];

function sourcesConfig() {
  const s = load().settings || {};
  return {
    remotive: s.sources?.remotive !== false, // on by default
    linkedin: !!s.sources?.linkedin,
    naukri: !!s.sources?.naukri,
    apifyToken: s.apifyToken || ''
  };
}

// User preferences that make "find jobs" smart: where they can work, how fresh
// a posting must be, and whether to favor low-competition roles.
function jobPrefs() {
  const s = load().settings || {};
  let locations = s.jobLocations;
  if (!Array.isArray(locations)) locations = s.jobLocation ? [s.jobLocation] : []; // migrate old single value
  locations = locations.map(l => String(l).trim()).filter(Boolean);
  return {
    locations,
    remoteOk: s.remoteOk !== false,                 // treat remote/worldwide as acceptable (default yes)
    maxAgeDays: Math.max(1, Number(s.maxJobAgeDays) || 30),
    preferLowComp: !!s.preferLowCompetition
  };
}

function jobAgeDays(job) {
  if (!job.publishedAt) return null;
  const t = new Date(job.publishedAt).getTime();
  if (isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
}

function isRecent(job, maxAgeDays) {
  const age = jobAgeDays(job);
  return age == null ? true : age <= maxAgeDays; // unknown date → keep (don't over-filter)
}

// Does a job's location satisfy the user's preferred locations?
function matchesLocation(job, prefs) {
  if (!prefs.locations.length) return true; // no preference set → accept everything
  const loc = (job.location || '').toLowerCase();
  const remoteish = /remote|worldwide|anywhere|distributed/.test(loc) || loc === '';
  if (prefs.remoteOk && remoteish) return true;
  return prefs.locations.some(l => {
    const p = l.toLowerCase();
    if (p === 'remote') return remoteish;
    return loc.includes(p);
  });
}

// Newest first, then apply recency + location filters
function refine(jobs, prefs) {
  return jobs
    .filter(j => isRecent(j, prefs.maxAgeDays) && matchesLocation(j, prefs))
    .sort((a, b) => {
      const da = new Date(a.publishedAt || 0).getTime() || 0;
      const db = new Date(b.publishedAt || 0).getTime() || 0;
      return db - da;
    });
}

// Rank a board's feed against the query ourselves — some free boards ignore
// or poorly support their own search parameter.
function keywordFilter(jobs, query, limit) {
  const words = String(query).toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return jobs.slice(0, limit);
  const scored = jobs.map(j => {
    const title = (j.title || '').toLowerCase();
    const desc = (j.description || '').toLowerCase();
    let hits = 0;
    for (const w of words) {
      if (title.includes(w)) hits += 3;
      else if (desc.includes(w)) hits += 1;
    }
    return { j, hits };
  }).filter(x => x.hits > 0);
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, limit).map(x => x.j);
}

async function searchRemotive(query, limit = 12) {
  // NOTE: Remotive's `search` param currently ignores the query and returns
  // the same latest feed — so we pull the feed and keyword-filter locally.
  const url = `https://remotive.com/api/remote-jobs?limit=50`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Remotive API ${res.status}`);
  const data = await res.json();
  const all = (data.jobs || []).map(j => ({
    id: `remotive-${j.id}`,
    source: 'Remotive',
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || 'Remote',
    url: j.url,
    salary: j.salary || '',
    publishedAt: j.publication_date,
    description: stripHtml(j.description).slice(0, 5000)
  }));
  return keywordFilter(all, query, limit);
}

// RemoteOK — free public feed, no key (first array element is a legal notice)
async function searchRemoteOK(query, limit = 12) {
  const res = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'JobPilot' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`RemoteOK API ${res.status}`);
  const data = await res.json();
  const all = (Array.isArray(data) ? data : []).filter(j => j && j.position).map(j => ({
    id: `remoteok-${j.id || j.slug}`,
    source: 'RemoteOK',
    title: j.position,
    company: j.company || 'Unknown',
    location: j.location || 'Remote',
    url: j.url || (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : ''),
    salary: j.salary_min ? `$${j.salary_min}–${j.salary_max || '?'}` : '',
    publishedAt: j.date || '',
    description: stripHtml(j.description || (j.tags || []).join(', ')).slice(0, 5000)
  }));
  return keywordFilter(all, query, limit);
}

// Arbeitnow — free public job board API, no key
async function searchArbeitnow(query, limit = 12) {
  const res = await fetch('https://www.arbeitnow.com/api/job-board-api', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Arbeitnow API ${res.status}`);
  const data = await res.json();
  const all = (data.data || []).map(j => ({
    id: `arbeitnow-${j.slug}`,
    source: 'Arbeitnow',
    title: j.title,
    company: j.company_name,
    location: (j.remote ? 'Remote · ' : '') + (j.location || ''),
    url: j.url,
    salary: '',
    publishedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : '',
    description: stripHtml(j.description).slice(0, 5000)
  }));
  return keywordFilter(all, query, limit);
}

// LinkedIn via Apify's harvestapi/linkedin-job-search actor (pay-per-event —
// works on Apify's free monthly credit, but needs a one-time permission
// approval in the user's Apify console).
let linkedinPausedUntil = 0; // don't retry every query after a hard failure

async function searchLinkedInApify(query, limit, token) {
  if (Date.now() < linkedinPausedUntil) throw new Error('LinkedIn paused after a recent error (retries soon)');
  const url = `https://api.apify.com/v2/acts/harvestapi~linkedin-job-search/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=120`;
  const prefs = jobPrefs();
  // LinkedIn ignores "Remote" as a location string, so pass only real places
  const locs = prefs.locations.filter(l => l.toLowerCase() !== 'remote');
  // freshest postings first, and only recent ones (fewer applicants already)
  const postedLimit = prefs.maxAgeDays <= 1 ? '24h' : prefs.maxAgeDays <= 7 ? 'week' : 'month';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobTitles: [query],
      maxItems: Math.min(limit, 25),
      sortBy: 'date',       // newest first — apply as soon as they're out
      postedLimit,          // restrict to recent postings
      ...(locs.length ? { locations: locs } : {}),
      ...(prefs.preferLowComp ? { under10Applicants: true } : {})
    }),
    signal: AbortSignal.timeout(150000)
  });
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    linkedinPausedUntil = Date.now() + 10 * 60 * 1000;
    let msg = `Apify LinkedIn error ${res.status}`;
    try {
      const e = JSON.parse(bodyText).error || {};
      if (e.type === 'full-permission-actor-not-approved') {
        msg = `LinkedIn needs one-time approval: open ${e.data?.approvalUrl || 'console.apify.com'} , click Approve, then search again`;
      } else if (e.type === 'actor-is-not-rented') {
        msg = 'This LinkedIn scraper needs to be rented on Apify — contact support or wait for an app update';
      } else if (e.message) {
        msg = `Apify LinkedIn: ${e.message.slice(0, 160)}`;
      }
    } catch { /* keep generic msg */ }
    throw new Error(msg);
  }
  const items = JSON.parse(bodyText);
  // harvestapi schema: title, company{name}, linkedinUrl, location{linkedinText},
  // salary{text}, postedDate, descriptionText, hiringTeam[]
  return (Array.isArray(items) ? items : []).slice(0, limit).map(j => ({
    id: `linkedin-${crypto.createHash('md5').update(String(j.linkedinUrl || j.id || String(j.title))).digest('hex').slice(0, 10)}`,
    source: 'LinkedIn',
    title: j.title || 'Untitled role',
    company: j.company?.name || 'Unknown',
    location: j.location?.linkedinText || '',
    url: j.linkedinUrl || '',
    salary: j.salary?.text || '',
    publishedAt: j.postedDate || '',
    description: stripHtml(j.descriptionText || '').slice(0, 5000)
  }));
}

function sampleJobs() {
  return SAMPLE_JOBS.map(j => ({
    id: `sample-${crypto.createHash('md5').update(j.title + j.company).digest('hex').slice(0, 8)}`,
    source: 'Sample (offline)',
    salary: '',
    publishedAt: new Date().toISOString(),
    ...j
  }));
}

async function searchJobs(query, limit = 10) {
  const cfg = sourcesConfig();
  const prefs = jobPrefs();
  const jobs = [];
  const used = [];
  let filtered = 0; // dropped for location/recency

  if (cfg.remotive) {
    // Free boards. Remotive/RemoteOK are remote/English; Arbeitnow is EU/Germany-
    // heavy, so we only query it when the user actually targets Europe (else it
    // floods results with German-language jobs). Pull extra since we filter hard.
    const wantsEurope = !prefs.locations.length ||
      prefs.locations.some(l => /germany|deutschland|berlin|munich|münchen|europe|eu|netherlands|amsterdam|remote/i.test(l));
    const boards = [
      ['Remotive', searchRemotive],
      ['RemoteOK', searchRemoteOK],
      ...(wantsEurope ? [['Arbeitnow', searchArbeitnow]] : [])
    ];
    const results = await Promise.allSettled(boards.map(([, fn]) => fn(query, limit * 2)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const refined = refine(r.value, prefs);
        filtered += r.value.length - refined.length;
        jobs.push(...refined.slice(0, limit));
        if (refined.length) used.push(boards[i][0]);
      } else {
        console.error(`${boards[i][0]} fetch failed:`, r.reason.message);
      }
    });
  }
  if (cfg.linkedin && cfg.apifyToken) {
    try {
      const li = await searchLinkedInApify(query, limit, cfg.apifyToken);
      try { require('./costs').recordSource('LinkedIn', li.length); } catch { /* best-effort */ }
      // LinkedIn already filtered by location/date server-side; recency safety only
      const refined = li.filter(j => isRecent(j, prefs.maxAgeDays));
      filtered += li.length - refined.length;
      jobs.push(...refined);
      if (refined.length) used.push('LinkedIn');
    } catch (err) {
      console.error('LinkedIn (Apify) fetch failed:', err.message);
      if (err.message.includes('approval') || err.message.includes('rented')) {
        const db = load();
        const recent = (db.activity || []).slice(0, 20).some(a => a.text.includes('LinkedIn needs') || a.text.includes('LinkedIn scraper'));
        if (!recent) logActivity(`⚠️ ${err.message}`, 'error');
      }
    }
  }
  // Naukri: not implemented yet (no official API; Apify scraper or Playwright next)

  if (!jobs.length) {
    // Don't fall back to sample jobs when the user has real filters — an empty
    // result is honest ("nothing fresh in your locations"); sample jobs mislead.
    if (prefs.locations.length || used.length) return { jobs: [], source: used.join(' + ') || 'no sources', filtered };
    return { jobs: sampleJobs(), source: 'Sample (offline fallback)', filtered };
  }
  // dedupe by title+company across sources, newest first
  const seen = new Set();
  const unique = jobs.filter(j => {
    const k = `${j.title}|${j.company}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (new Date(b.publishedAt || 0).getTime() || 0) - (new Date(a.publishedAt || 0).getTime() || 0));
  return { jobs: unique, source: used.join(' + '), filtered };
}

module.exports = { searchJobs, sourcesConfig, jobPrefs };

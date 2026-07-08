// Job sources, user-selectable in Settings → Job sources.
// - Free boards (Remotive/RemoteOK/Arbeitnow): on by default, no key needed.
// - Career pages (ATS public APIs): activates when company boards are listed.
// - Adzuna: activates when the user adds free API credentials.
// - LinkedIn & Naukri via Apify: activate with an Apify token (beta).
const crypto = require('crypto');
const { load, logActivity } = require('./db');
const ats = require('./sources/ats');
const adzuna = require('./sources/adzuna');
const naukri = require('./sources/naukri');

// ---------- Canonical job identity ----------
// The same opening shows up on several boards with different IDs — dedup and
// "already applied" checks key on normalized company+title, not source IDs.

const COMPANY_SUFFIXES = /\b(inc|ltd|llc|llp|pvt|private|limited|corp|corporation|co|gmbh|technologies|technology|labs|solutions)\b\.?/g;

function normCompany(s) {
  return String(s || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')   // "(Remote)", "[Urgent]"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalKey(job) {
  return `${normCompany(job.company)}|${normTitle(job.title)}`;
}

// ---------- Recruiter email extraction ----------
// Postings (and LinkedIn hiring posts) often carry a real contact address —
// the highest-quality apply path there is. Never pick no-reply machinery.

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const JUNK_EMAIL = /no-?reply|do-?not-?reply|donotreply|notifications?@|mailer-daemon|@example\.|@email\.|unsubscribe|privacy@|dpo@|legal@|compliance@|gdpr|abuse@|postmaster|webmaster|security@|support@|@sentry|@googlegroups/i;

// A recruiting inbox (careers@, jobs@, hr@, recruiting@, talent@, hiring@, …)
const ROLE_LOCAL = /^(careers?|jobs?|recruit(?:ing|ment|er)?|talent|hiring|hr|apply|applications?|joinus|hello-?jobs)(?:[.+_-]|$)/;
// A person's address: firstname.lastname@ / f.lastname@ (two alpha parts, one separator)
function isPersonalLocal(local) { return /^[a-z]+[._][a-z]{2,}$/.test(local); }

// Prefer a high-confidence address (a recruiting inbox, then a personal
// firstname.lastname@ address) over the first thing we see. Postings often
// carry an unrelated partner/agency/info@ address; mailing the wrong person
// hurts the job seeker, so a low-confidence generic address returns '' — the
// job then routes to the manual "Your action" path instead of a bad guess.
function extractRecruiterEmail(text) {
  const found = String(text || '').match(EMAIL_RE) || [];
  let personal = '';
  for (const raw of found) {
    const e = raw.replace(/^[.]+|[.]+$/g, '').toLowerCase();
    if (e.length > 60 || JUNK_EMAIL.test(e)) continue;
    const local = e.split('@')[0];
    if (ROLE_LOCAL.test(local)) return e;                    // best: a recruiting inbox, wins outright
    if (!personal && isPersonalLocal(local)) personal = e;   // fall back to a personal-looking address
  }
  return personal; // '' when only a low-confidence generic address was present
}

// Is this address a no-reply machine rather than a person we could write to?
function isJunkContact(email) {
  return !email || JUNK_EMAIL.test(String(email).toLowerCase());
}

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

function sourcesConfig() {
  const s = load().settings || {};
  return {
    remotive: s.sources?.remotive !== false, // on by default
    linkedin: !!s.sources?.linkedin,
    naukri: !!s.sources?.naukri,
    ats: ats.companySlugs().length > 0,      // on when company boards are listed
    adzuna: adzuna.isConfigured(),           // on when API credentials are set
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
  const titles = (Array.isArray(s.jobTitles) ? s.jobTitles : [])
    .map(t => String(t).trim()).filter(Boolean);
  return {
    titles,                                         // user-preferred job titles — searched first
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
  // A posting on the company's OWN ATS is live by definition — companies remove
  // filled roles from their careers page, and many keep genuinely open roles up
  // for months. The posted-in-last-N-days preference is an anti-stale filter
  // for job BOARDS (where dead listings linger), so career-page jobs are exempt.
  if (job.source === 'Career page') return true;
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
  const phrase = String(query).toLowerCase().trim();
  const words = phrase.split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return jobs.slice(0, limit);
  const scored = jobs.map(j => {
    const title = (j.title || '').toLowerCase();
    const desc = (j.description || '').toLowerCase();
    let hits = 0;
    // the exact query phrase in the title ("backend engineer" in "Senior
    // Backend Engineer") is the strongest relevance signal there is
    if (phrase.length > 3 && title.includes(phrase)) hits += 10;
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
  return (Array.isArray(items) ? items : []).slice(0, limit).map(j => {
    const recruiter = Array.isArray(j.hiringTeam) ? j.hiringTeam[0] : null; // often a real person
    return {
      id: `linkedin-${crypto.createHash('md5').update(String(j.linkedinUrl || j.id || String(j.title))).digest('hex').slice(0, 10)}`,
      source: 'LinkedIn',
      title: j.title || 'Untitled role',
      company: j.company?.name || 'Unknown',
      location: j.location?.linkedinText || '',
      url: j.linkedinUrl || '',
      salary: j.salary?.text || '',
      publishedAt: j.postedDate || '',
      description: stripHtml(j.descriptionText || '').slice(0, 5000),
      ...(recruiter ? {
        recruiterName: recruiter.name || recruiter.title || '',
        recruiterUrl: recruiter.url || recruiter.linkedinUrl || ''
      } : {})
    };
  });
}

// The ATS boards return every open role per company — fetch once per batch of
// queries, not once per query.
let atsCache = { at: 0, jobs: [] };
async function atsJobsCached() {
  if (Date.now() - atsCache.at < 10 * 60 * 1000) return atsCache.jobs;
  const { jobs, errors } = await ats.searchAts();
  for (const e of errors) {
    console.error('ATS board error:', e);
    // "no public board found" is the user's problem to fix (a big enterprise on
    // a custom careers site, or a typo in the slug) — tell them on the dashboard
    // instead of returning a silent zero. Logged once, not on every refetch.
    if (e.includes('no public board')) {
      const db = load();
      const already = (db.activity || []).slice(0, 30).some(a => a.text.includes(e));
      if (!already) logActivity(
        `⚠️ Career page "${e.split(':')[0]}" — no public job board found on Greenhouse/Lever/Ashby/SmartRecruiters/Recruitee/Workable. ` +
        'Large enterprises (Deloitte, Google, …) run custom career sites JobPilot can\'t read; this works best for startups & scale-ups. Check the spelling of the board name, or remove it in Settings.',
        'error');
    }
  }
  atsCache = { at: Date.now(), jobs };
  return jobs;
}

async function searchJobs(query, limit = 10) {
  const cfg = sourcesConfig();
  const prefs = jobPrefs();
  const jobs = [];
  const used = [];
  const problems = []; // why an enabled source produced nothing — surfaced to the user
  let filtered = 0; // dropped for location/recency

  // Career pages first — the highest-quality source we have
  if (cfg.ats) {
    try {
      const all = await atsJobsCached();
      const refined = refine(keywordFilter(all, query, limit * 2), prefs);
      filtered += Math.max(0, all.length - refined.length);
      jobs.push(...refined.slice(0, limit));
      if (refined.length) used.push('Career pages');
    } catch (err) {
      console.error('ATS fetch failed:', err.message);
      problems.push(`Career pages: ${err.message.slice(0, 80)}`);
    }
  }

  if (cfg.adzuna) {
    try {
      const az = await adzuna.searchAdzuna(query, {
        limit: limit * 2,
        maxAgeDays: prefs.maxAgeDays,
        location: prefs.locations[0] || ''
      });
      const refined = refine(az, prefs);
      filtered += az.length - refined.length;
      jobs.push(...refined.slice(0, limit));
      if (refined.length) used.push('Adzuna');
    } catch (err) {
      console.error('Adzuna fetch failed:', err.message);
      problems.push(`Adzuna: ${err.message.slice(0, 80)}`);
    }
  }

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
        problems.push(`${boards[i][0]}: ${r.reason.message.slice(0, 60)}`);
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
      problems.push(`LinkedIn: ${err.message.slice(0, 80)}`);
      if (err.message.includes('approval') || err.message.includes('rented')) {
        const db = load();
        const recent = (db.activity || []).slice(0, 20).some(a => a.text.includes('LinkedIn needs') || a.text.includes('LinkedIn scraper'));
        if (!recent) logActivity(`⚠️ ${err.message}`, 'error');
      }
    }
  }
  if (cfg.naukri && cfg.apifyToken) {
    try {
      const nk = await naukri.searchNaukri(query, { limit, location: prefs.locations[0] || '' });
      try { require('./costs').recordSource('Naukri', nk.length); } catch { /* best-effort */ }
      const refined = nk.filter(j => isRecent(j, prefs.maxAgeDays));
      filtered += nk.length - refined.length;
      jobs.push(...refined);
      if (refined.length) used.push('Naukri');
    } catch (err) {
      console.error('Naukri (Apify) fetch failed:', err.message);
      problems.push(`Naukri: ${err.message.slice(0, 80)}`);
      if (err.message.includes('approval') || err.message.includes('rented') || err.message.includes('token')) {
        const db = load();
        const recent = (db.activity || []).slice(0, 20).some(a => a.text.includes('Naukri scraper') || a.text.includes('Naukri needs'));
        if (!recent) logActivity(`⚠️ ${err.message}`, 'error');
      }
    }
  }

  // Enabled-but-unusable sources are a config problem the user must hear about
  if ((cfg.linkedin || cfg.naukri) && !cfg.apifyToken) {
    problems.push('LinkedIn/Naukri are ticked but no Apify token is set (Settings → Job sources)');
  }

  if (!jobs.length) {
    // An empty result is always explained — never padded with fake demo jobs.
    const enabledAny = cfg.remotive || cfg.ats || cfg.adzuna || cfg.linkedin || cfg.naukri;
    let note = '';
    if (!enabledAny) {
      note = 'No job sources are enabled — turn at least one on in Settings → 🔍 Job sources (the free boards need no key).';
    } else if (problems.length) {
      note = `Sources returned nothing — ${[...new Set(problems)].join('; ')}`;
    }
    return { jobs: [], source: used.join(' + ') || 'no sources', filtered, note };
  }
  // dedupe across sources on canonical company+title (career page beats
  // aggregator copy of the same role because ATS jobs are pushed first),
  // then newest first
  const seen = new Set();
  const unique = jobs.filter(j => {
    const k = canonicalKey(j);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (new Date(b.publishedAt || 0).getTime() || 0) - (new Date(a.publishedAt || 0).getTime() || 0));
  return { jobs: unique, source: used.join(' + '), filtered };
}

module.exports = { searchJobs, sourcesConfig, jobPrefs, canonicalKey, normCompany, extractRecruiterEmail, isJunkContact };

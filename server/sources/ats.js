// Career-page sources via public ATS JSON APIs — the highest-quality feed we
// have: no key, no scraping, near-zero ghost jobs (companies remove postings
// from their own ATS when filled), and the URL is the real application form.
//
// The user lists company board slugs in Settings ("stripe, openai, ramp");
// we probe Greenhouse / Lever / Ashby / SmartRecruiters / Recruitee / Workable
// for each slug once and cache which ATS answered so later runs hit only the
// right endpoint.
const { load, save } = require('../db');

const TIMEOUT = 15000;

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'JobPilot', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- Per-ATS fetchers: each returns [{title, company, location, url, publishedAt, description}] ----

async function greenhouse(slug) {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  return (data.jobs || []).map(j => ({
    externalId: `gh-${j.id}`,
    title: j.title,
    company: data.name || slug,
    location: j.location?.name || '',
    url: j.absolute_url,
    publishedAt: j.updated_at || j.first_published || '',
    description: stripHtml(j.content).slice(0, 5000)
  }));
}

async function lever(slug) {
  const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!Array.isArray(data)) throw new Error('unexpected response');
  return data.map(j => ({
    externalId: `lv-${j.id}`,
    title: j.text,
    company: slug,
    location: j.categories?.location || '',
    url: j.hostedUrl,
    publishedAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
    description: stripHtml(j.descriptionPlain || j.description).slice(0, 5000)
  }));
}

async function ashby(slug) {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
  return (data.jobs || []).filter(j => j.isListed !== false).map(j => ({
    externalId: `ab-${j.id}`,
    title: j.title,
    company: slug,
    location: [j.location, j.isRemote ? 'Remote' : ''].filter(Boolean).join(' · '),
    url: j.jobUrl || j.applyUrl || '',
    publishedAt: j.publishedAt || '',
    description: stripHtml(j.descriptionHtml || j.descriptionPlain || '').slice(0, 5000)
  }));
}

async function smartrecruiters(slug) {
  const data = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`);
  const items = data.content || [];
  // Descriptions live behind one more call each; only fetch a bounded number
  const out = [];
  for (const j of items.slice(0, 40)) {
    let description = '';
    try {
      const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${j.id}`);
      const sec = d.jobAd?.sections || {};
      description = stripHtml([sec.jobDescription?.text, sec.qualifications?.text].filter(Boolean).join(' ')).slice(0, 5000);
    } catch { /* keep listing without description */ }
    out.push({
      externalId: `sr-${j.id}`,
      title: j.name,
      company: j.company?.name || slug,
      location: [j.location?.city, j.location?.country].filter(Boolean).join(', '),
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${j.id}`,
      publishedAt: j.releasedDate || '',
      description
    });
  }
  return out;
}

// Recruitee — keyless public offers API per company subdomain
async function recruitee(slug) {
  const data = await getJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`);
  if (!Array.isArray(data.offers)) throw new Error('unexpected response');
  return data.offers.filter(j => !j.status || j.status === 'published').map(j => ({
    externalId: `rc-${j.id}`,
    title: j.title,
    company: j.company_name || slug,
    location: [j.city, j.country].filter(Boolean).join(', ') || j.location || '',
    url: j.careers_url || j.url || '',
    publishedAt: j.published_at || j.created_at || '',
    description: stripHtml([j.description, j.requirements].filter(Boolean).join(' ')).slice(0, 5000)
  }));
}

// Workable — keyless public widget API per account slug (details=true adds descriptions)
async function workable(slug) {
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`);
  if (!Array.isArray(data.jobs)) throw new Error('unexpected response');
  return data.jobs.map(j => ({
    externalId: `wk-${j.shortcode || j.code || j.id}`,
    title: j.title,
    company: data.name || slug,
    location: [j.city, j.state, j.country].filter(Boolean).join(', '),
    url: j.url || j.application_url || '',
    publishedAt: j.published_on || j.created_at || '',
    description: stripHtml([j.description, j.requirements].filter(Boolean).join(' ')).slice(0, 5000)
  }));
}

const ATS_PROBES = [
  ['greenhouse', greenhouse],
  ['lever', lever],
  ['ashby', ashby],
  ['smartrecruiters', smartrecruiters],
  ['recruitee', recruitee],
  ['workable', workable]
];

// Which ATS hosts this slug? Probe each once, remember the answer.
// A probe only counts as a match when it returns actual jobs: SmartRecruiters
// answers 200 with an empty list for ANY slug (even garbage), and Workable has
// parked/empty accounts under common brand names — "board exists but 0 jobs"
// is indistinguishable from "wrong company", so it must not win the detection.
async function detectAts(slug) {
  const db = load();
  db.settings.atsDetected = db.settings.atsDetected || {};
  const cached = db.settings.atsDetected[slug];
  // Found boards re-verify weekly; misses retry daily — a transient network
  // failure at probe time (or a board that goes live later) must not disable
  // the company forever.
  const maxAge = cached && cached.ats ? 7 * 86400000 : 86400000;
  if (cached && Date.now() - (cached.at || 0) < maxAge) return cached;
  for (const [name, fn] of ATS_PROBES) {
    try {
      const items = await fn(slug);
      if (!Array.isArray(items) || !items.length) continue; // empty ≠ proof — try the next ATS
      db.settings.atsDetected[slug] = { ats: name, at: Date.now() };
      save();
      return db.settings.atsDetected[slug];
    } catch { /* not this ATS — try the next */ }
  }
  db.settings.atsDetected[slug] = { ats: null, at: Date.now() };
  save();
  return db.settings.atsDetected[slug];
}

function companySlugs() {
  const s = load().settings || {};
  return String(s.atsCompanies || '')
    .split(/[,\n]/).map(x => x.trim().toLowerCase().replace(/\s+/g, '')).filter(Boolean);
}

// Pull all listings from every configured company board (each errors independently)
async function searchAts() {
  const slugs = companySlugs();
  if (!slugs.length) return { jobs: [], errors: [] };
  const jobs = [];
  const errors = [];
  const fns = Object.fromEntries(ATS_PROBES);
  await Promise.allSettled(slugs.map(async slug => {
    const det = await detectAts(slug);
    if (!det.ats) { errors.push(`${slug}: no public board found on Greenhouse/Lever/Ashby/SmartRecruiters/Recruitee/Workable`); return; }
    try {
      const items = await fns[det.ats](slug);
      for (const j of items) {
        jobs.push({
          id: `ats-${j.externalId}`,
          source: 'Career page',
          salary: '',
          ...j
        });
      }
    } catch (err) {
      errors.push(`${slug} (${det.ats}): ${err.message}`);
    }
  }));
  return { jobs, errors };
}

module.exports = { searchAts, companySlugs };

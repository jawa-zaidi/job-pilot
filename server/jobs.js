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

async function searchRemotive(query, limit = 12) {
  const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Remotive API ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).slice(0, limit).map(j => ({
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
}

// LinkedIn via Apify's harvestapi/linkedin-job-search actor (pay-per-event —
// works on Apify's free monthly credit, but needs a one-time permission
// approval in the user's Apify console).
let linkedinPausedUntil = 0; // don't retry every query after a hard failure

async function searchLinkedInApify(query, limit, token) {
  if (Date.now() < linkedinPausedUntil) throw new Error('LinkedIn paused after a recent error (retries soon)');
  const url = `https://api.apify.com/v2/acts/harvestapi~linkedin-job-search/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=120`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchQuery: query, maxItems: Math.min(limit, 25) }),
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
  return (Array.isArray(items) ? items : []).slice(0, limit).map(j => ({
    id: `linkedin-${crypto.createHash('md5').update(String(j.jobUrl || j.url || j.link || j.id || String(j.title) + String(j.companyName))).digest('hex').slice(0, 10)}`,
    source: 'LinkedIn',
    title: j.title || 'Untitled role',
    company: j.companyName || j.company?.name || j.company || 'Unknown',
    location: j.location?.linkedinText || j.location || '',
    url: j.jobUrl || j.url || j.link || '',
    salary: j.salaryText || j.salary || '',
    publishedAt: j.postedDate || j.publishedAt || '',
    description: stripHtml(j.descriptionText || j.description || '').slice(0, 5000)
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
  const jobs = [];
  const used = [];

  if (cfg.remotive) {
    try {
      jobs.push(...await searchRemotive(query, limit));
      used.push('Remotive');
    } catch (err) {
      console.error('Remotive fetch failed:', err.message);
    }
  }
  if (cfg.linkedin && cfg.apifyToken) {
    try {
      jobs.push(...await searchLinkedInApify(query, limit, cfg.apifyToken));
      used.push('LinkedIn');
    } catch (err) {
      console.error('LinkedIn (Apify) fetch failed:', err.message);
      // surface actionable problems (like the one-time approval) to the user once
      if (err.message.includes('approval') || err.message.includes('rented')) {
        const db = load();
        const recent = (db.activity || []).slice(0, 20).some(a => a.text.includes('LinkedIn needs') || a.text.includes('LinkedIn scraper'));
        if (!recent) logActivity(`⚠️ ${err.message}`, 'error');
      }
    }
  }
  // Naukri: not implemented yet (no official API; Apify scraper or Playwright next)

  if (!jobs.length) {
    return { jobs: sampleJobs(), source: used.length ? `Sample (${used.join('+')} returned nothing)` : 'Sample (offline fallback)' };
  }
  // dedupe by title+company across sources
  const seen = new Set();
  const unique = jobs.filter(j => {
    const k = `${j.title}|${j.company}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { jobs: unique, source: used.join(' + ') };
}

module.exports = { searchJobs, sourcesConfig };

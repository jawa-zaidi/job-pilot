// Naukri.com via a maintained Apify actor (beta). Naukri's public API only
// admits India-residential IPs reliably, so we rent the proxy handling from
// Apify rather than run it ourselves. Same token as the LinkedIn source.
const { load } = require('../db');

const DEFAULT_ACTOR = 'bovi~naukri-jobs-scraper';

let pausedUntil = 0; // back off after a hard failure instead of retrying every query

// "3 Days Ago" / "Just Now" / ISO date → ISO timestamp (best effort)
function parsePostedDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso.toISOString();
  const m = s.match(/(\d+)\s*(day|hour|week|month)/i);
  if (m) {
    const mult = { hour: 3600000, day: 86400000, week: 7 * 86400000, month: 30 * 86400000 }[m[2].toLowerCase()];
    return new Date(Date.now() - Number(m[1]) * mult).toISOString();
  }
  if (/just now|today|few hours/i.test(s)) return new Date().toISOString();
  return '';
}

async function searchNaukri(query, { limit = 25, location = '' } = {}) {
  const s = load().settings || {};
  const token = s.apifyToken || '';
  if (!token) throw new Error('Naukri needs an Apify token (Settings → Job sources)');
  if (Date.now() < pausedUntil) throw new Error('Naukri paused after a recent error (retries soon)');

  const actor = (s.naukriActor || DEFAULT_ACTOR).trim();
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=120`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchKeywords: [query],
      ...(location && !/^remote$/i.test(location) ? { location } : {}),
      maxItems: Math.min(limit, 30),
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'IN' }
    }),
    signal: AbortSignal.timeout(150000)
  });
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    pausedUntil = Date.now() + 10 * 60 * 1000;
    let msg = `Apify Naukri error ${res.status}`;
    try {
      const e = JSON.parse(bodyText).error || {};
      if (e.type === 'full-permission-actor-not-approved') {
        msg = `Naukri scraper needs one-time approval: open ${e.data?.approvalUrl || 'console.apify.com'} , click Approve, then search again`;
      } else if (e.type === 'actor-is-not-rented') {
        msg = 'This Naukri scraper needs to be rented on Apify (open it in the Apify console and click Rent)';
      } else if (e.message) msg = `Apify Naukri: ${e.message.slice(0, 160)}`;
    } catch { /* keep generic msg */ }
    throw new Error(msg);
  }
  const items = JSON.parse(bodyText);
  return (Array.isArray(items) ? items : []).slice(0, limit).map(j => ({
    id: `naukri-${j.job_id || j.jobId || j.job_url || j.title}`,
    source: 'Naukri',
    title: j.title || j.jobTitle || 'Untitled role',
    company: j.company || j.companyName || 'Unknown',
    location: j.location || '',
    url: j.job_url || j.jobUrl || j.jdURL || '',
    salary: j.salary || '',
    publishedAt: parsePostedDate(j.posted_date || j.postedDate || j.footerPlaceholderLabel),
    description: [
      j.description_snippet || j.description || j.jobDescription || '',
      Array.isArray(j.skills) ? `Skills: ${j.skills.join(', ')}` : '',
      j.experience ? `Experience: ${j.experience}` : ''
    ].filter(Boolean).join('\n').slice(0, 5000)
  }));
}

module.exports = { searchNaukri };

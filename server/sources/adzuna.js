// Adzuna — free partner API (register at developer.adzuna.com), broad coverage
// across 20 countries incl. India, UK, US. Real posting dates, salary data.
const { load } = require('../db');

function adzunaConfig() {
  const s = load().settings || {};
  return {
    appId: (s.adzunaAppId || '').trim(),
    appKey: (s.adzunaAppKey || '').trim(),
    country: (s.adzunaCountry || 'in').trim().toLowerCase() // 2-letter code, e.g. in/gb/us
  };
}

function isConfigured() {
  const c = adzunaConfig();
  return !!(c.appId && c.appKey);
}

async function searchAdzuna(query, { limit = 25, maxAgeDays = 30, location = '' } = {}) {
  const c = adzunaConfig();
  if (!isConfigured()) throw new Error('Adzuna app_id/app_key not set');
  const params = new URLSearchParams({
    app_id: c.appId,
    app_key: c.appKey,
    what: query,
    results_per_page: String(Math.min(50, limit)),
    sort_by: 'date',
    max_days_old: String(Math.max(1, Math.round(maxAgeDays)))
  });
  if (location && !/^remote$/i.test(location)) params.set('where', location);
  const url = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(c.country)}/search/1?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Adzuna API ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(j => ({
    id: `adzuna-${j.id}`,
    source: 'Adzuna',
    title: j.title?.replace(/<[^>]+>/g, '') || 'Untitled role',
    company: j.company?.display_name || 'Unknown',
    location: j.location?.display_name || '',
    url: j.redirect_url || '',
    salary: j.salary_min ? `${Math.round(j.salary_min)}–${Math.round(j.salary_max || j.salary_min)}` : '',
    publishedAt: j.created || '',
    description: String(j.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000)
  }));
}

module.exports = { searchAdzuna, isConfigured, adzunaConfig };

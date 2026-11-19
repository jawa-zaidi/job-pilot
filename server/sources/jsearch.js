// JSearch (OpenWeb Ninja, sold through RapidAPI): job listings from Google for
// Jobs, which itself collects LinkedIn, Indeed, Naukri, Glassdoor, company
// career pages and more. It is a paid API with a free tier, so it is the
// above-board way to see those sites' listings: no scraping of the sites.
//
// Docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
// Uses /search-v2 (the old /search endpoint now answers 404). Every page of up
// to 10 results costs one request from your RapidAPI plan, and the free plan
// is small, so JobPilot asks for one page per search and
// stops for the day at a limit you set (default 6 a day).
const { load, save } = require('../db');

const HOST = 'jsearch.p.rapidapi.com';
const DEFAULT_DAILY_LIMIT = 6;

function jsearchConfig() {
  const s = load().settings || {};
  return {
    key: (s.jsearchKey || '').trim(),
    country: (s.jsearchCountry || 'in').trim().toLowerCase(),
    dailyLimit: Math.max(0, Number(s.jsearchDailyLimit ?? DEFAULT_DAILY_LIMIT) || 0)
  };
}

function isConfigured() {
  return !!jsearchConfig().key;
}

// The day on this computer's clock, not UTC: in India the UTC date changes at
// 05:30, so the daily count used to reset at 05:30 instead of midnight.
function today(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// How many requests today has used, and whether one more is allowed.
function usage() {
  const db = load();
  const u = db.settings?.jsearchUsage || {};
  const used = u.date === today() ? Number(u.count) || 0 : 0;
  return { used, limit: jsearchConfig().dailyLimit };
}

function recordRequest() {
  const db = load();
  db.settings = db.settings || {};
  const { used } = usage();
  db.settings.jsearchUsage = { date: today(), count: used + 1 };
  save();
}

// JSearch's date filter only has a few steps; pick the narrowest one that
// still covers the user's "posted in the last N days".
function datePosted(maxAgeDays) {
  if (maxAgeDays <= 1) return 'today';
  if (maxAgeDays <= 3) return '3days';
  if (maxAgeDays <= 7) return 'week';
  if (maxAgeDays <= 30) return 'month';
  return 'all';
}

// Build the request. Exported for tests: no network involved.
// No experience filters: JSearch's job_requirements / employment_types turned
// a search with 10 good Bengaluru results into zero (tested 2026-11), so
// seniority is left to JobPilot's own scoring.
function buildRequest(query, { maxAgeDays = 30, location = '', country } = {}) {
  const c = jsearchConfig();
  const remote = /^(remote|anywhere|remote anywhere|worldwide)$/i.test(String(location).trim());
  // JSearch's own advice: put the place in the query and set the country.
  const q = location && !remote ? `${query} in ${location}` : query;
  const params = new URLSearchParams({
    query: q,
    country: country || c.country,
    date_posted: datePosted(maxAgeDays)
  });
  if (remote) params.set('work_from_home', 'true');
  return {
    url: `https://${HOST}/search-v2?${params}`,
    headers: { 'X-RapidAPI-Key': c.key, 'X-RapidAPI-Host': HOST }
  };
}

function toJob(j) {
  const place = [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || j.job_location || '';
  const publisher = String(j.job_publisher || '').trim();
  return {
    id: `jsearch-${j.job_id}`,
    // "JSearch · LinkedIn" — the dashboard shows where it really came from.
    source: publisher ? `JSearch · ${publisher}` : 'JSearch',
    title: j.job_title || 'Untitled role',
    company: j.employer_name || 'Unknown',
    location: (j.job_is_remote ? 'Remote · ' : '') + place,
    url: j.job_apply_link || j.job_google_link || '',
    salary: j.job_min_salary ? `${Math.round(j.job_min_salary)}–${Math.round(j.job_max_salary || j.job_min_salary)}` : '',
    publishedAt: j.job_posted_at_datetime_utc
      || (j.job_posted_at_timestamp ? new Date(j.job_posted_at_timestamp * 1000).toISOString() : ''),
    description: String(j.job_description || '').replace(/\s+/g, ' ').trim().slice(0, 5000)
  };
}

async function searchJSearch(query, opts = {}) {
  const c = jsearchConfig();
  if (!c.key) throw new Error('JSearch needs its RapidAPI key — add it in Settings, under Advanced.');
  const { used, limit } = usage();
  if (used >= limit) {
    throw new Error(`today's ${limit} JSearch searches are used up, so it was skipped. It starts again tomorrow (change the limit in Settings, under Advanced).`);
  }
  const { url, headers } = buildRequest(query, opts);
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    // A timeout may have reached RapidAPI and been billed, so it counts. A
    // connection failure (no internet, DNS) never left this computer, so it
    // does not: otherwise one offline moment uses up the whole day.
    if (err?.name === 'TimeoutError') recordRequest();
    throw new Error(err?.name === 'TimeoutError' ? 'JSearch took too long to answer' : 'could not reach JSearch (check your internet connection)');
  }
  recordRequest(); // it reached RapidAPI, so it counts, whatever the answer
  if (res.status === 401 || res.status === 403) throw new Error('RapidAPI did not accept the JSearch key — check it, and that you subscribed to JSearch on RapidAPI.');
  if (res.status === 429) throw new Error('your RapidAPI plan for JSearch has run out of requests for now.');
  if (!res.ok) throw new Error('JSearch did not answer just now');
  const data = await res.json();
  // search-v2 answers { data: { jobs, cursor } }; the old /search answered { data: [...] }.
  const list = Array.isArray(data.data) ? data.data : (data.data?.jobs || []);
  return list.map(toJob);
}

module.exports = { searchJSearch, isConfigured, jsearchConfig, usage, buildRequest, toJob, datePosted, today };

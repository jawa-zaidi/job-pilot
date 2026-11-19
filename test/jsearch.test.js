// JSearch source: request building, result mapping and the daily limit, with
// no network calls. Runs against a throwaway data folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JOBPILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-jsearch-'));
process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const db = require('../server/db');
const js = require('../server/sources/jsearch');

function setSettings(extra) {
  const d = db.load();
  d.settings = { ...(d.settings || {}), ...extra };
  db.save();
}

test('JSearch is off until a key is saved', () => {
  assert.strictEqual(js.isConfigured(), false);
  setSettings({ jsearchKey: 'test-key-not-real' });
  assert.strictEqual(js.isConfigured(), true);
});

test('request uses search-v2 and puts the city in the query', () => {
  setSettings({ jsearchKey: 'test-key-not-real', jsearchCountry: 'in' });
  const { url, headers } = js.buildRequest('AI Engineer', { maxAgeDays: 7, location: 'Bengaluru', earlyCareer: true });
  const u = new URL(url);
  assert.strictEqual(u.host, 'jsearch.p.rapidapi.com');
  assert.strictEqual(u.pathname, '/search-v2');
  assert.strictEqual(u.searchParams.get('query'), 'AI Engineer in Bengaluru');
  assert.strictEqual(u.searchParams.get('country'), 'in');
  assert.strictEqual(u.searchParams.get('date_posted'), 'week');
  // Fresher filters emptied real searches, so they are not sent.
  assert.strictEqual(u.searchParams.get('job_requirements'), null);
  assert.strictEqual(u.searchParams.get('employment_types'), null);
  assert.strictEqual(headers['X-RapidAPI-Host'], 'jsearch.p.rapidapi.com');

  const remote = new URL(js.buildRequest('AI Engineer', { location: 'remote anywhere' }).url);
  assert.strictEqual(remote.searchParams.get('query'), 'AI Engineer');
  assert.strictEqual(remote.searchParams.get('work_from_home'), 'true');
});

test('date filter picks the narrowest step that covers the setting', () => {
  assert.strictEqual(js.datePosted(1), 'today');
  assert.strictEqual(js.datePosted(3), '3days');
  assert.strictEqual(js.datePosted(14), 'month');
  assert.strictEqual(js.datePosted(90), 'all');
});

test('a JSearch result becomes a JobPilot job that says where it came from', () => {
  const job = js.toJob({
    job_id: 'abc', job_title: 'Graduate AI Engineer', employer_name: 'Acme', job_publisher: 'LinkedIn',
    job_city: 'Bengaluru', job_state: 'Karnataka', job_country: 'IN', job_is_remote: false,
    job_apply_link: 'https://example.com/apply', job_posted_at_timestamp: 1794960000,
    job_description: 'Build   RAG\nsystems.'
  });
  assert.strictEqual(job.id, 'jsearch-abc');
  assert.strictEqual(job.source, 'JSearch · LinkedIn');
  assert.strictEqual(job.location, 'Bengaluru, Karnataka, IN');
  assert.strictEqual(job.description, 'Build RAG systems.');
  assert.ok(job.publishedAt.startsWith('2026-'));
});

test('the daily limit stops calls before they are made', async () => {
  setSettings({ jsearchKey: 'test-key-not-real', jsearchDailyLimit: 0 });
  await assert.rejects(() => js.searchJSearch('AI Engineer'), /used up/);
});

test('a connection failure does not use up a daily search', async () => {
  setSettings({ jsearchKey: 'test-key-not-real', jsearchDailyLimit: 6, jsearchUsage: { date: js.today(), count: 0 } });
  const realFetch = global.fetch;
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(() => js.searchJSearch('AI Engineer'), /internet/);
    assert.strictEqual(js.usage().used, 0);
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { jobs: [{ job_id: 'x', job_title: 'AI Engineer' }], cursor: 'c' } }) });
    const jobs = await js.searchJSearch('AI Engineer');
    assert.strictEqual(jobs.length, 1, 'reads search-v2 data.jobs');
    assert.strictEqual(js.usage().used, 1);
  } finally {
    global.fetch = realFetch;
  }
});

test('the daily count follows the local date, not UTC', () => {
  // 00:30 on 19 Nov on this computer's clock is still 19 Nov, whatever UTC says.
  assert.strictEqual(js.today(new Date(2026, 10, 19, 0, 30)), '2026-11-19');
  assert.strictEqual(js.today(new Date(2026, 10, 18, 23, 59)), '2026-11-18');
});

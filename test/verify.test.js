// "Is this job still open?" — deadline parsing, closed-page phrases, and the
// discovery-time filter. Uses a local HTTP server; nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { statedDeadline, deadlinePassed, filterOpenJobs, DEAD_PATTERNS, visibleText } = require('../server/verify');

const NOW = Date.UTC(2026, 10, 18); // 18 Nov 2026

test('reads unambiguous deadlines and ignores vague ones', () => {
  assert.strictEqual(statedDeadline('Application deadline: 16 Nov 2026 23:59 CET').toISOString().slice(0, 10), '2026-11-16');
  assert.strictEqual(statedDeadline('Apply by November 30, 2026.').toISOString().slice(0, 10), '2026-11-30');
  assert.strictEqual(statedDeadline('Closing date: 2026-12-01').toISOString().slice(0, 10), '2026-12-01');
  assert.strictEqual(statedDeadline('Closing date: Friday 5th December 2026').toISOString().slice(0, 10), '2026-12-05');
  // Real live advert: "no deadline, rolling basis" must not be read as a date.
  assert.strictEqual(statedDeadline('There is no deadline for this role, as we recruit on a rolling basis.'), null);
  assert.strictEqual(statedDeadline('Deadline: 05/12/2026'), null); // dd/mm vs mm/dd: skipped
  assert.strictEqual(statedDeadline('We grew 300% until 2025'), null);
});

test('a deadline only counts as passed after a full day of grace', () => {
  assert.ok(deadlinePassed('deadline: 16 Nov 2026', NOW + 1));
  assert.strictEqual(deadlinePassed('deadline: 17 Nov 2026', NOW), null);
  assert.strictEqual(deadlinePassed('deadline: 30 Nov 2026', NOW), null);
});

test('closed-page phrases are exact enough not to catch live adverts', () => {
  assert.ok(DEAD_PATTERNS.test('This job is no longer accepting applications'));
  assert.ok(DEAD_PATTERNS.test('This position has been filled.'));
  assert.ok(DEAD_PATTERNS.test('Applications are now closed'));
  assert.ok(!DEAD_PATTERNS.test('Once the position is filled, we will close the advert.'));
  assert.ok(!DEAD_PATTERNS.test('Your session has expired cookies')); // "expired" alone is not enough
  assert.strictEqual(visibleText('<p>Open</p><script>"job has expired"</script>').trim(), 'Open');
});

test('filterOpenJobs drops closed adverts and keeps anything uncertain', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/gone') { res.statusCode = 410; return res.end(); }
    if (req.url === '/filled') return res.end('<h1>Sorry, this position has been filled</h1>');
    if (req.url === '/blocked') { res.statusCode = 403; return res.end(); }
    if (req.url === '/hidden') return res.end('<p>Apply now</p><script>t="this job has closed"</script>');
    return res.end('<h1>Apply now</h1><p>Once the position is filled, we will close the advert.</p>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const job = (id, path, description = '') => ({ id, url: `${base}${path}`, description });
  try {
    const { open, dropped } = await filterOpenJobs([
      job('live', '/live'),
      job('gone', '/gone'),
      job('filled', '/filled'),
      job('blocked', '/blocked'),
      job('hidden', '/hidden'),
      job('late', '/live', 'Application deadline: 1 Jan 2020'),
      { id: 'nourl', description: '' }
    ], { timeoutMs: 3000 });
    assert.deepStrictEqual(open.map(j => j.id).sort(), ['blocked', 'hidden', 'live', 'nourl']);
    const why = Object.fromEntries(dropped.map(d => [d.job.id, d.reason]));
    assert.match(why.gone, /taken down/);
    assert.match(why.filled, /filled or closed/);
    assert.match(why.late, /deadline \(2020-01-01\) has passed/);
  } finally {
    server.close();
  }
});

test('reads the end date and expired flags job sites put in the page source', () => {
  const { structuredClosed } = require('../server/verify');
  const ld = obj => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
  const posting = end => ({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'x', validThrough: end });
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.match(structuredClosed(ld(posting('2026-11-10')), now), /ended on 2026-11-10/);
  assert.strictEqual(structuredClosed(ld(posting('2026-11-26 23:59:59')), now), null, 'still open');
  assert.strictEqual(structuredClosed(ld(posting('2026-11-19')), now), null, 'a day of grace');
  assert.strictEqual(structuredClosed(ld([posting('2026-11-10'), posting('2026-11-11')]), now), null, 'a list of postings proves nothing');
  assert.match(structuredClosed(ld({ '@graph': [posting('2026-11-01')] }), now), /ended/);
  // SimplyHired's closed page: 200, with "expired": true in its data.
  assert.match(structuredClosed('<script>window.__D={"job":{"expired":true}}</script>'), /expired/);
  assert.strictEqual(structuredClosed('{"expired":true},{"expired":false}'), null, 'mixed flags prove nothing');
  assert.ok(DEAD_PATTERNS.test('Job posting is not available'));
});

test('re-checking saved jobs moves closed ones to Closed and keeps the rest', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  process.env.JOBPILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-recheck-'));
  process.env.GROQ_API_KEY = ''; process.env.OPENAI_API_KEY = ''; process.env.ANTHROPIC_API_KEY = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/expired') return res.end('<title>Job posting is not available</title>');
    if (req.url === '/ended') return res.end(`<script type="application/ld+json">{"@type":"JobPosting","validThrough":"2026-01-01"}</script><h1>Apply</h1>`);
    return res.end('<h1>Apply now</h1>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const db = require('../server/db');
    const batch = require('../server/batch');
    const d = db.load();
    d.applications = [
      { id: 'a', title: 'A', company: 'X', status: 'discovered', url: `${base}/expired`, description: '' },
      { id: 'b', title: 'B', company: 'Y', status: 'discovered', url: `${base}/ended`, description: '' },
      { id: 'c', title: 'C', company: 'Z', status: 'discovered', url: `${base}/open`, description: '' },
      { id: 'd', title: 'D', company: 'W', status: 'applied', appliedAt: Date.now(), url: `${base}/expired`, description: '' }
    ];
    db.save();
    const r = await batch.recheckSavedJobs({ maxAgeMs: 0 });
    assert.strictEqual(r.checked, 3, 'applied jobs are left alone');
    assert.deepStrictEqual(r.closed.map(c => c.id).sort(), ['a', 'b']);
    const by = Object.fromEntries(db.load().applications.map(a => [a.id, a]));
    assert.strictEqual(by.a.status, 'closed');
    assert.strictEqual(by.c.status, 'discovered');
    assert.ok(by.c.checkedAt, 'open ones are marked as checked');
    assert.strictEqual(by.d.status, 'applied');
    const again = await batch.recheckSavedJobs();
    assert.strictEqual(again.checked, 0, 'recently checked jobs are not re-read');
  } finally { server.close(); }
});

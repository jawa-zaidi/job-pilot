// Minimal, dependency-light smoke test (Node's built-in test runner + assert).
// It boots the server in mock mode (no API keys) and checks that:
//   (a) it starts and the health/root routes respond, and
//   (b) the mock-mode pipeline path runs far enough to prove no crash
//       (profile extraction → job discovery → tailoring, all via mock fallbacks).
//
// Everything runs against a throwaway JOBPILOT_DATA folder in the OS temp dir,
// so the real ~/JobPilotData store is never touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Isolate data + force mock mode BEFORE anything requires ./db or ./llm.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-test-'));
process.env.JOBPILOT_DATA = TMP_DATA;
process.env.PORT = '0'; // ephemeral port — never clashes with a running app
// Set to '' (not delete): llm.js runs dotenv.config() at require time, and
// dotenv never overwrites an already-defined var — so '' blocks a developer's
// .env key from leaking into the tests (and from making real, billed API calls).
process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { app } = require('../server/index');
const llm = require('../server/llm');

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('server is in mock mode with no API keys', () => {
  assert.strictEqual(llm.hasKey(), false, 'expected mock mode (no key configured)');
});

test('health route responds ok', async () => {
  const res = await get('/api/health');
  assert.strictEqual(res.status, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.mockMode, true);
});

test('root route serves the frontend', async () => {
  const res = await get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /JobPilot/i);
});

test('stats route responds and reports mock mode', async () => {
  const res = await get('/api/stats');
  assert.strictEqual(res.status, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.mockMode, true);
});

test('mock pipeline: profile extraction → scoring → tailoring runs without crashing', async () => {
  const cv = 'Jane Doe\njane@example.com\n\nSenior JavaScript and React engineer with Node.js and SQL experience.';
  const profile = await llm.extractProfile(cv);
  assert.ok(profile && Array.isArray(profile.skills), 'profile extracted in mock mode');

  const jobs = [
    { id: 'j1', title: 'Frontend Engineer', company: 'Acme', description: 'React and TypeScript role.' },
    { id: 'j2', title: 'Backend Engineer', company: 'Globex', description: 'Node.js and SQL backend.' }
  ];
  const scores = await llm.scoreJobs(profile, jobs);
  assert.ok(scores.j1 && typeof scores.j1.score === 'number', 'jobs scored in mock mode');

  const tailored = await llm.tailorApplication(profile, cv, jobs[0]);
  assert.ok(tailored.cv && tailored.email_subject && tailored.email_body, 'application tailored in mock mode');
});

// The "Claude subscription" provider has no API key, so its mock-mode gate is
// CLI availability instead. These run the same on a machine with the Claude
// Code CLI installed and one without — they assert the relationship, not a
// fixed outcome.
test('claude_code provider is CLI-routed and carries no API key of its own', () => {
  const p = llm.PROVIDERS.claude_code;
  assert.ok(p, 'claude_code is a first-class provider');
  assert.strictEqual(p.cli, true, 'routes through the CLI, not an HTTP endpoint');
  assert.strictEqual(p.url, '', 'has no HTTP endpoint');
  assert.strictEqual(p.envKey, undefined, 'must never pick up a key from the environment');
});

test('claude_code detection reports an actionable state', () => {
  const st = llm.claudeCodeStatus();
  assert.strictEqual(typeof st.available, 'boolean');
  assert.ok(st.detail && st.detail.length > 0, 'always explains the state to the user');
  // A missing/unauthenticated CLI must say what to do, never fail silently.
  if (!st.available) assert.match(st.detail, /claude/i);
});

test('selecting claude_code enters mock mode exactly when the CLI is unavailable', () => {
  const db = require('../server/db');
  const data = db.load();
  const previous = data.settings.provider;
  try {
    data.settings.provider = 'claude_code';
    db.save();
    const info = llm.providerInfo();
    assert.strictEqual(info.provider, 'claude_code');
    // The core semantic: available CLI ⇒ not mock mode; missing CLI ⇒ mock mode.
    assert.strictEqual(llm.hasKey(), llm.claudeCodeStatus().available);
    assert.strictEqual(info.subscription, llm.claudeCodeStatus().available);

    // Unknown values still fall back to groq, so old stores keep working.
    data.settings.provider = 'something-else';
    db.save();
    assert.strictEqual(llm.providerInfo().provider, 'groq');
  } finally {
    data.settings.provider = previous;
    db.save();
  }
});

test('extractJsonText unwraps the fenced JSON the Claude Code CLI returns', () => {
  // The CLI has no response_format, so JSON mode relies on this helper.
  const fenced = '```json\n{"score": 78, "reasons": ["a"]}\n```';
  assert.deepStrictEqual(JSON.parse(llm.extractJsonText(fenced)), { score: 78, reasons: ['a'] });
});

test('recruiter-email extraction prefers role/personal addresses and skips generic', () => {
  const { extractRecruiterEmail } = require('../server/jobs');
  assert.strictEqual(extractRecruiterEmail('Apply at careers@acme.com'), 'careers@acme.com');
  assert.strictEqual(extractRecruiterEmail('Contact jane.doe@acme.com for details'), 'jane.doe@acme.com');
  // low-confidence generic → empty (routes to the manual path, no bad guess)
  assert.strictEqual(extractRecruiterEmail('Questions? info@acme.com'), '');
  // no-reply machinery is never picked
  assert.strictEqual(extractRecruiterEmail('From no-reply@acme.com'), '');
});

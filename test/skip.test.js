// "Not interested" must mean the job never comes back, even though the job
// itself is deleted. Throwaway data folder, job sources stubbed: no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.JOBPILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-skip-'));
process.env.PORT = '0';
process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const db = require('../server/db');
// The closed-advert check (when present) would fetch the made-up links; keep
// every job open so the test needs no network.
const verify = require('../server/verify');
verify.filterOpenJobs = async list => ({ open: list, dropped: [] });
const jobs = require('../server/jobs');
const job = () => ({ id: 'x1', source: 'Test', title: 'AI Engineer', company: 'Acme', location: 'Bengaluru',
  url: 'https://example.com/x', description: 'Python.', publishedAt: new Date().toISOString() });
jobs.searchJobs = async () => ({ jobs: [job()], source: 'Test', filtered: 0 });

const { app } = require('../server/index');
const { discover } = require('../server/discovery');

function del(server, id) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/applications/${id}`, method: 'DELETE' },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}

test('a job marked Not interested is not added again by the next search', async () => {
  const d = db.load();
  d.profile = { name: 'Test', skills: ['Python'], years_experience: 0 };
  d.applications = [];
  db.save();

  await discover('AI Engineer');
  const added = db.load().applications;
  assert.strictEqual(added.length, 1);

  const server = app.listen(0);
  try {
    assert.strictEqual(await del(server, added[0].id), 200);
  } finally { server.close(); }
  assert.strictEqual(db.load().applications.length, 0);

  await discover('AI Engineer');
  assert.strictEqual(db.load().applications.length, 0, 'it stayed gone');
});

function post(server, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST' },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}

test('Undo brings a skipped job back exactly as it was', async () => {
  const d = db.load();
  d.applications = [{ id: 'u1', key: 'acme|ai engineer', title: 'AI Engineer', company: 'Acme', status: 'discovered', matchScore: 77 }];
  d.skipped = [];
  db.save();
  const server = app.listen(0);
  try {
    assert.strictEqual(await del(server, 'u1'), 200);
    assert.strictEqual(db.load().applications.length, 0);
    assert.strictEqual(await post(server, '/api/applications/u1/restore'), 200);
    const back = db.load().applications;
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].matchScore, 77);
    assert.strictEqual((db.load().skipped || []).length, 0, 'no longer marked as skipped');
    assert.strictEqual(await post(server, '/api/applications/u1/restore'), 404, 'nothing left to restore');
  } finally { server.close(); }
});

function postJson(server, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve(JSON.parse(s || '{}'))); });
    req.on('error', reject);
    req.end(data);
  });
}

test('Skip all weak fits takes only unapplied jobs, and Undo brings them all back', async () => {
  const d = db.load();
  d.applications = [
    { id: 'w1', title: 'AWS Architect', company: 'A', status: 'discovered', matchScore: 20 },
    { id: 'w2', title: 'DevOps', company: 'B', status: 'discovered', matchScore: 30 },
    { id: 'p1', title: 'Applied one', company: 'C', status: 'applied', appliedAt: Date.now(), matchScore: 25 }
  ];
  d.skipped = [];
  db.save();
  const server = app.listen(0);
  try {
    const r = await postJson(server, '/api/applications/skip', { ids: ['w1', 'w2', 'p1'] });
    assert.strictEqual(r.skipped, 2, 'the applied job is never skipped in bulk');
    assert.deepStrictEqual(db.load().applications.map(a => a.id), ['p1']);
    const back = await postJson(server, '/api/applications/restore', { ids: ['w1', 'w2'] });
    assert.strictEqual(back.restored, 2);
    assert.deepStrictEqual(db.load().applications.map(a => a.id).sort(), ['p1', 'w1', 'w2']);
  } finally { server.close(); }
});

test('the Not interested note is written to disk, so it survives a restart', async () => {
  const d = db.load();
  d.applications = [{ id: 'r1', key: 'acme|ml engineer', title: 'ML Engineer', company: 'Acme', status: 'discovered' }];
  d.skipped = [];
  db.save();
  const server = app.listen(0);
  try { assert.strictEqual(await del(server, 'r1'), 200); } finally { server.close(); }
  // Read the saved file itself, not the in-memory copy.
  const dir = path.join(process.env.JOBPILOT_DATA, 'profiles');
  const file = path.join(dir, fs.readdirSync(dir)[0], 'data.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok((onDisk.skipped || []).some(s => s.key === 'acme|ml engineer'), 'skipped note saved');
});

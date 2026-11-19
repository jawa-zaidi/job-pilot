// Two searches at once (the auto-search on start-up plus the Find jobs
// button) used to add the same openings twice. Runs against a throwaway data
// folder, with the job sources stubbed out: no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JOBPILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-concurrency-'));
process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const db = require('../server/db');
// The closed-advert check (when present) would fetch the made-up links; keep
// every job open so the test needs no network.
const verify = require('../server/verify');
verify.filterOpenJobs = async list => ({ open: list, dropped: [] });
const jobs = require('../server/jobs');

const sameJobs = () => [
  { id: 'a1', source: 'Test', title: 'AI Engineering Intern', company: 'Epifi', location: 'Bengaluru', url: 'https://example.com/a', description: 'Python and LLMs.', publishedAt: new Date().toISOString() },
  { id: 'b1', source: 'Test', title: 'AI Engineer', company: 'Ametek', location: 'Bengaluru', url: 'https://example.com/b', description: 'Python.', publishedAt: new Date().toISOString() }
];
jobs.searchJobs = async () => {
  await new Promise(r => setTimeout(r, 50)); // both searches are "in flight" together
  return { jobs: sameJobs(), source: 'Test', filtered: 0 };
};

// Scoring is the slow part in real use (about a minute per chunk with the
// Claude subscription), which is what leaves room for the two to overlap.
const llm = require('../server/llm');
llm.scoreJobs = async (profile, list) => {
  await new Promise(r => setTimeout(r, 100));
  return Object.fromEntries(list.map(j => [String(j.id), { score: 80, reasons: [] }]));
};

const { discover } = require('../server/discovery');

test('two searches at once add each job only once', async () => {
  const d = db.load();
  d.profile = { name: 'Test', skills: ['Python'], years_experience: 0 };
  d.applications = [];
  db.save();
  await Promise.all([discover('AI Engineer'), discover('AI Engineer')]);
  const titles = db.load().applications.map(a => `${a.company}|${a.title}`).sort();
  assert.deepStrictEqual(titles, ['Ametek|AI Engineer', 'Epifi|AI Engineering Intern']);
});

// Stop: a running "write applications" step finishes the one in hand and
// stops; the rest stay untouched, and a later run is not affected.
// Throwaway data folder, the AI writer stubbed: no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JOBPILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-stop-'));
process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const db = require('../server/db');
const llm = require('../server/llm');
llm.tailorApplication = async () => {
  await new Promise(r => setTimeout(r, 40)); // the AI is slow; that's why Stop matters
  return { cv: 'CV', email_subject: 'Hi', email_body: 'Hello' };
};
const runs = require('../server/runs');
const batch = require('../server/batch');

test('Stop ends a running write after the one in hand, and a later run is unaffected', async () => {
  const d = db.load();
  d.profile = { name: 'Test', skills: ['Python'], years_experience: 0 };
  d.applications = Array.from({ length: 6 }, (_, i) => ({
    id: `j${i}`, title: `Job ${i}`, company: `Co ${i}`, status: 'discovered', matchScore: 80, description: ''
  }));
  db.save();

  const running = batch.generateAll();
  await new Promise(r => setTimeout(r, 60)); // first one done, second in hand
  runs.requestStop();
  const r = await running;
  assert.strictEqual(r.stopped, true);
  assert.ok(r.done >= 1 && r.done < 6, `stopped part-way (wrote ${r.done})`);
  const untouched = db.load().applications.filter(a => a.status === 'discovered' && !a.tailored).length;
  assert.strictEqual(untouched, 6 - r.done, 'the rest are untouched');

  const again = await batch.generateAll();
  assert.strictEqual(again.stopped, false);
  assert.strictEqual(again.done, untouched, 'a run started after Stop writes the rest');
});

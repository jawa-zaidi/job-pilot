// Seniority guard for job scoring: pure helpers, no server and no AI calls.
const test = require('node:test');
const assert = require('node:assert');

process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { scoringHelpers: H } = require('../server/llm');

const blurb = 'About us. '.repeat(300); // ~3000 chars of company intro first

test('requiredYears reads years tied to experience, ignores other numbers', () => {
  assert.strictEqual(H.requiredYears('Have 5+ years of experience in professional software engineering'), 5);
  assert.strictEqual(H.requiredYears('Minimum 3 years in backend roles'), 3);
  assert.strictEqual(H.requiredYears('2-4 years of relevant experience; 6+ yrs experience preferred'), 6);
  assert.strictEqual(H.requiredYears('We were founded 10 years ago and serve 5 years of data'), null);
  assert.strictEqual(H.requiredYears('No experience needed'), null);
});

test('scoringDescription keeps experience lines that sit past the head', () => {
  const text = `${blurb}\nYou must have 5+ years of professional software engineering experience.\nNice to have: pgvector.`;
  const out = H.scoringDescription(text);
  assert.ok(out.length < text.length + 200);
  assert.match(out, /5\+ years of professional software engineering experience/);
  assert.doesNotMatch(out, /pgvector/);
  assert.strictEqual(H.scoringDescription('short ad'), 'short ad');
});

test('applySeniority caps over-senior roles and boosts early-career ones for a fresher', () => {
  const fresher = { years_experience: 0 };
  const supabase = { title: 'Software Engineer AI Tooling', description: `${blurb} Have 5+ years of professional software engineering experience.` };
  assert.strictEqual(H.applySeniority(fresher, supabase, { score: 84, reasons: [] }).score, 35);

  const staff = { title: 'Staff Forward Deployed Engineer', description: 'agents and evals' };
  assert.strictEqual(H.applySeniority(fresher, staff, { score: 62, reasons: [] }).score, 35);

  const grad = { title: 'Graduate Software Engineer (2027 start)', description: 'For final-year students.' };
  assert.strictEqual(H.applySeniority(fresher, grad, { score: 51, reasons: [] }).score, 61);

  const seniorGrad = { title: 'Senior Graduate Programme Lead', description: '' };
  assert.notStrictEqual(H.applySeniority(fresher, seniorGrad, { score: 50, reasons: [] }).score, 35);
});

test('applySeniority leaves scores alone when the profile has no years figure', () => {
  const job = { title: 'Senior Engineer', description: '8+ years of experience' };
  assert.strictEqual(H.applySeniority({}, job, { score: 80, reasons: [] }).score, 80);
  assert.strictEqual(H.applySeniority({ years_experience: 9 }, job, { score: 80, reasons: [] }).score, 80);
});

test('hasWord matches whole words only', () => {
  assert.ok(!H.hasWord('we use mongodb and google', 'go'));
  assert.ok(H.hasWord('written in go and rust', 'go'));
  assert.ok(H.hasWord('modern c++ codebase', 'c++'));
  assert.ok(!H.hasWord('object storage', 'rag'));
});

test('writer scores reach jobs with long ids, and left-out jobs get the capped guess', () => {
  const { mapScores } = require('../server/llm').scoringHelpers;
  const profile = { years_experience: 0, skills: ['Python'] };
  const longId = 'jsearch-' + 'UWItR0c2ZVBmT183ZFVaZ0FBQUFBQT09OkVzd0JDb3dCUVVSRVlsZGxX'.repeat(3);
  const jobs = [
    { id: longId, title: 'AI Engineering Intern', description: 'Python, RAG.' },
    { id: 'b', title: 'Senior AI Engineer', description: 'Python.' },
    { id: 'c', title: 'AI Engineer', description: 'Python and LLMs.' }
  ];
  // The writer answers with the short ids it was given, and skips job 3.
  const map = mapScores(profile, jobs, { scores: [
    { id: '1', score: 90, reasons: ['Good fit'] },
    { id: 2, score: 80, reasons: ['Strong skills'] }
  ] });
  assert.strictEqual(map[longId].score >= 90, true);
  assert.ok(map.b.score <= 35, 'senior title capped for a fresher');
  assert.ok(map.c.score <= 54, 'left-out job gets the capped guess, not 50 by default');
  assert.match(map.c.reasons[0], /rough keyword guess/);
});

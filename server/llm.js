// LLM client — supports Groq, OpenAI (ChatGPT), Anthropic (Claude) and a
// Claude Pro/Max subscription via the locally installed Claude Code CLI,
// selectable in Settings, with a model override and a user-editable custom
// system prompt that is injected into scoring / CV / email generation. Falls
// back to deterministic mock output when no API key is configured.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFile, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const { load } = require('./db');
const P = require('./prompts'); // all quality-critical system prompts live in prompts.js

// One hung LLM request must not stall an entire batch generate; generation can
// be slow, so the ceiling is generous.
const LLM_TIMEOUT_MS = 60000;

const PROVIDERS = {
  groq: {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY'
  },
  openai: {
    label: 'OpenAI (ChatGPT)',
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY'
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-haiku-4-5-20251001',
    envKey: 'ANTHROPIC_API_KEY',
    anthropic: true // uses the Messages API shape, not the OpenAI one
  },
  claude_code: {
    label: 'Claude subscription (no API key)',
    url: '',
    // Haiku by default: a subscription has no per-token cost, but it does have
    // usage limits, and a batch run scores jobs in many chunks. Users who want
    // better CVs can put claude-sonnet-5 in the model box at no extra charge.
    defaultModel: 'claude-haiku-4-5',
    cli: true // runs the local Claude Code CLI instead of an HTTP endpoint
  }
};

// ---------- Claude subscription via the Claude Code CLI ----------
// The CLI is already signed in to the user's own Claude account, so this
// provider needs no API key and bills nothing per token. We drive it as a pure
// text completion: no tools, no session files, no project settings, and a
// neutral working directory so it can never touch the user's files.

const CLI_ARGS = [
  '-p',                          // non-interactive: print the answer and exit
  '--output-format', 'json',     // machine-readable envelope; text is in .result
  '--tools', '',                 // no tools at all — it cannot read or write anything
  '--strict-mcp-config',         // ignore any MCP servers the user has configured
  '--disable-slash-commands',    // no skills
  '--setting-sources', '',       // no user/project settings, no CLAUDE.md discovery
  '--no-session-persistence'     // leave no transcripts behind
];

// Where the CLI usually lives. `claude` alone covers anything already on PATH;
// the rest are the common installer targets for when the server was started
// from a launcher with a minimal PATH.
const CLI_CANDIDATES = [
  process.env.CLAUDE_CLI_PATH,
  'claude',
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
].filter(Boolean);

// Re-probe a working CLI rarely, a broken one often — so the Settings screen
// recovers quickly once the user actually runs `claude login`.
const CLI_OK_TTL_MS = 5 * 60 * 1000;
const CLI_FAIL_TTL_MS = 15 * 1000;
let cliProbe = null; // { at, bin, ok, reason, plan }

// The CLI prefers ANTHROPIC_API_KEY over the subscription login, and this file
// loads .env at require time — so a stray key in the environment would quietly
// put a "no API key" provider back on per-token billing. Strip both auth vars.
function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function probeClaudeCode() {
  for (const bin of CLI_CANDIDATES) {
    let out;
    try {
      out = execFileSync(bin, ['auth', 'status', '--json'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: os.tmpdir(),
        env: cliEnv()
      });
    } catch {
      continue; // not installed at this path (or it failed to run) — try the next
    }
    let status;
    try { status = JSON.parse(out); } catch { status = null; }
    // Deliberately only read loggedIn/subscriptionType — the same payload also
    // carries the account email and org id, which are none of our business.
    if (!status) {
      return { bin, ok: false, reason: 'Claude is on this computer but it did not answer clearly when we asked whether you were signed in. Open Claude, sign in, and come back to Settings.' };
    }
    if (!status.loggedIn) {
      // "not signed in" is the phrase the Settings screen looks for — keep it.
      return { bin, ok: false, reason: 'Claude is on this computer but nobody is signed in yet. Sign in there, then come back to Settings.' };
    }
    return { bin, ok: true, plan: String(status.subscriptionType || '') };
  }
  // "not found" is the phrase the Settings screen looks for — keep it.
  return { bin: '', ok: false, reason: 'Claude was not found on this computer. Install it from claude.com/code and sign in, or paste a code from one of the other options instead.' };
}

function claudeCode() {
  const now = Date.now();
  const ttl = cliProbe && cliProbe.ok ? CLI_OK_TTL_MS : CLI_FAIL_TTL_MS;
  if (cliProbe && now - cliProbe.at < ttl) return cliProbe;
  cliProbe = Object.assign({ at: now }, probeClaudeCode());
  return cliProbe;
}

// Called when settings change so a freshly selected provider is checked now,
// not up to a cache-lifetime later.
function resetClaudeCodeProbe() { cliProbe = null; }

// Shape the Settings screen renders: "Detected ✓" vs "Not found".
function claudeCodeStatus() {
  const p = claudeCode();
  return {
    available: p.ok,
    plan: p.ok ? (p.plan || '') : '',
    detail: p.ok
      ? `Found it — you're signed in${p.plan ? ` on the ${p.plan} plan` : ''}, and the writing is included in what you already pay for.`
      : p.reason
  };
}

// Errors from this route are tagged so friendlyError() leaves them alone: they
// already say what to do, and advice about pasted codes doesn't apply here.
function cliError(message) {
  const err = new Error(message);
  err.claudeCode = true;
  err.plain = true;    // safe to show a person as it is
  return err;
}

// Run one completion through the CLI. Rejects (never resolves half-broken) so
// the existing strictJSON / catch paths handle it exactly like an API failure.
function runClaudeCode(system, prompt, model) {
  const probe = claudeCode();
  if (!probe.ok) return Promise.reject(cliError(probe.reason));
  return new Promise((resolve, reject) => {
    const child = execFile(
      probe.bin,
      [...CLI_ARGS, '--model', model, '--system-prompt', system],
      {
        cwd: os.tmpdir(),        // neutral cwd — never the user's project
        env: cliEnv(),
        timeout: LLM_TIMEOUT_MS, // Node kills the child itself once this elapses
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024
      },
      (err, stdout) => {
        if (err) {
          if (err.killed || err.signal) {
            return reject(cliError('Claude on this computer took too long to answer — try again, or choose a different writer in Settings.'));
          }
          console.error('Claude Code CLI failed:', String(err.message || err).slice(0, 200));
          return reject(cliError('Claude on this computer would not run just now. Open Claude, check you are signed in, and try again.'));
        }
        let data;
        try { data = JSON.parse(stdout); } catch {
          return reject(cliError('Claude on this computer answered with something we could not read. Check you are still signed in there, and try again.'));
        }
        if (data.is_error || data.subtype !== 'success') {
          console.error('Claude Code CLI error:', String(data.result || data.subtype || 'unknown').slice(0, 200));
          return reject(cliError('Claude on this computer could not finish that one — try again in a moment.'));
        }
        // A subscription has no per-token dollar cost — record the usage for
        // transparency but never invent a price for it.
        const u = data.usage || {};
        try {
          require('./costs').recordIncluded(model, u.input_tokens || 0, u.output_tokens || 0);
        } catch { /* best-effort */ }
        resolve(String(data.result || ''));
      }
    );
    child.stdin.end(prompt); // prompt goes over stdin, never the command line
  });
}

function cfg() {
  const s = load().settings || {};
  const name = ['openai', 'anthropic', 'claude_code'].includes(s.provider) ? s.provider : 'groq';
  const p = PROVIDERS[name];
  const model = (s.model || '').trim() || p.defaultModel;
  if (p.cli) {
    // There is no key to configure here, so CLI availability stands in for one:
    // present and signed in behaves like a valid key, missing behaves like a
    // missing key (clear message + mock fallback) rather than a crash.
    const probe = claudeCode();
    return { provider: name, label: p.label, url: '', key: probe.ok ? 'subscription' : '', model, anthropic: false, cli: true };
  }
  const keyBySetting = { groq: s.groqKey, openai: s.openaiKey, anthropic: s.anthropicKey };
  const key = keyBySetting[name] || process.env[p.envKey] || '';
  return { provider: name, label: p.label, url: p.url, key, model, anthropic: !!p.anthropic };
}

// Anthropic has no JSON mode; models occasionally wrap JSON in prose or code
// fences, so pull the outermost JSON object/array out of the text.
function extractJsonText(text) {
  const s = String(text || '');
  const start = s.search(/[{[]/);
  if (start < 0) return s;
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  return end > start ? s.slice(start, end + 1) : s;
}

function hasKey() { return !!cfg().key; }
function providerInfo() {
  const c = cfg();
  // subscription: true means "working, and costs nothing per token" — the UI
  // and the cost ledger both key off it.
  return { provider: c.provider, model: c.model, hasKey: !!c.key, subscription: !!c.cli && !!c.key };
}
// Per-step instructions: 'find' (job scoring), 'cv', 'email'. Falls back to the
// legacy single customPrompt when a step-specific one isn't set.
function promptFor(kinds = []) {
  const s = load().settings || {};
  const map = { find: s.promptFind, cv: s.promptCV, email: s.promptEmail };
  const labels = { find: 'When finding & scoring jobs', cv: 'When writing the CV', email: 'When writing the application email' };
  const parts = [];
  for (const k of kinds) {
    const v = (map[k] || '').trim();
    if (v) parts.push(`${labels[k]}:\n${v}`);
  }
  if (!parts.length) {
    const legacy = (s.customPrompt || '').trim();
    if (legacy) parts.push(legacy);
  }
  return parts.join('\n\n');
}

async function chat(messages, { json = false, maxTokens = 2048, promptKinds = null } = {}) {
  const c = cfg();
  if (!c.key) return null;
  // The user's standing instructions are concatenated INTO the system prompt
  // under a highest-priority header — they override the built-in guidance.
  const custom = promptKinds ? promptFor(promptKinds) : '';
  const systemText = P.withUserInstructions(messages[0].content, custom);
  const rest = messages.slice(1);

  if (c.cli) {
    // The CLI takes one system prompt and one prompt on stdin, so extra
    // system-role turns (e.g. a revision request) are folded into the system
    // text exactly as the Anthropic branch does, and the conversation is
    // flattened into a single prompt. There is no response_format, so JSON is
    // requested in the prompt and pulled back out with extractJsonText().
    const extraSystem = rest.filter(m => m.role === 'system').map(m => m.content);
    const convo = rest.filter(m => m.role !== 'system');
    const fullSystem = [
      'You are a text-completion engine inside the JobPilot app. You have no tools and no filesystem access. Answer the request directly, with no preamble and no questions back.',
      systemText,
      ...extraSystem
    ]
      .concat(json ? ['Respond with ONLY a single JSON object — no prose, no markdown code fences.'] : [])
      .join('\n\n');
    const prompt = convo
      .map(m => (m.role === 'assistant' ? `Your previous answer:\n${m.content}` : m.content))
      .join('\n\n');
    const text = await runClaudeCode(fullSystem, prompt, c.model);
    return json ? extractJsonText(text) : text;
  }

  let res;
  try {
    if (c.anthropic) {
      // Anthropic Messages API: system is a top-level field, max_tokens is
      // required, there is no response_format. Any extra system-role turns
      // (e.g. a revision request) are folded into the system field; JSON mode
      // is requested via the prompt and parsed out of the text.
      const extraSystem = rest.filter(m => m.role === 'system').map(m => m.content);
      const convo = rest.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));
      const fullSystem = [systemText, ...extraSystem]
        .concat(json ? ['Respond with ONLY a single JSON object — no prose, no markdown code fences.'] : [])
        .join('\n\n');
      res = await fetch(c.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': c.key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: c.model,
          max_tokens: maxTokens,
          temperature: 0.4,
          system: fullSystem,
          messages: convo
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
      });
    } else {
      const system = { role: 'system', content: systemText };
      res = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
        body: JSON.stringify({
          model: c.model,
          messages: [system, ...rest],
          temperature: 0.4,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
      });
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw plainError(`${c.label} took too long to answer — try again, or choose a different writer in Settings.`);
    }
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The status code and the service's own words belong in the terminal, not
    // in front of a person. What a person reads is written below.
    console.error(`${c.label} request failed: ${res.status} ${body.slice(0, 300)}`);
    const err = plainError(writerFailureText(c.label, res.status));
    err.httpStatus = res.status;                       // so friendlyError can be exact
    const wait = body.match(/try again in ([\dhm.\s]+)/i);
    if (wait) err.retryHint = wait[1].trim();
    throw err;
  }
  const data = await res.json();
  // Usage shapes differ: OpenAI/Groq use prompt/completion_tokens, Anthropic
  // uses input/output_tokens. Cost tracking is best-effort.
  const u = data.usage || {};
  const promptToks = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completionToks = u.completion_tokens ?? u.output_tokens ?? 0;
  if (promptToks || completionToks) {
    try { require('./costs').recordLLM(c.model, promptToks, completionToks); } catch { /* best-effort */ }
  }
  if (c.anthropic) {
    const text = (data.content || []).map(b => b.text || '').join('');
    return json ? extractJsonText(text) : text;
  }
  return data.choices[0].message.content;
}

async function chatJSON(messages, opts = {}) {
  const out = await chat(messages, { ...opts, json: true });
  if (out === null) return null;
  return JSON.parse(out);
}

// Keeps the status on the rewritten error so callers that back off on a
// rate limit (batch generate) still can, without reading it out of the words.
function withStatus(status, err) { err.httpStatus = status; return err; }

// Errors marked `plain` are written for a person and can be shown as they are.
function plainError(message) {
  const err = new Error(message);
  err.plain = true;
  return err;
}

// What a person reads when the writing service turns us away. Same three cases
// friendlyError() has always handled, said without the status code.
function writerFailureText(label, status) {
  if (status === 429) return `${label} has had enough requests from you for now — give it a little while and try again.`;
  if (status === 401 || status === 403) return `${label} did not accept the code you saved — check it in Settings, under The writer.`;
  if (status >= 500) return `${label} is having trouble at their end. Nothing is lost — try again in a few minutes.`;
  return `${label} could not do that one — try again, or choose a different writer in Settings.`;
}

// Turn writing-service errors into plain, actionable messages
function friendlyError(err) {
  const m = String(err.message || err);
  const status = err.httpStatus || 0;
  // Claude-on-your-computer errors already say what to do — don't rewrite them
  // into advice about pasted codes, which doesn't apply to that route.
  if (err.claudeCode || m.includes('Claude Code')) return plainError(m.slice(0, 200));
  if (status === 429 || m.includes(' 429')) {
    const wait = err.retryHint || (m.match(/try again in ([\dhm.\s]+)/i) || [])[1];
    return withStatus(429, plainError(`The free allowance for the writing has run out for now. ${wait ? `Try again in ${String(wait).trim()}, or ` : 'Try again later, or '}choose a different writer in Settings.`));
  }
  if (status === 401 || status === 403 || m.includes(' 401') || m.includes(' 403')) {
    return withStatus(status || 401, plainError('The code saved for the writing was not accepted — check it in Settings, under The writer.'));
  }
  return err.plain ? err : new Error(m.slice(0, 200));
}

// For user-facing single actions: succeed, or throw a clear error when a key is
// present (never silently return misleading mock output).
async function strictJSON(messages, opts, mockFn) {
  try {
    const r = await chatJSON(messages, opts);
    if (r) return r;          // no key configured → chat() returned null → mock
  } catch (err) {
    if (hasKey()) throw friendlyError(err);   // key present but failed → surface it
    console.error('LLM failed (no key, using mock):', err.message);
  }
  return mockFn();
}

// ---------- Profile extraction ----------

async function extractProfile(cvText) {
  return strictJSON([
    {
      role: 'system',
      content:
        'You extract structured candidate profiles from CV text. Respond ONLY with JSON: ' +
        '{"name":str,"email":str,"location":str,"title":str,"years_experience":num,"skills":[str],' +
        '"top_achievements":[str],"summary":str,"target_roles":[str]}. ' +
        '"location" is where the person says they are (town, city or country as written on the CV) — ' +
        'an empty string if the CV does not say. Never guess it.'
    },
    { role: 'user', content: `Extract the profile from this CV:\n\n${cvText.slice(0, 12000)}` }
  ], {}, () => mockProfile(cvText));
}

// Where the CV says they are, without a writer connected. Only the header block
// is read (that is where people put it), and only two shapes are trusted: an
// explicit "Location: …" line, and a "Town, Country" pair. Anything else comes
// back empty — the welcome questions suggest nothing rather than the wrong
// place, which is what reading the computer's timezone used to do.
function mockLocation(cvText) {
  const head = String(cvText || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12);
  for (const line of head) {
    const tagged = /^(?:location|based in|address)\s*[:\-–]\s*(.+)$/i.exec(line);
    if (tagged) return tagged[1].trim().slice(0, 60);
  }
  for (const line of head) {
    if (line.includes('@') || /\d{4,}/.test(line)) continue;   // contact lines, not places
    const m = /\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)?, ?[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)?)\b/.exec(line);
    if (m && m[1].length < 60) return m[1];
  }
  return '';
}

function mockProfile(cvText) {
  const KNOWN = ['javascript','typescript','react','node','python','java','sql','aws','docker',
    'kubernetes','figma','product management','marketing','sales','excel','django','flutter',
    'swift','go','rust','machine learning','data analysis','agile','scrum','next.js','graphql'];
  const lower = cvText.toLowerCase();
  const skills = KNOWN.filter(k => lower.includes(k));
  const emailMatch = cvText.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  const firstLine = cvText.split('\n').map(l => l.trim()).filter(Boolean)[0] || 'Candidate';
  return {
    name: firstLine.length < 60 ? firstLine : 'Candidate',
    email: emailMatch ? emailMatch[0] : '',
    location: mockLocation(cvText),
    title: skills.length ? `${skills[0][0].toUpperCase() + skills[0].slice(1)} Professional` : 'Professional',
    years_experience: 3,
    skills: skills.length ? skills : ['communication', 'problem solving'],
    top_achievements: ['Set up the writer in Settings, then add your CV again — this gets filled in properly then.'],
    summary: 'These details were picked out of your CV without the writer set up, so they are rough. '
      + 'Set the writer up in Settings and add your CV again for a proper read.',
    target_roles: skills.slice(0, 3).map(s => `${s} roles`)
  };
}

// ---------- Job match scoring ----------

async function scoreJobs(profile, jobs) {
  // score in chunks — one giant call truncates and loses accuracy
  const CHUNK = 15;
  if (jobs.length > CHUNK) {
    const map = {};
    for (let i = 0; i < jobs.length; i += CHUNK) {
      Object.assign(map, await scoreJobs(profile, jobs.slice(i, i + CHUNK)));
    }
    return map;
  }
  const jobList = jobs.map(j => ({
    id: j.id,
    title: j.title,
    company: j.company,
    description: (j.description || '').slice(0, 900)
  }));
  const result = await chatJSON([
    { role: 'system', content: P.SCORE_JOBS },
    {
      role: 'user',
      content: `Candidate profile:\n${JSON.stringify(profile)}\n\nJobs:\n${JSON.stringify(jobList)}`
    }
  ], { maxTokens: 3000, promptKinds: ['find'] }).catch(err => {
    console.error('scoreJobs failed:', err.message);
    return null;
  });
  if (result && Array.isArray(result.scores)) {
    const map = {};
    for (const s of result.scores) map[String(s.id)] = { score: s.score, reasons: s.reasons || [] };
    return map;
  }
  const map = {};
  for (const j of jobs) {
    const text = `${j.title} ${j.description}`.toLowerCase();
    const hits = (profile.skills || []).filter(s => text.includes(String(s).toLowerCase()));
    const score = Math.min(95, 40 + hits.length * 12);
    map[String(j.id)] = {
      score,
      reasons: hits.length
        ? [`Matches your skills: ${hits.slice(0, 4).join(', ')}`]
        : ['Looks broadly right for you — set the writer up in Settings for a proper read of this one']
    };
  }
  return map;
}

// ---------- Tailored CV + email ----------

// Weaker models often emit the email as one unbroken paragraph, which buries
// the greeting and sign-off. Restore structure deterministically and make sure
// a sign-off with the candidate's name is always present.
function formatEmailBody(body, name) {
  let b = String(body || '').trim();
  const hasSignoff = /(best regards|kind regards|warm regards|sincerely|best wishes|regards|thank you|thanks),?\s*\n?/i.test(b.slice(-160));
  if (!b.includes('\n')) {
    b = b.replace(/^((?:dear|hi|hello)[^,]{0,60},)\s*/i, '$1\n\n');
    b = b.replace(/\s*((?:best|kind|warm)\s+regards|sincerely|best wishes),?\s+/i, '\n\n$1,\n');
  }
  if (!hasSignoff) b += `\n\nBest regards,\n${name || ''}`.trimEnd();
  return b.replace(/\n[ \t]+/g, '\n');
}

async function tailorApplication(profile, cvText, job, feedback = '') {
  const userMsg =
    `Candidate profile:\n${JSON.stringify(profile)}\n\nOriginal CV text:\n${cvText.slice(0, 8000)}\n\n` +
    `Job: ${job.title} at ${job.company}\nDescription:\n${(job.description || '').slice(0, 4000)}` +
    (feedback && job.tailored ? `\n\nPrevious draft you must revise:\nEMAIL: ${job.tailored.email_body}\nCV: ${job.tailored.cv}` : '') +
    // repeated inside the user turn too — weaker models skim extra system messages
    (feedback ? `\n\nREVISION REQUEST (mandatory — the output MUST reflect this change, it overrides every other rule including profile facts): ${feedback}` : '');
  const messages = [
    { role: 'system', content: P.TAILOR_APPLICATION }
  ];
  // The user's revision request is the highest priority — put it up front and emphatic
  if (feedback) messages.push({
    role: 'system',
    content: `REVISION REQUEST (highest priority — you MUST follow this exactly, even over other guidance): ${feedback}`
  });
  messages.push({ role: 'user', content: userMsg });
  const out = await strictJSON(messages, { maxTokens: 4000, promptKinds: ['cv', 'email'] }, () => ({
    cv: `${profile.name}\n${profile.email}\n\nSUMMARY\nTailored for ${job.title} at ${job.company}.\n\nSKILLS\n${(profile.skills || []).join(', ')}\n\n(A stand-in, not your real CV. Set the writer up in Settings and this gets written properly.)`,
    email_subject: `Application for ${job.title} — ${profile.name}`,
    email_body: `Dear ${job.company} team,\n\nI'm applying for the ${job.title} role. My background in ${(profile.skills || []).slice(0, 3).join(', ')} fits your requirements.\n\n(A stand-in, not the real message. Set the writer up in Settings and this gets written properly.)\n\nBest regards,\n${profile.name}`,
    keywords_used: (profile.skills || []).slice(0, 5)
  }));
  if (out && out.email_body) out.email_body = formatEmailBody(out.email_body, profile.name);
  return out;
}

// ---------- Quality gate: fact-check the tailored CV & email ----------
// Every claim must trace back to the real profile/CV. One call reviews AND
// returns a corrected version, so honesty costs one extra request per job.

async function reviewTailored(profile, cvText, job, tailored, userRevision = '') {
  const result = await chatJSON([
    { role: 'system', content: P.FACT_CHECK },
    {
      role: 'user',
      content:
        `REAL profile:\n${JSON.stringify(profile)}\n\nREAL original CV:\n${cvText.slice(0, 8000)}\n\n` +
        `Job: ${job.title} at ${job.company}\n\nTAILORED CV to check:\n${tailored.cv}\n\nTAILORED email to check:\n${tailored.email_body}` +
        (userRevision
          ? `\n\nIMPORTANT: the candidate explicitly requested this revision — it is authoritative, NOT a fabrication. Do not flag or undo changes it caused: "${userRevision}"`
          : '')
    }
    // promptKinds: the user's standing CV/email instructions ride along, so the
    // checker knows user-mandated style choices are intentional, not defects.
  ], { maxTokens: 4000, promptKinds: ['cv', 'email'] }).catch(err => {
    console.error('reviewTailored failed:', err.message);
    return null;
  });
  if (!result) return { ok: true, problems: [], checked: false }; // no key / API down → don't block
  return {
    ok: !!result.ok,
    problems: Array.isArray(result.problems) ? result.problems : [],
    cv: result.cv || null,
    email_body: result.email_body ? formatEmailBody(result.email_body, profile.name) : null,
    checked: true
  };
}

// ---------- Inbox classification ----------
// A recruiter's actual reply, an ATS auto-confirmation and a rejection must
// land in different places on the board.

async function classifyReply(job, emailText) {
  const result = await chatJSON([
    { role: 'system', content: P.CLASSIFY_REPLY },
    {
      role: 'user',
      content: `Application: ${job.title} at ${job.company}\n\nEmail received:\n${String(emailText || '').slice(0, 4000)}`
    }
  ]).catch(err => {
    console.error('classifyReply failed:', err.message);
    return null;
  });
  if (!result || !result.type) return null; // caller falls back to the old behavior
  const type = ['confirmation', 'rejection', 'interview', 'human_reply', 'other'].includes(result.type)
    ? result.type : 'other';
  return { related: result.related !== false, type, summary: result.summary || '' };
}

// ---------- Follow-up email ----------

async function followUpEmail(profile, job, dayNumber, previousEmails) {
  const result = await chatJSON([
    { role: 'system', content: P.FOLLOW_UP },
    {
      role: 'user',
      content:
        `Candidate: ${JSON.stringify(profile)}\nJob: ${job.title} at ${job.company}\n` +
        `This is the follow-up on day ${dayNumber} after applying. Previous emails sent: ${previousEmails.length}.`
    }
  ], { promptKinds: ['email'] }).catch(err => {
    console.error('followUpEmail failed:', err.message);
    return null;
  });
  if (result) return result;
  return {
    subject: `Following up: ${job.title} application — ${profile.name}`,
    body: `Hi ${job.company} team,\n\nI wanted to follow up on my application for ${job.title} (day ${dayNumber}). I remain very interested in the role.\n\n(A stand-in reminder — the writer is not set up yet.)\n\nBest,\n${profile.name}`
  };
}

// ---------- Anonymous product feedback for the JobPilot developer ----------

async function devFeedbackReport(snap) {
  const result = await chatJSON([
    {
      role: 'system',
      content:
        'You write a short product-feedback email to the DEVELOPER of JobPilot (a job-application ' +
        'autopilot app) based on anonymous usage telemetry from one installation. Two sections: ' +
        'HOW THIS USER USES JOBPILOT (2-4 lines from the numbers: manual vs auto, which sources, ' +
        'email vs manual applies) and QUALITY & IMPROVEMENT SUGGESTIONS (numbered, max 5, concrete — ' +
        'derived from error patterns, simulated-send counts, fact-check corrections, reply rates). ' +
        'The data contains no personal information and neither should the email. ' +
        'Respond ONLY with JSON: {"subject":str,"body":str}'
    },
    { role: 'user', content: `Telemetry since the last report:\n${JSON.stringify(snap, null, 1)}` }
  ], { maxTokens: 1500 }).catch(err => {
    console.error('devFeedbackReport failed:', err.message);
    return null;
  });
  if (result && result.subject) return result;
  // no key / API down → plain template, still useful
  return {
    subject: `JobPilot usage feedback (${snap.periodDays} days, anonymous)`,
    body:
      `Anonymous usage report — ${snap.periodDays} days\n\n` +
      `HOW IT WAS USED\n${JSON.stringify(snap, null, 1)}\n\n` +
      `(AI summary unavailable — raw numbers above. No personal data included.)`
  };
}

// ---------- Improvement report (auto feedback mechanism) ----------

async function insightsReport(profile, snap, trigger) {
  const result = await chatJSON([
    {
      role: 'system',
      content:
        'You are a job-search performance coach analyzing a candidate\'s application pipeline data. ' +
        'Find concrete gaps and give specific, actionable improvements. Be honest about what the data shows ' +
        'and does not show (small samples, simulated sends). ' +
        'Respond ONLY with JSON: {"subject":str,"body":str}. The body is a plain-text email with sections: ' +
        'SUMMARY (2 lines), WHAT\'S WORKING, GAPS FOUND, IMPROVEMENT POINTS (numbered, max 5, each concrete), ' +
        'TRY THIS NEXT BATCH (one experiment).'
    },
    {
      role: 'user',
      content:
        `Trigger: ${trigger}\nCandidate: ${JSON.stringify(profile)}\n\nPipeline data:\n${JSON.stringify(snap, null, 1)}`
    }
  ], { maxTokens: 2500 }).catch(err => {
    console.error('insightsReport failed:', err.message);
    return null;
  });
  if (result) return result;
  return {
    subject: `JobPilot improvement report (${trigger})`,
    body:
      `SUMMARY\nApplied: ${snap.applied}, replies: ${snap.replies} (${snap.replyRatePct}%), interviews: ${snap.interviews}.\n\n` +
      `IMPROVEMENT POINTS\n1. Add an AI key in Settings to get a real analysis of your pipeline.\n` +
      `2. ${snap.withRecruiterEmail < snap.applied ? `Only ${snap.withRecruiterEmail}/${snap.applied} applications had a recruiter email — add them so emails actually reach people.` : 'Keep recruiter emails filled in.'}\n` +
      `3. ${snap.avgMatchScoreApplied < 65 ? `Average match of applied jobs is ${snap.avgMatchScoreApplied}% — focus on 70%+ matches.` : 'Match quality looks healthy.'}\n\n(A rough read — the writer is not set up, so this is worked out from the numbers alone.)`
  };
}

module.exports = { hasKey, providerInfo, claudeCodeStatus, resetClaudeCodeProbe, extractJsonText, extractProfile, scoreJobs, tailorApplication, formatEmailBody, reviewTailored, classifyReply, followUpEmail, insightsReport, devFeedbackReport, PROVIDERS };

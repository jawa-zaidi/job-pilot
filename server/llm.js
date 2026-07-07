// LLM client — supports Groq and OpenAI (ChatGPT), selectable in Settings,
// with a model override and a user-editable custom system prompt that is
// injected into scoring / CV / email generation. Falls back to deterministic
// mock output when no API key is configured.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { load } = require('./db');
const P = require('./prompts'); // all quality-critical system prompts live in prompts.js

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
  }
};

function cfg() {
  const s = load().settings || {};
  const name = s.provider === 'openai' ? 'openai' : 'groq';
  const p = PROVIDERS[name];
  const key = (name === 'openai' ? s.openaiKey : s.groqKey) || process.env[p.envKey] || '';
  return { provider: name, label: p.label, url: p.url, key, model: (s.model || '').trim() || p.defaultModel };
}

function hasKey() { return !!cfg().key; }
function providerInfo() { const c = cfg(); return { provider: c.provider, model: c.model, hasKey: !!c.key }; }
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
  const system = { role: 'system', content: P.withUserInstructions(messages[0].content, custom) };
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
    body: JSON.stringify({
      model: c.model,
      messages: [system, ...messages.slice(1)],
      temperature: 0.4,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${c.label} API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.usage) {
    try {
      require('./costs').recordLLM(c.model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
    } catch { /* cost tracking is best-effort */ }
  }
  return data.choices[0].message.content;
}

async function chatJSON(messages, opts = {}) {
  const out = await chat(messages, { ...opts, json: true });
  if (out === null) return null;
  return JSON.parse(out);
}

// Turn provider errors into plain, actionable messages
function friendlyError(err) {
  const m = String(err.message || err);
  if (m.includes(' 429')) {
    const wait = m.match(/try again in ([\dhm.\s]+)/i);
    return new Error(`AI daily limit reached on the free tier. ${wait ? `Try again in ${wait[1].trim()}, or ` : ''}switch the model in Settings to "llama-3.1-8b-instant" (much higher limits), or add an OpenAI key.`);
  }
  if (m.includes(' 401') || m.includes(' 403')) return new Error('AI API key was rejected — check it in Settings.');
  return new Error(m.slice(0, 200));
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
        '{"name":str,"email":str,"title":str,"years_experience":num,"skills":[str],' +
        '"top_achievements":[str],"summary":str,"target_roles":[str]}'
    },
    { role: 'user', content: `Extract the profile from this CV:\n\n${cvText.slice(0, 12000)}` }
  ], {}, () => mockProfile(cvText));
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
    title: skills.length ? `${skills[0][0].toUpperCase() + skills[0].slice(1)} Professional` : 'Professional',
    years_experience: 3,
    skills: skills.length ? skills : ['communication', 'problem solving'],
    top_achievements: ['(mock mode — add an API key in Settings for real extraction)'],
    summary: 'Profile extracted in mock mode. Add a Groq or OpenAI key in Settings for full AI extraction.',
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
        : ['General fit (mock scoring — add an API key in Settings)']
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
    cv: `${profile.name}\n${profile.email}\n\nSUMMARY\nTailored for ${job.title} at ${job.company}.\n\nSKILLS\n${(profile.skills || []).join(', ')}\n\n(mock mode — add an API key in Settings for a real tailored CV)`,
    email_subject: `Application for ${job.title} — ${profile.name}`,
    email_body: `Dear ${job.company} team,\n\nI'm applying for the ${job.title} role. My background in ${(profile.skills || []).slice(0, 3).join(', ')} fits your requirements.\n\n(mock mode — add an API key in Settings for a fully tailored email)\n\nBest regards,\n${profile.name}`,
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
  ], { maxTokens: 4000 }).catch(err => {
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
    body: `Hi ${job.company} team,\n\nI wanted to follow up on my application for ${job.title} (day ${dayNumber}). I remain very interested in the role.\n\n(mock mode)\n\nBest,\n${profile.name}`
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
      `3. ${snap.avgMatchScoreApplied < 65 ? `Average match of applied jobs is ${snap.avgMatchScoreApplied}% — focus on 70%+ matches.` : 'Match quality looks healthy.'}\n\n(mock mode report)`
  };
}

module.exports = { hasKey, providerInfo, extractProfile, scoreJobs, tailorApplication, formatEmailBody, reviewTailored, classifyReply, followUpEmail, insightsReport, devFeedbackReport, PROVIDERS };

// LLM client — supports Groq and OpenAI (ChatGPT), selectable in Settings,
// with a model override and a user-editable custom system prompt that is
// injected into scoring / CV / email generation. Falls back to deterministic
// mock output when no API key is configured.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { load } = require('./db');

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
function customPrompt() { return (load().settings?.customPrompt || '').trim(); }

async function chat(messages, { json = false, maxTokens = 2048, useCustomPrompt = false } = {}) {
  const c = cfg();
  if (!c.key) return null;
  const extra = useCustomPrompt && customPrompt()
    ? [{ role: 'system', content: `Additional instructions from the user (always follow these):\n${customPrompt()}` }]
    : [];
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
    body: JSON.stringify({
      model: c.model,
      messages: [messages[0], ...extra, ...messages.slice(1)],
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
    {
      role: 'system',
      content:
        'You are a job-match scorer. Given a candidate profile and jobs, score each job 0-100 for fit ' +
        'and give 2-3 short reasons. Respond ONLY with JSON: {"scores":[{"id":str,"score":num,"reasons":[str]}]}'
    },
    {
      role: 'user',
      content: `Candidate profile:\n${JSON.stringify(profile)}\n\nJobs:\n${JSON.stringify(jobList)}`
    }
  ], { maxTokens: 3000, useCustomPrompt: true }).catch(err => {
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

async function tailorApplication(profile, cvText, job, feedback = '') {
  const userMsg =
    `Candidate profile:\n${JSON.stringify(profile)}\n\nOriginal CV text:\n${cvText.slice(0, 8000)}\n\n` +
    `Job: ${job.title} at ${job.company}\nDescription:\n${(job.description || '').slice(0, 4000)}` +
    (feedback && job.tailored ? `\n\nPrevious draft you must revise:\nEMAIL: ${job.tailored.email_body}\nCV: ${job.tailored.cv}` : '');
  const messages = [
    {
      role: 'system',
      content:
        'You are an expert CV writer and recruiter. Only claim experience actually present in the ' +
        "candidate's profile/CV — never invent skills or roles they don't have. Create an ATS-optimized CV " +
        '(plain text, clear section headers, quantified bullets, keywords mirrored from the job description) ' +
        'and a short, specific application email tailored to this exact job — reference the company and role, ' +
        "connect 2-3 of the candidate's real experiences to the job requirements. No placeholders like [Company]. " +
        'Respond ONLY with JSON: {"cv":str,"email_subject":str,"email_body":str,"keywords_used":[str]}'
    }
  ];
  // The user's revision request is the highest priority — put it up front and emphatic
  if (feedback) messages.push({
    role: 'system',
    content: `REVISION REQUEST (highest priority — you MUST follow this exactly, even over other guidance): ${feedback}`
  });
  messages.push({ role: 'user', content: userMsg });
  return strictJSON(messages, { maxTokens: 4000, useCustomPrompt: true }, () => ({
    cv: `${profile.name}\n${profile.email}\n\nSUMMARY\nTailored for ${job.title} at ${job.company}.\n\nSKILLS\n${(profile.skills || []).join(', ')}\n\n(mock mode — add an API key in Settings for a real tailored CV)`,
    email_subject: `Application for ${job.title} — ${profile.name}`,
    email_body: `Dear ${job.company} team,\n\nI'm applying for the ${job.title} role. My background in ${(profile.skills || []).slice(0, 3).join(', ')} fits your requirements.\n\n(mock mode — add an API key in Settings for a fully tailored email)\n\nBest regards,\n${profile.name}`,
    keywords_used: (profile.skills || []).slice(0, 5)
  }));
}

// ---------- Follow-up email ----------

async function followUpEmail(profile, job, dayNumber, previousEmails) {
  const result = await chatJSON([
    {
      role: 'system',
      content:
        'Write a brief, polite, value-adding follow-up email for a job application. Do not sound desperate; ' +
        'add one new relevant point about the candidate. ' +
        'Respond ONLY with JSON: {"subject":str,"body":str}'
    },
    {
      role: 'user',
      content:
        `Candidate: ${JSON.stringify(profile)}\nJob: ${job.title} at ${job.company}\n` +
        `This is the follow-up on day ${dayNumber} after applying. Previous emails sent: ${previousEmails.length}.`
    }
  ], { useCustomPrompt: true }).catch(err => {
    console.error('followUpEmail failed:', err.message);
    return null;
  });
  if (result) return result;
  return {
    subject: `Following up: ${job.title} application — ${profile.name}`,
    body: `Hi ${job.company} team,\n\nI wanted to follow up on my application for ${job.title} (day ${dayNumber}). I remain very interested in the role.\n\n(mock mode)\n\nBest,\n${profile.name}`
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
  ], { maxTokens: 2500, useCustomPrompt: true }).catch(err => {
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

module.exports = { hasKey, providerInfo, extractProfile, scoreJobs, tailorApplication, followUpEmail, insightsReport, PROVIDERS };

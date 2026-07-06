// Cost tracking. Two real cost drivers in JobPilot:
//   1. AI API  — Groq / OpenAI, priced per token (input + output).
//   2. Source API — Apify (LinkedIn, later Naukri), priced per job fetched.
// Free job boards (Remotive/RemoteOK/Arbeitnow) and Gmail sending cost nothing.
//
// Prices below are published rates as of mid-2026 and are editable in Settings
// (settings.prices). Everything here is an estimate shown for transparency.
const { load } = require('./db');

// USD per 1,000,000 tokens: [input, output]
const LLM_PRICES = {
  'llama-3.3-70b-versatile': [0.59, 0.79],
  'llama-3.1-8b-instant':    [0.05, 0.08],
  'llama-3.1-70b-versatile': [0.59, 0.79],
  'gpt-4o-mini':             [0.15, 0.60],
  'gpt-4o':                  [2.50, 10.00],
  'gpt-4.1-mini':            [0.40, 1.60]
};
const DEFAULT_LLM_PRICE = [0.60, 0.80];

// USD per job fetched from a paid source (free boards omitted = 0)
const SOURCE_PRICES = {
  LinkedIn: 0.008,   // Apify harvestapi pay-per-result (estimate)
  Naukri:   0.001
};

let charges = []; // in-memory ledger: {at, kind:'ai'|'source', label, usd, ...}

function llmPrice(model) {
  const custom = load().settings?.prices?.llm?.[model];
  return custom || LLM_PRICES[model] || DEFAULT_LLM_PRICE;
}
function sourcePrice(source) {
  const custom = load().settings?.prices?.source?.[source];
  return custom != null ? custom : (SOURCE_PRICES[source] || 0);
}

function bumpTotal(usd) {
  const db = load();
  db.settings.costTotalUSD = (db.settings.costTotalUSD || 0) + usd;
}

function recordLLM(model, inTok, outTok) {
  const [pi, po] = llmPrice(model);
  const usd = (inTok / 1e6) * pi + (outTok / 1e6) * po;
  charges.push({ at: Date.now(), kind: 'ai', label: model, usd, inTok, outTok });
  bumpTotal(usd);
  return usd;
}

function recordSource(source, count) {
  const per = sourcePrice(source);
  const usd = per * count;
  if (usd > 0) {
    charges.push({ at: Date.now(), kind: 'source', label: source, usd, count });
    bumpTotal(usd);
  }
  return usd;
}

// Bracket a run to measure just its cost
function beginRun() { return Date.now(); }
function endRun(since) {
  const items = charges.filter(c => c.at >= since);
  const usd = items.reduce((s, c) => s + c.usd, 0);
  const byLabel = {};
  for (const c of items) byLabel[c.label] = (byLabel[c.label] || 0) + c.usd;
  const ai = items.filter(c => c.kind === 'ai').reduce((s, c) => s + c.usd, 0);
  const source = items.filter(c => c.kind === 'source').reduce((s, c) => s + c.usd, 0);
  charges = charges.slice(-500); // keep ledger bounded
  return { usd, ai, source, byLabel, count: items.length };
}

function totals() {
  return { totalUSD: load().settings?.costTotalUSD || 0 };
}

function fmt(usd) {
  if (!usd) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(usd < 1 ? 3 : 2);
}

module.exports = { recordLLM, recordSource, beginRun, endRun, totals, fmt, LLM_PRICES, SOURCE_PRICES };

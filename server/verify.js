// Is this job still open?
//
// Two moments use this:
//  - discovery: before a new job is added to the board, drop adverts that have
//    clearly closed (a stated deadline that has passed, a 404/410, or a page
//    that says it is closed), so nobody spends an application on them;
//  - just before an application goes out (verifyJobLive), in case the job
//    closed since it was found.
// Both err on the side of "open": only a clear signal drops a job. A bot wall,
// a timeout or a page we cannot read keeps it.

const DEAD_STATUS = new Set([404, 410]);
// Phrases job boards/ATSs show on a closed posting. Deliberately exact: live
// adverts say things like "Once the position is filled, we will close the
// advert", which a looser pattern would wrongly read as closed.
const DEAD_PATTERNS = /no longer accepting applications|this (job|position|posting|vacancy|role|internship) (is no longer|has been) (available|active|filled|removed|closed)|this (job|position|posting|vacancy|role|internship) is closed|position has been filled|job (has )?expired|posting (is )?(closed|expired|removed)|applications (are|have) (now )?closed|vacature is gesloten|this job has closed|job posting is (no longer|not) available|this job is not available|the (job|position) you are looking for (is no longer available|no longer exists|has expired)/i;

// Machine-readable signals in the page source. Job sites mark postings for
// Google for Jobs with schema.org JobPosting data, whose validThrough is the
// date the advert ends; some also carry their own "expired": true flag (seen
// on SimplyHired, whose closed page otherwise still answers 200).
function structuredClosed(html, nowMs = Date.now()) {
  const src = String(html || '').slice(0, 600000);
  // An "expired" flag counts only when the page has no "expired": false as
  // well: a page listing several jobs would have both, and proves nothing.
  if (/"(?:is_?)?(?:job_?)?expired"\s*:\s*true/i.test(src) && !/"(?:is_?)?(?:job_?)?expired"\s*:\s*false/i.test(src)) {
    return 'the advert is marked as expired';
  }
  const ends = [];
  const blocks = src.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const type = [].concat(node['@type'] || []).join(' ');
    if (/JobPosting/i.test(type)) ends.push(node.validThrough || null);
    if (node['@graph']) walk(node['@graph']);
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b.replace(/^<script[^>]*>|<\/script>$/gi, ''))); } catch { /* not valid JSON: skip */ }
  }
  // One posting on the page, with an end date: the advert itself. A list of
  // postings is a search page and proves nothing about this job.
  if (ends.length !== 1 || !ends[0]) return null;
  let end = Date.parse(ends[0]);
  if (Number.isNaN(end)) return null;
  // A date with no time ("2026-11-19") means open through that whole day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(ends[0]).trim())) end += 86400000;
  // A whole extra day of grace, so time zones never close a job early.
  return nowMs > end + 86400000 ? `the advert ended on ${new Date(Date.parse(ends[0])).toISOString().slice(0, 10)}` : null;
}

// Page text without scripts, styles and tags, so a phrase that only lives in
// a hidden template or a script string can't mark a live job as closed.
function visibleText(html) {
  return String(html || '')
    .slice(0, 400000)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

// `reason` is shown to the person using JobPilot (in the message that appears
// when a send is stopped, and in the day's activity), so it is written as a
// short piece of plain English, never as a status code.
async function verifyJobLive(job, { timeoutMs = 12000 } = {}) {
  if (!job.url) return { live: true, reason: 'there was no advert to check' };
  try {
    const res = await fetch(job.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobPilot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (DEAD_STATUS.has(res.status)) return { live: false, reason: 'the advert has been taken down' };
    // Bot walls / rate limits (LinkedIn 999, Cloudflare 403/429) prove nothing
    if (!res.ok) return { live: true, reason: 'the site would not let us look' };
    const html = await res.text();
    if (DEAD_PATTERNS.test(visibleText(html))) {
      return { live: false, reason: 'the advert says the job has been filled or closed' };
    }
    const closed = structuredClosed(html);
    if (closed) return { live: false, reason: closed };
    return { live: true, reason: 'the advert is still up' };
  } catch (err) {
    return { live: true, reason: err.name === 'TimeoutError' ? 'the site did not answer in time' : 'we could not reach the site' };
  }
}

// ---------- Stated application deadlines ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DEADLINE_WORDS = /(deadline|closing date|apply by|apply before|applications? close[sd]?(?: on)?|closes on|last date(?: to apply)?)\s*(?:is|date)?\s*[:\-–]?\s*/gi;
// Only unambiguous dates with a year: "16 Nov 2026", "Nov 16, 2026",
// "2026-11-16". Slashed dates (dd/mm vs mm/dd) are skipped on purpose.
const DATE_FORMS = [
  [new RegExp(`^(?:[a-z]+,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON},?\\s+(\\d{4})`, 'i'), m => [m[3], m[2], m[1]]],
  [new RegExp(`^(?:[a-z]+,?\\s+)?${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i'), m => [m[3], m[1], m[2]]],
  [/^(\d{4})-(\d{2})-(\d{2})\b/, m => [m[1], MONTHS[Number(m[2]) - 1], m[3]]]
];

// The earliest application deadline stated in the text, as a Date (midnight
// UTC on that day), or null when there is none we can read for certain.
function statedDeadline(text) {
  const t = String(text || '');
  let earliest = null;
  DEADLINE_WORDS.lastIndex = 0;
  let k;
  while ((k = DEADLINE_WORDS.exec(t))) {
    const rest = t.slice(k.index + k[0].length, k.index + k[0].length + 40);
    for (const [re, parts] of DATE_FORMS) {
      const m = re.exec(rest);
      if (!m) continue;
      const [y, mon, d] = parts(m);
      const mi = MONTHS.indexOf(String(mon).toLowerCase().slice(0, 3));
      const year = Number(y), day = Number(d);
      if (mi < 0 || day < 1 || day > 31 || year < 2000 || year > 2100) break;
      const date = new Date(Date.UTC(year, mi, day));
      if (!earliest || date < earliest) earliest = date;
      break;
    }
  }
  return earliest;
}

// A whole extra day of grace, so time zones never close a job early.
function deadlinePassed(text, nowMs = Date.now()) {
  const d = statedDeadline(text);
  if (!d) return null;
  return nowMs > d.getTime() + 2 * 86400000 ? d : null;
}

// ---------- Discovery-time filter ----------

// Splits jobs into the ones to keep and the ones that have clearly closed,
// each dropped job with a plain-English reason. Page checks run a few at a
// time with a short timeout; anything uncertain is kept.
async function filterOpenJobs(jobs, { concurrency = 4, timeoutMs = 8000, checkPages = true } = {}) {
  const open = [];
  const dropped = [];
  const toCheck = [];
  for (const job of jobs) {
    const past = deadlinePassed(job.description);
    if (past) dropped.push({ job, reason: `its application deadline (${past.toISOString().slice(0, 10)}) has passed` });
    else toCheck.push(job);
  }
  if (!checkPages) return { open: toCheck, dropped };

  const verdicts = new Map();
  let next = 0;
  async function worker() {
    while (next < toCheck.length) {
      const job = toCheck[next++];
      verdicts.set(job, await verifyJobLive(job, { timeoutMs }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toCheck.length) }, worker));
  for (const job of toCheck) {
    const v = verdicts.get(job);
    if (v && !v.live) dropped.push({ job, reason: v.reason });
    else open.push(job);
  }
  return { open, dropped };
}

module.exports = { verifyJobLive, filterOpenJobs, statedDeadline, deadlinePassed, structuredClosed, DEAD_PATTERNS, visibleText };

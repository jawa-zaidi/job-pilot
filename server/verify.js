// Just-in-time liveness check: before an application goes out, re-fetch the
// posting URL and make sure the job wasn't closed/filled since discovery.
// Errs on the side of "live" — only a clear dead signal blocks the send.

const DEAD_STATUS = new Set([404, 410]);
// Phrases job boards/ATSs show on a closed posting
const DEAD_PATTERNS = /no longer accepting applications|this (job|position|posting) (is no longer|has been) (available|active|filled|removed|closed)|position has been filled|job (has )?expired|posting (is )?(closed|expired|removed)|vacature is gesloten|this job has closed/i;

async function verifyJobLive(job) {
  if (!job.url) return { live: true, reason: 'no URL to check' };
  try {
    const res = await fetch(job.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobPilot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (DEAD_STATUS.has(res.status)) return { live: false, reason: `posting returns HTTP ${res.status}` };
    // Bot walls / rate limits (LinkedIn 999, Cloudflare 403/429) prove nothing
    if (!res.ok) return { live: true, reason: `unverifiable (HTTP ${res.status})` };
    const text = (await res.text()).slice(0, 200000);
    if (DEAD_PATTERNS.test(text)) return { live: false, reason: 'posting page says it is closed/filled' };
    return { live: true, reason: 'posting still up' };
  } catch (err) {
    return { live: true, reason: `unverifiable (${err.name === 'TimeoutError' ? 'timeout' : err.message.slice(0, 60)})` };
  }
}

module.exports = { verifyJobLive };

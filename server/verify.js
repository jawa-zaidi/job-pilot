// Just-in-time liveness check: before an application goes out, re-fetch the
// posting URL and make sure the job wasn't closed/filled since discovery.
// Errs on the side of "live" — only a clear dead signal blocks the send.

const DEAD_STATUS = new Set([404, 410]);
// Phrases job boards/ATSs show on a closed posting
const DEAD_PATTERNS = /no longer accepting applications|this (job|position|posting) (is no longer|has been) (available|active|filled|removed|closed)|position has been filled|job (has )?expired|posting (is )?(closed|expired|removed)|vacature is gesloten|this job has closed/i;

// `reason` is shown to the person using JobPilot (in the message that appears
// when a send is stopped, and in the day's activity), so it is written as a
// short piece of plain English, never as a status code.
async function verifyJobLive(job) {
  if (!job.url) return { live: true, reason: 'there was no advert to check' };
  try {
    const res = await fetch(job.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobPilot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (DEAD_STATUS.has(res.status)) return { live: false, reason: 'the advert has been taken down' };
    // Bot walls / rate limits (LinkedIn 999, Cloudflare 403/429) prove nothing
    if (!res.ok) return { live: true, reason: 'the site would not let us look' };
    const text = (await res.text()).slice(0, 200000);
    if (DEAD_PATTERNS.test(text)) return { live: false, reason: 'the advert says the job has been filled or closed' };
    return { live: true, reason: 'the advert is still up' };
  } catch (err) {
    return { live: true, reason: err.name === 'TimeoutError' ? 'the site did not answer in time' : 'we could not reach the site' };
  }
}

module.exports = { verifyJobLive };

// Inbox sync: reads the user's Gmail inbox over IMAP (same app password as
// sending) and marks applications as "replied" when the recruiter has written
// back — the Sync Dashboard button calls this.
const { ImapFlow } = require('imapflow');
const { load, save, logActivity } = require('./db');

async function syncInbox() {
  const s = load().settings || {};
  if (!s.smtpUser || !s.smtpPass) {
    throw new Error('Add your Gmail address and app password in Settings first');
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: s.smtpUser, pass: s.smtpPass },
    logger: false
  });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Gmail rejected the sign-in for ${s.smtpUser}. Check the App Password in Settings (myaccount.google.com/apppasswords).`);
  }
  let checked = 0, repliesFound = 0;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const db = load();
      const candidates = db.applications.filter(a => a.appliedAt && a.recipientEmail && !a.replied);
      for (const a of candidates) {
        checked++;
        // search a day earlier than appliedAt to be safe with timezones/demo clock
        const since = new Date(Math.min(a.appliedAt, Date.now()) - 86400000);
        const uids = await client.search({ from: a.recipientEmail, since });
        if (uids && uids.length) {
          a.replied = { at: Date.now(), messages: uids.length };
          if (!['interview', 'offer', 'rejected'].includes(a.status)) a.status = 'replied';
          repliesFound++;
          logActivity(`Reply detected from ${a.recipientEmail} for ${a.title} at ${a.company} — moved to Potentials ⭐ (follow-ups stopped)`, 'reply');
        }
      }
      save();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { checked, repliesFound };
}

module.exports = { syncInbox };

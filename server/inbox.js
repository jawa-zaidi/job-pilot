// Inbox sync: reads the user's Gmail inbox over IMAP (same app password as
// sending) and matches company responses to applications on the board.
//
// Two passes:
//  1. Email-path applications — match by sender (we know the recruiter address).
//  2. Platform applications (LinkedIn/Naukri/career site, no known address) —
//     the company's response still lands in the inbox and names the company
//     and role, so we search by company name, let the AI confirm the mail is
//     about THIS application, and classify it. When the sender is a real
//     person (not a no-reply machine), we capture the address — upgrading the
//     card to the email path so follow-ups and tracking become automatic.
//
// Classification → board movement:
//   confirmation → noted (application received), follow-ups continue
//   rejection    → Closed (follow-ups stop — no nudging after a "no")
//   interview    → Interview ⭐
//   human_reply  → Replied ⭐ (follow-ups stop)
// Without an AI key, pass 1 falls back to the old behavior (any email =
// replied) and pass 2 is skipped (content matching needs the AI).
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { load, save, logActivity } = require('./db');
const llm = require('./llm');
const { isJunkContact } = require('./jobs');

const MANUAL_SCAN_APPS = 15;  // platform applications scanned per sync
const MANUAL_SCAN_MSGS = 3;   // newest matching messages fetched per application
const LLM_BUDGET = 10;        // classification calls per sync (rate-limit safety)

async function fetchParsed(client, uid) {
  try {
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    return await simpleParser(msg.source);
  } catch (err) {
    console.error('inbox fetch message failed:', err.message);
    return null;
  }
}

function parsedToText(parsed) {
  const sender = parsed.from?.value?.[0]?.address || '';
  const text = parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '';
  return `From: ${sender}\nSubject: ${parsed.subject || ''}\n\n${text}`.slice(0, 6000);
}

// Move the card according to the classification; returns which counter to bump
function applyClassification(a, cls, via) {
  if (cls.type === 'confirmation') {
    if (a.confirmed) return null;
    a.confirmed = { at: Date.now(), summary: cls.summary };
    logActivity(`✓ Application confirmed received — ${a.title} at ${a.company}${via ? ` (${via})` : ''}`, 'reply');
    return 'confirmations';
  }
  if (cls.type === 'rejection') {
    a.replied = { at: Date.now(), classified: 'rejection', summary: cls.summary };
    a.status = 'rejected';
    logActivity(`Rejection received for ${a.title} at ${a.company}${via ? ` (${via})` : ''} — closed (follow-ups stopped)`, 'reply');
    return 'rejections';
  }
  if (cls.type === 'interview') {
    a.replied = { at: Date.now(), classified: 'interview', summary: cls.summary };
    a.status = 'interview';
    logActivity(`🎉 Interview invitation for ${a.title} at ${a.company}${via ? ` (${via})` : ''}! ${cls.summary}`, 'reply');
    return 'interviews';
  }
  if (cls.type === 'human_reply') {
    a.replied = { at: Date.now(), classified: 'human_reply', summary: cls.summary };
    if (!['interview', 'offer', 'rejected'].includes(a.status)) a.status = 'replied';
    logActivity(`Reply received for ${a.title} at ${a.company}${via ? ` (${via})` : ''} — moved to Potentials ⭐`, 'reply');
    return 'repliesFound';
  }
  return null;
}

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

  const counts = { checked: 0, repliesFound: 0, rejections: 0, interviews: 0, confirmations: 0, contactsCaptured: 0 };
  let llmBudget = LLM_BUDGET;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const db = load();

      // ---- Pass 1: email-path applications (match by known sender) ----
      const emailPath = db.applications.filter(a => a.appliedAt && a.recipientEmail && !a.replied && a.status !== 'rejected');
      for (const a of emailPath) {
        counts.checked++;
        // search a day earlier than appliedAt to be safe with timezones
        const since = new Date(Math.min(a.appliedAt, Date.now()) - 86400000);
        const uids = await client.search({ from: a.recipientEmail, since }, { uid: true });
        if (!uids || !uids.length) continue;

        let cls = null;
        if (llm.hasKey() && llmBudget > 0) {
          const parsed = await fetchParsed(client, uids[uids.length - 1]);
          if (parsed) { llmBudget--; cls = await llm.classifyReply(a, parsedToText(parsed)); }
        }
        a.inboxSeen = uids.length;
        if (!cls) {
          // no AI available → old behavior: any email from them counts as a reply
          a.replied = { at: Date.now(), messages: uids.length };
          if (!['interview', 'offer', 'rejected'].includes(a.status)) a.status = 'replied';
          counts.repliesFound++;
          logActivity(`Reply detected from ${a.recipientEmail} for ${a.title} at ${a.company} — moved to Potentials ⭐ (follow-ups stopped)`, 'reply');
        } else {
          const bumped = applyClassification(a, cls, `from ${a.recipientEmail}`);
          if (bumped) counts[bumped]++;
        }
      }

      // ---- Pass 2: company/role-mention matching (AI-confirmed) ----
      // Catches replies that Pass 1's exact-sender match can't: platform
      // applications (no known address) AND email-path applications whose reply
      // came from a DIFFERENT address (ATS, a colleague, firstname.lastname@).
      // Pass 1 already set `replied` on anything it resolved, so the `!a.replied`
      // filter keeps those out of Pass 2 (no double-processing).
      if (llm.hasKey()) {
        const manual = db.applications
          .filter(a => a.appliedAt && !a.replied && !['rejected', 'closed'].includes(a.status))
          .slice(0, MANUAL_SCAN_APPS);
        for (const a of manual) {
          if (llmBudget <= 0) break;
          counts.checked++;
          const since = new Date(Math.min(a.appliedAt, Date.now()) - 86400000);
          let uids = [];
          try {
            uids = await client.search({ text: a.company, since }, { uid: true });
          } catch { continue; }
          if (!uids || !uids.length) continue;

          a.scannedUids = a.scannedUids || [];
          const fresh = uids.filter(u => !a.scannedUids.includes(u)).slice(-MANUAL_SCAN_MSGS);
          if (!fresh.length) continue;
          a.scannedUids = [...a.scannedUids, ...fresh].slice(-50);

          for (const uid of fresh.reverse()) { // newest first
            if (llmBudget <= 0) break;
            const parsed = await fetchParsed(client, uid);
            if (!parsed) continue;
            const sender = (parsed.from?.value?.[0]?.address || '').toLowerCase();
            if (sender && sender === String(s.smtpUser).toLowerCase()) continue; // own mail

            llmBudget--;
            const cls = await llm.classifyReply(a, parsedToText(parsed));
            if (!cls || !cls.related || cls.type === 'other') continue;

            // a real person's address (never a no-reply machine) upgrades the
            // card to the email path: follow-ups + reply tracking go automatic
            const replyTo = (parsed.replyTo?.value?.[0]?.address || '').toLowerCase();
            const contact = [replyTo, sender].find(e => e && !isJunkContact(e));
            if (contact && !a.recipientEmail) {
              a.recipientEmail = contact;
              a.applyPath = 'email';
              counts.contactsCaptured++;
              logActivity(`📎 Contact captured for ${a.title} at ${a.company}: ${contact} — follow-ups switch to automatic email`, 'reply');
            }
            const bumped = applyClassification(a, cls, 'matched by company mention');
            if (bumped) counts[bumped]++;
            break; // one classification per application per sync
          }
        }
      }
      save();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return counts;
}

module.exports = { syncInbox };

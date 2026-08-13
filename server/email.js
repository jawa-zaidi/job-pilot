// Real email sending via Gmail SMTP (nodemailer). Emails go from the user's
// own Gmail address + display name. Falls back to simulated mode when SMTP
// isn't configured or the application has no recipient email.
const nodemailer = require('nodemailer');
const { load } = require('./db');

function smtpSettings() {
  const s = load().settings || {};
  return s.smtpUser && s.smtpPass ? s : null;
}

function isConfigured() {
  return !!smtpSettings();
}

// attachments: nodemailer format, e.g. [{ filename: 'CV.pdf', content: buffer }]
async function sendEmail({ to, subject, body, attachments }) {
  const s = smtpSettings();
  if (!s || !to) return { simulated: true, to: to || null };

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: s.smtpUser, pass: s.smtpPass }
  });
  const from = s.fromName ? `"${s.fromName}" <${s.smtpUser}>` : s.smtpUser;
  try {
    await transporter.sendMail({ from, to, subject, text: body, ...(attachments?.length ? { attachments } : {}) });
  } catch (err) {
    if (String(err.message).includes('535') || err.code === 'EAUTH') {
      throw new Error(`Gmail rejected the sign-in for ${s.smtpUser}. Double-check in Settings: it must be an App Password (myaccount.google.com/apppasswords), not your normal password, and 2-Step Verification must be ON for that account.`);
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.code === 'ESOCKET') {
      console.error('Gmail unreachable:', err.code);
      throw new Error("We couldn't reach Gmail from this computer. Some networks — office or campus wifi especially — block sending mail. Try another network, or let JobPilot practise without really sending.");
    }
    console.error('Gmail send failed:', String(err.message || err).slice(0, 200));
    throw new Error("Gmail wouldn't take that one just now. Nothing is lost — try again in a moment.");
  }
  return { simulated: false, to };
}

module.exports = { isConfigured, sendEmail };

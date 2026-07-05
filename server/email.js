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

async function sendEmail({ to, subject, body }) {
  const s = smtpSettings();
  if (!s || !to) return { simulated: true, to: to || null };

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: s.smtpUser, pass: s.smtpPass }
  });
  const from = s.fromName ? `"${s.fromName}" <${s.smtpUser}>` : s.smtpUser;
  try {
    await transporter.sendMail({ from, to, subject, text: body });
  } catch (err) {
    if (String(err.message).includes('535') || err.code === 'EAUTH') {
      throw new Error(`Gmail rejected the sign-in for ${s.smtpUser}. Double-check in Settings: it must be an App Password (myaccount.google.com/apppasswords), not your normal password, and 2-Step Verification must be ON for that account.`);
    }
    throw err;
  }
  return { simulated: false, to };
}

module.exports = { isConfigured, sendEmail };

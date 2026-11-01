// Email: uses Resend's HTTP API when RESEND_API_KEY is set (no extra packages). Otherwise it logs, so nothing breaks in development.
const cfg = require('./config');
async function send(to, subject, text) {
  if (!to) return;
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log(`[mail:not sent, no RESEND_API_KEY] to=${to} subject="${subject}"`); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'Santiano <onboarding@resend.dev>', to: [to], subject, text }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) console.error('[mail] failed', res.status, (await res.text()).slice(0, 150));
  } catch (e) { console.error('[mail] error', e.message); }
}
module.exports = { send };

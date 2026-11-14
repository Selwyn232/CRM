'use strict';
// Echte e-mail via Brevo (https://www.brevo.com, EU-provider). Zonder sleutel worden e-mails alleen gelogd.
// Instellen: in het CRM (Instellingen → Integraties) of met BREVO_API_KEY, MAIL_FROM_EMAIL, MAIL_FROM_NAME.

const runtime = { apiKey: '', fromEmail: '', fromName: '' };
const base = () => (process.env.BREVO_API_BASE || 'https://api.brevo.com/v3').replace(/\/$/, '');
const key = () => (process.env.BREVO_API_KEY || '').trim() || runtime.apiKey;
const fromEmail = () => (process.env.MAIL_FROM_EMAIL || '').trim() || runtime.fromEmail;
const fromName = () => (process.env.MAIL_FROM_NAME || '').trim() || runtime.fromName || 'Robin Foundation';

function configure({ apiKey, fromEmail: fe, fromName: fn } = {}) {
  if (apiKey !== undefined) runtime.apiKey = String(apiKey || '').trim();
  if (fe !== undefined) runtime.fromEmail = String(fe || '').trim();
  if (fn !== undefined) runtime.fromName = String(fn || '').trim();
}

const isEnabled = () => !!key() && !!fromEmail();

function status() {
  return {
    enabled: isEnabled(),
    key_set: !!key(),
    key_hint: key() ? `…${key().slice(-4)}` : '',
    key_source: (process.env.BREVO_API_KEY || '').trim() ? 'render' : runtime.apiKey ? 'crm' : null,
    from_email: fromEmail(),
    from_name: fromName(),
  };
}

async function send({ to, subject, text }) {
  if (!isEnabled()) throw new Error('E-mail is niet ingesteld');
  const res = await fetch(`${base()}/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': key(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: fromEmail(), name: fromName() },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Brevo gaf fout ${res.status}`);
  return data.messageId || '';
}

module.exports = { configure, isEnabled, status, send };

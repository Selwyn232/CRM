'use strict';
// Betalingen via Mollie (iDEAL e.a.). Zonder sleutel blijft doneren gesimuleerd (demo).
// Instellen: in het CRM (Instellingen → Integraties) of met MOLLIE_API_KEY (test_… of live_…).
// Docs: https://docs.mollie.com/reference/create-payment

const runtime = { apiKey: '' };
const base = () => (process.env.MOLLIE_API_BASE || 'https://api.mollie.com/v2').replace(/\/$/, '');
const key = () => (process.env.MOLLIE_API_KEY || '').trim() || runtime.apiKey;

function configure({ apiKey } = {}) {
  if (apiKey !== undefined) runtime.apiKey = String(apiKey || '').trim();
}
const isEnabled = () => /^(test|live)_\w{20,}$/.test(key());
const mode = () => (key().startsWith('live_') ? 'live' : key().startsWith('test_') ? 'test' : null);

function status() {
  return {
    enabled: isEnabled(),
    mode: mode(),
    key_set: !!key(),
    key_hint: key() ? `…${key().slice(-4)}` : '',
    key_source: (process.env.MOLLIE_API_KEY || '').trim() ? 'render' : runtime.apiKey ? 'crm' : null,
  };
}

async function call(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/json', accept: 'application/hal+json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.title || `Mollie gaf fout ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const amount = (cents) => ({ currency: 'EUR', value: (cents / 100).toFixed(2) });
const INTERVALS = { maandelijks: '1 month', kwartaal: '3 months', jaarlijks: '12 months' };

module.exports = {
  configure, isEnabled, status, mode, INTERVALS,
  createCustomer: (name, email) => call('POST', '/customers', { name, email }),
  createPayment: ({ cents, description, redirectUrl, webhookUrl, metadata, customerId, sequenceType }) =>
    call('POST', '/payments', {
      amount: amount(cents), description, redirectUrl, webhookUrl, metadata, locale: 'nl_NL',
      ...(customerId ? { customerId } : {}), ...(sequenceType ? { sequenceType } : {}),
    }),
  getPayment: (id) => call('GET', `/payments/${encodeURIComponent(id)}`),
  createSubscription: (customerId, { cents, interval, description, webhookUrl, startDate, metadata }) =>
    call('POST', `/customers/${encodeURIComponent(customerId)}/subscriptions`, {
      amount: amount(cents), interval, description, webhookUrl, startDate, metadata,
    }),
  updateSubscription: (customerId, subId, { cents, description }) =>
    call('PATCH', `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subId)}`, {
      amount: amount(cents), ...(description ? { description } : {}),
    }),
  cancelSubscription: (customerId, subId) => call('DELETE', `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subId)}`),
  checkKey: () => call('GET', '/methods'),
};

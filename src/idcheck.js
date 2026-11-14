'use strict';
// Identiteitscontrole van de ouder/voogd via Veriff (paspoort/ID + gezichtsscan met live-detectie).
// Zonder sleutel werkt de onboarding in handmatige modus: foto van het ID + selfie, door een medewerker beoordeeld.
// Instellen: Instellingen → Integraties, of VERIFF_API_KEY + VERIFF_SECRET. Docs: https://developers.veriff.com

const crypto = require('node:crypto');

const runtime = { apiKey: '', secret: '' };
const base = () => (process.env.VERIFF_API_BASE || 'https://stationapi.veriff.com').replace(/\/$/, '');
const key = () => (process.env.VERIFF_API_KEY || '').trim() || runtime.apiKey;
const secret = () => (process.env.VERIFF_SECRET || '').trim() || runtime.secret;

function configure({ apiKey, secret: s } = {}) {
  if (apiKey !== undefined) runtime.apiKey = String(apiKey || '').trim();
  if (s !== undefined) runtime.secret = String(s || '').trim();
}
const isEnabled = () => !!(key() && secret());

function status() {
  return {
    enabled: isEnabled(),
    key_set: !!key(),
    secret_set: !!secret(),
    key_hint: key() ? `…${key().slice(-4)}` : '',
    key_source: (process.env.VERIFF_API_KEY || '').trim() ? 'render' : runtime.apiKey ? 'crm' : null,
  };
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('hex');

// Controleer de handtekening van een webhook van Veriff (HMAC-SHA256 over de ruwe body).
function verifySignature(raw, signature) {
  if (!isEnabled() || !raw || !signature) return false;
  const a = Buffer.from(sign(raw), 'hex');
  const b = Buffer.from(String(signature).trim().toLowerCase(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createSession({ firstName, lastName, vendorData, callback }) {
  const body = JSON.stringify({ verification: { callback, person: { firstName, lastName }, vendorData } });
  const res = await fetch(`${base()}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-client': key(), 'x-hmac-signature': sign(body) },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.verification) throw new Error(data.message || `Veriff gaf fout ${res.status}`);
  return { id: data.verification.id, url: data.verification.url };
}

// Veriff-beslissing omzetten naar onze status + een samenvatting zonder volledige documentnummers.
function mapDecision(v = {}) {
  const map = { approved: 'goedgekeurd', declined: 'afgewezen', resubmission_requested: 'opnieuw', expired: 'opnieuw', abandoned: 'opnieuw' };
  const doc = v.document || {};
  const num = String(doc.number || '');
  return {
    status: map[v.status] || 'in_behandeling',
    summary: {
      provider: 'Veriff', decision: v.status || '', reason: v.reason || '', code: v.code || null,
      document_type: doc.type || '', document_country: doc.country || '', document_last4: num ? num.slice(-4) : '',
      name: v.person ? [v.person.firstName, v.person.lastName].filter(Boolean).join(' ') : '',
      decided_at: v.decisionTime || new Date().toISOString(),
    },
  };
}

async function checkKey() {
  // Een sessie aanmaken is de enige betrouwbare test; die verloopt vanzelf als niemand hem opent.
  return createSession({ firstName: 'Test', lastName: 'Robin', vendorData: 'sleuteltest', callback: 'https://example.org' });
}

module.exports = { configure, isEnabled, status, verifySignature, createSession, mapDecision, checkKey, sign };

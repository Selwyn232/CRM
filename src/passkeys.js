'use strict';
// Inloggen met Face ID / vingerafdruk / Windows Hello via passkeys (WebAuthn).
// Het toestel bewaart de privésleutel en controleert het gezicht of de vinger; de server krijgt alleen een
// handtekening en kent alleen de publieke sleutel. Verificatie gebeurt met @simplewebauthn/server.

const crypto = require('node:crypto');
const { all, get, run } = require('./db');
const S = require('./services');
const { AppError } = S;

const KINDS = ['staff', 'donor', 'recipient'];
const HOMES = { staff: '/admin', donor: '/portal', recipient: '/ontvanger' };
const RP_NAME = 'Robin Foundation';
const lib = () => require('@simplewebauthn/server');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

// Domein en herkomst afleiden van het verzoek (achter Render's proxy: x-forwarded-*).
function relyingParty(ctx) {
  const host = String(ctx.req.headers['x-forwarded-host'] || ctx.req.headers.host || 'localhost').split(',')[0].trim();
  const proto = ctx.secure ? 'https' : 'http';
  return { rpID: host.replace(/:\d+$/, ''), origin: `${proto}://${host}` };
}

function deviceName(ua = '') {
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : 'Apparaat';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${dev} · ${br}` : dev;
}

function saveChallenge(db, purpose, challenge, kind = null, subjectId = null) {
  run(db, "DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')");
  const id = crypto.randomBytes(18).toString('base64url');
  run(db, "INSERT INTO webauthn_challenges (id, challenge, purpose, kind, subject_id, expires_at) VALUES (?,?,?,?,?, datetime('now', '+5 minutes'))",
    id, challenge, purpose, kind, subjectId);
  return id;
}
function takeChallenge(db, id, purpose) {
  const c = get(db, "SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = ? AND expires_at >= datetime('now')", String(id || ''), purpose);
  if (!c) throw new AppError(400, 'De Face ID-aanvraag is verlopen. Probeer het opnieuw.');
  run(db, 'DELETE FROM webauthn_challenges WHERE id = ?', c.id); // eenmalig
  return c;
}

// Wie is dit account, zoals het toestel het toont?
function accountInfo(db, kind, id) {
  if (kind === 'staff') { const u = get(db, 'SELECT email, name FROM users WHERE id = ?', id); return { name: u.email, display: u.name }; }
  if (kind === 'donor') { const d = get(db, 'SELECT * FROM donors WHERE id = ?', id); return { name: d.email || `donateur-${id}`, display: S.donorFullName(d) }; }
  const r = get(db, 'SELECT username, name FROM recipients WHERE id = ?', id);
  return { name: r.username || `ontvanger-${id}`, display: r.name };
}
// Mag dit account (nog) inloggen?
function accountActive(db, kind, id) {
  if (kind === 'staff') return !!get(db, 'SELECT 1 AS x FROM users WHERE id = ? AND active = 1', id);
  if (kind === 'donor') return !!get(db, 'SELECT 1 AS x FROM donors WHERE id = ?', id);
  return !!get(db, 'SELECT 1 AS x FROM recipients WHERE id = ? AND active = 1 AND username IS NOT NULL AND password_hash IS NOT NULL', id);
}

const list = (db, kind, id) => all(db, 'SELECT id, device_name, created_at, last_used_at FROM passkeys WHERE kind = ? AND subject_id = ? ORDER BY created_at', kind, id);

async function registrationOptions(db, ctx, kind, subjectId) {
  const { rpID } = relyingParty(ctx);
  const acc = accountInfo(db, kind, subjectId);
  const options = await lib().generateRegistrationOptions({
    rpName: RP_NAME, rpID,
    userID: new TextEncoder().encode(`${kind}-${subjectId}`),
    userName: acc.name, userDisplayName: acc.display || acc.name,
    attestationType: 'none',
    excludeCredentials: all(db, 'SELECT credential_id, transports FROM passkeys WHERE kind = ? AND subject_id = ?', kind, subjectId)
      .map((p) => ({ id: p.credential_id, transports: p.transports ? p.transports.split(',') : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return { challenge_id: saveChallenge(db, 'register', options.challenge, kind, subjectId), options };
}

async function verifyRegistration(db, ctx, kind, subjectId, body, actor) {
  const ch = takeChallenge(db, body.challenge_id, 'register');
  if (ch.kind !== kind || ch.subject_id !== subjectId) throw new AppError(400, 'Deze aanvraag hoort bij een ander account');
  const { rpID, origin } = relyingParty(ctx);
  let v;
  try {
    v = await lib().verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin,
      expectedRPID: rpID, requireUserVerification: true });
  } catch (err) { throw new AppError(400, `Face ID instellen is niet gelukt: ${err.message}`); }
  if (!v.verified || !v.registrationInfo) throw new AppError(400, 'Face ID instellen is niet gelukt');
  const cred = v.registrationInfo.credential;
  if (get(db, 'SELECT id FROM passkeys WHERE credential_id = ?', cred.id)) throw new AppError(409, 'Dit toestel is al gekoppeld');
  run(db, 'INSERT INTO passkeys (kind, subject_id, credential_id, public_key, counter, transports, device_name) VALUES (?,?,?,?,?,?,?)',
    kind, subjectId, cred.id, b64u(cred.publicKey), cred.counter || 0, (cred.transports || body.response.response?.transports || []).join(','),
    String(body.device_name || deviceName(ctx.req.headers['user-agent'])).slice(0, 60));
  S.audit(db, actor, 'passkey_toegevoegd', kind, subjectId);
  return list(db, kind, subjectId);
}

async function loginOptions(db, ctx) {
  const { rpID } = relyingParty(ctx);
  const options = await lib().generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  return { challenge_id: saveChallenge(db, 'login', options.challenge), options };
}

async function verifyLogin(db, ctx, body) {
  const ch = takeChallenge(db, body.challenge_id, 'login');
  const credId = body.response && body.response.id;
  const pk = credId && get(db, 'SELECT * FROM passkeys WHERE credential_id = ?', String(credId));
  if (!pk) throw new AppError(401, 'Dit toestel is (nog) niet gekoppeld. Log in met je wachtwoord en stel daarna Face ID in.');
  if (!accountActive(db, pk.kind, pk.subject_id)) throw new AppError(401, 'Dit account is niet (meer) actief');
  const { rpID, origin } = relyingParty(ctx);
  let v;
  try {
    v = await lib().verifyAuthenticationResponse({
      response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: fromB64u(pk.public_key), counter: pk.counter, transports: pk.transports ? pk.transports.split(',') : undefined },
    });
  } catch (err) { throw new AppError(401, `Inloggen met Face ID is niet gelukt: ${err.message}`); }
  if (!v.verified) throw new AppError(401, 'Inloggen met Face ID is niet gelukt');
  run(db, "UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?", v.authenticationInfo.newCounter, pk.id);
  return { kind: pk.kind, subject_id: pk.subject_id, home: HOMES[pk.kind] };
}

function remove(db, kind, subjectId, passkeyId, actor) {
  const r = run(db, 'DELETE FROM passkeys WHERE id = ? AND kind = ? AND subject_id = ?', passkeyId, kind, subjectId);
  if (!r.changes) throw new AppError(404, 'Niet gevonden');
  S.audit(db, actor, 'passkey_verwijderd', kind, subjectId);
  return list(db, kind, subjectId);
}

module.exports = { KINDS, HOMES, list, registrationOptions, verifyRegistration, loginOptions, verifyLogin, remove, deviceName, relyingParty };

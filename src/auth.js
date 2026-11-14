'use strict';
const crypto = require('node:crypto');
const { get, run } = require('./db');

const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function createSession(db, kind, subjectId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run(db, 'INSERT INTO sessions (token, kind, subject_id, expires_at) VALUES (?,?,?,?)', token, kind, subjectId, expires);
  run(db, 'DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  return token;
}

function getSession(db, token) {
  if (!token) return null;
  const s = get(db, 'SELECT * FROM sessions WHERE token = ?', token);
  if (!s || s.expires_at < new Date().toISOString()) return null;
  return s;
}

function destroySession(db, token) {
  if (token) run(db, 'DELETE FROM sessions WHERE token = ?', token);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(name, token, secure) {
  const maxAge = token ? SESSION_DAYS * 86400 : 0;
  return `${name}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

module.exports = { hashPassword, verifyPassword, createSession, getSession, destroySession, parseCookies, sessionCookie };

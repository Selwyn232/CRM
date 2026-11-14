'use strict';
// Alle API-routes. Elke route: [methode, pad, handler, guard].

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, get, run, tx } = require('./db');
const auth = require('./auth');
const S = require('./services');
const SP = require('./sponsoring');
const { AppError } = S;

const STAFF_COOKIE = 'rf_staff';
const DONOR_COOKIE = 'rf_donor';
const RECIPIENT_COOKIE = 'rf_recipient';
const UPLOAD_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.pdf']);

const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'Ongeldig id');
  return n;
};
const ROLES = ['admin', 'medewerker', 'veldmedewerker'];
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function csv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    // Voorkom formule-injectie in Excel.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.map((c) => c[1]).join(';')];
  for (const r of rows) lines.push(columns.map(([k, , fmt]) => esc(fmt ? fmt(r[k], r) : r[k])).join(';'));
  return '﻿' + lines.join('\r\n');
}
const csvResponse = (name, body) => ({
  __raw: true, body,
  headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` },
});
const centsToEuro = (c) => ((c || 0) / 100).toFixed(2).replace('.', ',');

const DONOR_FIELDS = ['donor_type', 'first_name', 'last_name', 'company_name', 'email', 'phone', 'street',
  'postal_code', 'city', 'country', 'status', 'source', 'tags', 'notes', 'anonymous', 'display_name',
  'newsletter', 'preferred_channel', 'language'];

function cleanDonor(body, { partial = false } = {}) {
  const out = {};
  for (const f of DONOR_FIELDS) {
    if (body[f] === undefined) continue;
    if (f === 'anonymous' || f === 'newsletter') out[f] = bool(body[f]);
    else if (f === 'email') out[f] = str(body[f], 200).toLowerCase() || null;
    else out[f] = str(body[f], f === 'notes' ? 10000 : 300);
  }
  if (out.email && !isEmail(out.email)) throw new AppError(400, 'Ongeldig e-mailadres');
  if (out.donor_type && !['particulier', 'bedrijf', 'stichting'].includes(out.donor_type)) throw new AppError(400, 'Ongeldig type');
  if (out.status && !['prospect', 'actief', 'inactief'].includes(out.status)) throw new AppError(400, 'Ongeldige status');
  if (out.language !== undefined && !require('./translate').LANGUAGES[out.language]) throw new AppError(400, 'Onbekende taal');
  if (!partial && !out.first_name && !out.last_name && !out.company_name) throw new AppError(400, 'Naam is verplicht');
  return out;
}

function publicDonor(d) {
  if (!d) return d;
  const { password_hash, ...rest } = d;
  return { ...rest, has_portal: !!password_hash, full_name: S.donorFullName(d), public_name: S.donorPublicName(d) };
}

function publicRecipient(r) {
  if (!r) return r;
  const { password_hash, ...rest } = r;
  return { ...rest, has_login: !!(r.username && password_hash), chat_moderated: S.isModerated(r) ? 1 : 0,
    language_effective: require('./translate').recipientLanguage(r) };
}

function annualStatement(db, donorId, year) {
  const donor = get(db, 'SELECT * FROM donors WHERE id = ?', donorId);
  if (!donor) throw new AppError(404, 'Donateur niet gevonden');
  const y = /^\d{4}$/.test(String(year)) ? String(year) : String(new Date().getFullYear());
  const donations = all(db, `SELECT dn.*, c.name AS category_name FROM donations dn JOIN categories c ON c.key = dn.category_key
    WHERE dn.donor_id = ? AND dn.status = 'ontvangen' AND strftime('%Y', dn.received_at) = ? ORDER BY dn.received_at`, donorId, y);
  const spent = get(db, `SELECT COALESCE(SUM(a.amount_cents),0) AS s FROM allocations a JOIN expenditures e ON e.id = a.expenditure_id
    WHERE a.donor_id = ? AND strftime('%Y', e.spent_at) = ?`, donorId, y).s;
  return {
    year: y,
    donor: publicDonor(donor),
    donations,
    total_cents: donations.reduce((s, d) => s + d.amount_cents, 0),
    spent_in_year_cents: spent,
    organisation: {
      name: 'Stichting Robin Foundation',
      anbi: 'ANBI-geregistreerd',
      rsin: process.env.CRM_RSIN || '000000000',
    },
  };
}

function donorJourney(db, donorId) {
  const rows = all(db, `
    SELECT a.id AS allocation_id, a.amount_cents, a.cell_id, e.id AS expenditure_id, e.spent_at, e.description,
      e.units, e.amount_cents AS expenditure_total_cents, c.key AS category_key, c.name AS category_name, c.icon,
      c.color, c.unit_label, c.unit_label_plural, c.unit_cost_cents,
      r.id AS recipient_id, r.name AS recipient_name, r.kind AS recipient_kind, r.age AS recipient_age,
      r.location AS recipient_location, r.country AS recipient_country, r.school AS recipient_school,
      CASE WHEN r.consent = 1 THEN r.story ELSE '' END AS recipient_story,
      CASE WHEN r.consent = 1 THEN r.photo_url ELSE '' END AS recipient_photo,
      dn.received_at AS donated_at, dn.amount_cents AS donation_cents
    FROM allocations a
    JOIN expenditures e ON e.id = a.expenditure_id
    JOIN categories c ON c.key = e.category_key
    JOIN cells ce ON ce.id = a.cell_id
    JOIN donations dn ON dn.id = ce.donation_id
    LEFT JOIN recipients r ON r.id = e.recipient_id
    WHERE a.donor_id = ? ORDER BY e.spent_at DESC, a.id DESC`, donorId);
  const msgs = all(db, `SELECT im.*, dm.id AS inbox_id, dm.read_at FROM donor_messages dm
    JOIN impact_messages im ON im.id = dm.impact_message_id WHERE dm.donor_id = ?`, donorId);
  for (const r of rows) {
    r.messages = msgs.filter((m) => m.expenditure_id === r.expenditure_id);
    r.share = r.amount_cents / r.expenditure_total_cents;
  }
  return rows;
}

function buildRoutes({ db, uploadDir }) {
  // ------------------------------------------------------------ betalingen
  const publicBase = (ctx) => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL
    || `${ctx.secure ? 'https' : 'http'}://${ctx.req.headers.host}`).replace(/\/$/, '');

  let sponsor = null;
  async function handlePayment(pay) {
    if (await sponsor.handleSponsorPayment(pay)) return;
    const P = require('./payments');
    const paid = pay.status === 'paid';
    const failed = ['failed', 'canceled', 'expired'].includes(pay.status);
    let donation = get(db, 'SELECT * FROM donations WHERE external_id = ?', pay.id);

    // Vervolgbetaling van een abonnement: nieuwe donatie aanmaken.
    if (!donation && pay.subscriptionId) {
      const first = get(db, 'SELECT * FROM donations WHERE subscription_id = ? ORDER BY id LIMIT 1', pay.subscriptionId);
      if (!first || !paid) return;
      const d = S.createDonation(db, {
        donor_id: first.donor_id, category_key: first.category_key, amount_cents: Math.round(Number(pay.amount.value) * 100),
        frequency: first.frequency, method: 'incasso', campaign_id: first.campaign_id, reference: pay.id,
      }, 'mollie');
      run(db, 'UPDATE donations SET external_id = ?, subscription_id = ? WHERE id = ?', pay.id, pay.subscriptionId, d.id);
      return;
    }
    if (!donation) return;
    if (paid && donation.status === 'in_afwachting') {
      S.updateDonation(db, donation.id, { status: 'ontvangen', method: pay.method || 'online' }, 'mollie');
      const donor = get(db, 'SELECT * FROM donors WHERE id = ?', donation.donor_id);
      const cat = S.getCategory(db, donation.category_key);
      S.sendMail(db, donor, `Bedankt voor je donatie van ${S.euro(donation.amount_cents)}!`,
        `Beste ${donor.first_name || S.donorFullName(donor)},\n\nHartelijk dank voor je donatie van ${S.euro(donation.amount_cents)} voor "${cat.name}". `
        + 'Je geld staat veilig in een eigen cel tot het wordt uitgegeven. Zodra dat gebeurt, ontvang je een bericht van degene die ermee geholpen is.\n\nRobin Foundation', 'bedankt');
      // Eerste betaling van een periodieke gift: abonnement starten.
      if (donation.frequency !== 'eenmalig' && pay.customerId && !donation.subscription_id && P.INTERVALS[donation.frequency]) {
        const start = new Date();
        start.setMonth(start.getMonth() + ({ maandelijks: 1, kwartaal: 3, jaarlijks: 12 })[donation.frequency]);
        try {
          const sub = await P.createSubscription(pay.customerId, {
            cents: donation.amount_cents, interval: P.INTERVALS[donation.frequency],
            description: `Robin Foundation – ${cat.name} (${donation.frequency}) #${donation.id}`,
            webhookUrl: pay.webhookUrl, startDate: start.toISOString().slice(0, 10), metadata: { donation_id: donation.id },
          });
          run(db, 'UPDATE donations SET subscription_id = ? WHERE id = ?', sub.id, donation.id);
        } catch (err) { S.audit(db, 'mollie', 'abonnement_mislukt', 'donation', donation.id, err.message); }
      }
    } else if (failed && donation.status === 'in_afwachting') {
      S.updateDonation(db, donation.id, { status: 'geannuleerd', note: `Betaling ${pay.status}` }, 'mollie');
    }
  }

  // ------------------------------------------------------------ wachtwoorden & demo
  const WEAK = ['robin', 'veld', 'admin123', 'medewerker123', 'welkom123', 'wachtwoord', 'password', '12345678', 'robinfoundation'];
  const isWeakStored = (hash) => WEAK.some((w) => auth.verifyPassword(w, hash));
  function checkStrongPassword(pw, login = '') {
    const p = String(pw || '');
    if (p.length < 10) throw new AppError(400, 'Kies een wachtwoord van minimaal 10 tekens');
    if (WEAK.includes(p.toLowerCase()) || (login && p.toLowerCase().includes(String(login).split('@')[0].toLowerCase()))) {
      throw new AppError(400, 'Dit wachtwoord is te makkelijk te raden. Kies iets unieks, bijvoorbeeld een zin van een paar woorden.');
    }
  }
  // Demomodus zolang er nog demo-accounts of voorbeelddonateurs in de database staan.
  const isDemo = () => !!(get(db, "SELECT 1 AS x FROM users WHERE email IN ('robin', 'veld', 'admin@robinfoundation.org', 'medewerker@robinfoundation.org') LIMIT 1")
    || get(db, "SELECT 1 AS x FROM donors WHERE email LIKE '%@example.nl' LIMIT 1"));
  // Vertaalinstellingen die in het CRM zijn ingevoerd laden.
  const setting = (k) => (get(db, 'SELECT value FROM settings WHERE key = ?', k) || {}).value || '';
  require('./translate').configure({ apiKey: setting('translate_api_key'), model: setting('translate_model'), workspace: setting('translate_workspace') });
  require('./payments').configure({ apiKey: setting('mollie_api_key') });
  require('./idcheck').configure({ apiKey: setting('veriff_api_key'), secret: setting('veriff_secret') });
  require('./mailer').configure({ apiKey: setting('mail_api_key'), fromEmail: setting('mail_from_email'), fromName: setting('mail_from_name') });
  // Chatmoderatie: standaard UIT tijdens de testfase (zet aan in Instellingen of met CRM_CHAT_MODERATION=aan).
  // Chatmoderatie staat standaard AAN (kinderen). Eenmalig na de testfase weer aanzetten.
  if (!setting('chat_moderation_reset_v1')) {
    for (const [k, v] of [['chat_moderation', 'aan'], ['chat_moderation_reset_v1', '1']]) {
      run(db, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, k, v);
    }
  }
  // Sponsormodel: in een demo-omgeving zonder kinderen eenmalig voorbeeldgezinnen en -kinderen toevoegen om mee te testen.
  if (!setting('sponsor_demo_v1') && isDemo() && !get(db, 'SELECT 1 AS x FROM children LIMIT 1')) {
    try {
      const admin = get(db, 'SELECT id FROM users ORDER BY id LIMIT 1');
      require('./seed').seedSponsoring(db, { donorIds: all(db, 'SELECT id FROM donors ORDER BY id').map((d) => d.id), adminId: admin ? admin.id : null,
        portalHash: auth.hashPassword('welkom123') });
    } catch (err) { console.error('Voorbeeldkinderen toevoegen mislukt:', err.message); }
    run(db, "INSERT INTO settings (key, value) VALUES ('sponsor_demo_v1', '1') ON CONFLICT(key) DO NOTHING");
  }
  // Demokinderen: tekeningen vervangen door foto's van Filipijnse kinderen (eenmalig).
  if (!setting('demo_photos_v1')) {
    const { demoPhoto } = require('./seed');
    all(db, "SELECT id, gender FROM children WHERE photo_url LIKE '/img/kind_.svg' ORDER BY id")
      .forEach((c, i) => run(db, 'UPDATE children SET photo_url = ? WHERE id = ?', demoPhoto(c.gender, i), c.id));
    run(db, "INSERT INTO settings (key, value) VALUES ('demo_photos_v1', '1') ON CONFLICT(key) DO NOTHING");
  }
  // Onboarding: in een demo-omgeving eenmalig een veldmedewerker (veld / veld) om het vier-ogenprincipe te testen.
  if (!setting('veld_demo_v1') && isDemo() && !get(db, "SELECT 1 AS x FROM users WHERE role = 'veldmedewerker'")) {
    run(db, "INSERT OR IGNORE INTO users (email, name, role, password_hash) VALUES ('veld', 'Joy Veldwerker', 'veldmedewerker', ?)", auth.hashPassword('veld'));
    run(db, "INSERT INTO settings (key, value) VALUES ('veld_demo_v1', '1') ON CONFLICT(key) DO NOTHING");
  }
  S.setModeration(setting('chat_moderation') ? setting('chat_moderation') === 'aan' : process.env.CRM_CHAT_MODERATION !== 'uit');
  // ------------------------------------------------------------ guards
  // Iedere ingelogde medewerker, ook veldmedewerkers (alleen voor eigen account en onboarding).
  const field = (ctx) => {
    const s = auth.getSession(db, ctx.cookies[STAFF_COOKIE]);
    if (!s || s.kind !== 'staff') throw new AppError(401, 'Niet ingelogd');
    const user = get(db, 'SELECT id, email, name, role, active FROM users WHERE id = ?', s.subject_id);
    if (!user || !user.active) throw new AppError(401, 'Niet ingelogd');
    ctx.user = user;
    ctx.actor = `medewerker:${user.email}`;
  };
  // Kantoormedewerkers en beheerders: veldmedewerkers hebben geen toegang tot donateurs, betalingen e.d.
  const staff = (ctx) => {
    field(ctx);
    if (ctx.user.role === 'veldmedewerker') throw new AppError(403, 'Veldmedewerkers hebben alleen toegang tot onboarding');
  };
  const admin = (ctx) => {
    staff(ctx);
    if (ctx.user.role !== 'admin') throw new AppError(403, 'Alleen beheerders hebben toegang');
  };
  const donor = (ctx) => {
    const s = auth.getSession(db, ctx.cookies[DONOR_COOKIE]);
    if (!s || s.kind !== 'donor') throw new AppError(401, 'Niet ingelogd');
    const d = get(db, 'SELECT * FROM donors WHERE id = ?', s.subject_id);
    if (!d) throw new AppError(401, 'Niet ingelogd');
    ctx.donor = d;
    ctx.actor = `donateur:${d.id}`;
    readOnlyIfImpersonating(ctx, s);
  };

  const recipient = (ctx) => {
    const s = auth.getSession(db, ctx.cookies[RECIPIENT_COOKIE]);
    if (!s || s.kind !== 'recipient') throw new AppError(401, 'Niet ingelogd');
    const r = get(db, 'SELECT * FROM recipients WHERE id = ?', s.subject_id);
    if (!r || !r.active || (!r.password_hash && !s.impersonator_id)) throw new AppError(401, 'Niet ingelogd');
    ctx.recipient = r;
    ctx.actor = `ontvanger:${r.id}`;
    readOnlyIfImpersonating(ctx, s);
  };

  // "Inloggen als": beheerder handelt namens de donateur/ontvanger. Alles mag, maar in het
  // audit log staat wie het echt deed.
  function readOnlyIfImpersonating(ctx, s) {
    if (!s.impersonator_id) return;
    const u = get(db, 'SELECT id, name, email, role, active FROM users WHERE id = ?', s.impersonator_id);
    if (!u || !u.active || u.role !== 'admin') throw new AppError(401, 'Sessie "inloggen als" is verlopen');
    ctx.impersonator = u;
    ctx.actor = `medewerker:${u.email} als ${ctx.actor}`;
    // Alleen meekijken: een medewerker kan niets doen namens een donateur of ontvanger (bv. niet chatten met een kind).
    if (ctx.req.method !== 'GET') throw new AppError(403, `Je kijkt mee als medewerker (alleen-lezen). Je kunt niets doen namens deze persoon.`);
  }
  const meWith = (ctx, obj) => (ctx.impersonator ? { ...obj, impersonated_by: ctx.impersonator.name } : obj);

  const impersonate = (ctx, kind, subjectId, cookie, url) => {
    setCookie(ctx, cookie, auth.createSession(db, kind, subjectId, ctx.user.id));
    S.audit(db, ctx.actor, 'ingelogd_als', kind === 'donor' ? 'donor' : 'recipient', subjectId);
    return { url };
  };

  // Donateurs die een ontvanger hebben gesteund, zoals de ontvanger ze mag zien (anoniem blijft anoniem).
  const supportersOf = (recipientId) => {
    let anon = 0;
    return all(db, `SELECT d.id, d.anonymous, d.display_name, d.first_name, d.last_name, d.company_name, d.donor_type,
        COALESCE((SELECT 'Sponsor van ' || GROUP_CONCAT(ch.first_name, ', ') FROM sponsorships s JOIN children ch ON ch.id = s.child_id
          WHERE s.donor_id = d.id AND ch.family_id = ? AND s.status <> 'beeindigd'), '') AS categories,
        COALESCE((SELECT MIN(s.started_at) FROM sponsorships s JOIN children ch ON ch.id = s.child_id WHERE s.donor_id = d.id AND ch.family_id = ?),
          (SELECT MIN(e.spent_at) FROM allocations a JOIN expenditures e ON e.id = a.expenditure_id WHERE a.donor_id = d.id AND e.recipient_id = ?)) AS since,
        (SELECT body FROM chat_messages m WHERE m.donor_id = d.id AND m.recipient_id = ? AND (m.status='goedgekeurd' OR m.sender='recipient')
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
        (SELECT MAX(created_at) FROM chat_messages m WHERE m.donor_id = d.id AND m.recipient_id = ?) AS last_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.donor_id = d.id AND m.recipient_id = ? AND m.sender='donor'
          AND m.status='goedgekeurd' AND m.read_at IS NULL) AS unread
      FROM donors d WHERE d.id IN (SELECT a.donor_id FROM allocations a JOIN expenditures e ON e.id = a.expenditure_id WHERE e.recipient_id = ?)
        OR d.id IN (SELECT s.donor_id FROM sponsorships s JOIN children ch ON ch.id = s.child_id WHERE ch.family_id = ? AND s.status <> 'beeindigd')
      ORDER BY last_at IS NULL, last_at DESC, d.id`, recipientId, recipientId, recipientId, recipientId, recipientId, recipientId, recipientId, recipientId)
      .map((d) => ({
        id: d.id,
        name: d.anonymous ? `Anonieme donateur ${++anon}` : S.donorPublicName(d),
        anonymous: !!d.anonymous,
        categories: d.categories || '', since: d.since, last_message: d.last_message, last_at: d.last_at, unread: d.unread,
      }));
  };

  const setCookie = (ctx, name, token) => { ctx.headers = { 'Set-Cookie': auth.sessionCookie(name, token, ctx.secure) }; };

  const categories = () => all(db, 'SELECT * FROM categories ORDER BY sort_order');
  sponsor = require('./api-sponsor').buildSponsorRoutes({ db, guards: { staff, admin, donor, recipient }, publicBase });
  const onboardingRoutes = require('./api-onboarding').buildOnboardingRoutes({ db, uploadDir, guards: { field, staff, admin }, publicBase });

  return [
    ...sponsor.routes,
    ...onboardingRoutes,
    // ================================================================ PUBLIEK
    ['GET', '/api/public/translation', () => {
      const T = require('./translate');
      return { enabled: T.isEnabled(), languages: T.LANGUAGES };
    }],
    ['GET', '/api/public/categories', () => categories().filter((c) => c.active)],
    ['GET', '/api/public/stats', () => {
      const t = get(db, `SELECT
        COALESCE((SELECT SUM(amount_cents) FROM donations WHERE status='ontvangen'),0) AS raised_cents,
        COALESCE((SELECT SUM(amount_cents) FROM expenditures),0) AS spent_cents,
        COALESCE((SELECT SUM(remaining_cents) FROM cells),0) AS waiting_cents,
        (SELECT COUNT(DISTINCT donor_id) FROM donations WHERE status='ontvangen') AS donors,
        (SELECT COUNT(*) FROM impact_messages) AS messages`);
      return { ...t, categories: S.categoryBalances(db).map(({ key, name, icon, color, unit_label_plural, received_cents, spent_cents, units_spent }) =>
        ({ key, name, icon, color, unit_label_plural, received_cents, spent_cents, units_spent })) };
    }],

    // ================================================================ AUTH MEDEWERKERS
    ['POST', '/api/staff/login', (ctx) => {
      const user = get(db, 'SELECT * FROM users WHERE email = ? AND active = 1', str(ctx.body.email));
      if (!user || !auth.verifyPassword(ctx.body.password || '', user.password_hash)) {
        throw new AppError(401, 'Onjuist e-mailadres of wachtwoord');
      }
      setCookie(ctx, STAFF_COOKIE, auth.createSession(db, 'staff', user.id));
      S.audit(db, `medewerker:${user.email}`, 'ingelogd', 'user', user.id);
      return { id: user.id, name: user.name, email: user.email, role: user.role };
    }],
    ['POST', '/api/staff/logout', (ctx) => {
      auth.destroySession(db, ctx.cookies[STAFF_COOKIE]);
      setCookie(ctx, STAFF_COOKIE, '');
    }],
    ['GET', '/api/staff/me', (ctx) => {
      const u = get(db, 'SELECT password_hash, nav_prefs FROM users WHERE id = ?', ctx.user.id);
      let nav = null;
      try { nav = u.nav_prefs ? JSON.parse(u.nav_prefs) : null; } catch { nav = null; }
      return { ...ctx.user, weak_password: isWeakStored(u.password_hash), nav };
    }, field],
    // Eigen menuvolgorde: [{ group: 'Naam', items: ['donateurs', ...] }, ...]; null = standaard.
    ['PUT', '/api/staff/preferences/nav', (ctx) => {
      const nav = ctx.body.nav;
      if (nav === null) { run(db, "UPDATE users SET nav_prefs = '' WHERE id = ?", ctx.user.id); return { nav: null }; }
      if (!Array.isArray(nav) || nav.length > 20) throw new AppError(400, 'Ongeldige menuvolgorde');
      const seen = new Set();
      const clean = nav.map((g) => {
        if (!g || !Array.isArray(g.items) || g.items.length > 50) throw new AppError(400, 'Ongeldige menuvolgorde');
        return {
          group: str(g.group, 40),
          items: g.items.filter((r) => typeof r === 'string' && /^[a-z]{2,30}$/.test(r) && !seen.has(r) && seen.add(r)),
        };
      });
      run(db, 'UPDATE users SET nav_prefs = ? WHERE id = ?', JSON.stringify(clean), ctx.user.id);
      return { nav: clean };
    }, field],
    ['POST', '/api/staff/password', (ctx) => {
      const u = get(db, 'SELECT * FROM users WHERE id = ?', ctx.user.id);
      if (!auth.verifyPassword(ctx.body.current || '', u.password_hash)) throw new AppError(400, 'Je huidige wachtwoord klopt niet');
      checkStrongPassword(ctx.body.password, u.email);
      run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(ctx.body.password), u.id);
      // Andere sessies van deze gebruiker afmelden
      run(db, "DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ? AND token <> ?", u.id, ctx.cookies[STAFF_COOKIE] || '');
      S.audit(db, ctx.actor, 'eigen_wachtwoord_gewijzigd', 'user', u.id);
    }, field],
    ['GET', '/api/public/config', () => ({ demo: isDemo(), payments: require('./payments').isEnabled(), payments_mode: require('./payments').mode() })],

    // ================================================================ AUTH DONATEURS
    ['POST', '/api/donor/login', (ctx) => {
      const d = get(db, 'SELECT * FROM donors WHERE email = ?', str(ctx.body.email).toLowerCase());
      if (!d || !auth.verifyPassword(ctx.body.password || '', d.password_hash)) {
        throw new AppError(401, 'Onjuist e-mailadres of wachtwoord');
      }
      run(db, "UPDATE donors SET last_login_at = datetime('now') WHERE id = ?", d.id);
      setCookie(ctx, DONOR_COOKIE, auth.createSession(db, 'donor', d.id));
      return publicDonor(d);
    }],
    ['POST', '/api/donor/register', (ctx) => {
      const b = ctx.body;
      const email = str(b.email, 200).toLowerCase();
      if (!isEmail(email)) throw new AppError(400, 'Vul een geldig e-mailadres in');
      if (!b.password || String(b.password).length < 8) throw new AppError(400, 'Wachtwoord moet minimaal 8 tekens zijn');
      if (!str(b.first_name)) throw new AppError(400, 'Voornaam is verplicht');
      if (b.privacy !== true && b.privacy !== 'true' && b.privacy !== 'on') throw new AppError(400, 'Ga akkoord met de privacyverklaring om een account aan te maken');
      const existing = get(db, 'SELECT * FROM donors WHERE email = ?', email);
      if (existing && existing.password_hash) throw new AppError(409, 'Er bestaat al een account met dit e-mailadres');
      if (existing) {
        // Bekende donateur zonder portaal: zonder e-mailverificatie kunnen we niet bewijzen dat dit
        // dezelfde persoon is. Een medewerker stuurt daarom een uitnodiging vanuit het CRM.
        throw new AppError(409, 'Dit e-mailadres is al bij ons bekend. Neem contact op met Robin Foundation; we sturen je dan een uitnodiging voor het portaal.');
      }
      const r = run(db, `INSERT INTO donors (first_name, last_name, email, anonymous, display_name, status, source, password_hash, newsletter)
        VALUES (?,?,?,?,?, 'prospect', 'portaal', ?, ?)`,
        str(b.first_name), str(b.last_name), email, b.show_on_leaderboard ? 0 : 1, str(b.display_name),
        auth.hashPassword(b.password), bool(b.newsletter));
      const donorId = Number(r.lastInsertRowid);
      S.audit(db, `donateur:${donorId}`, 'portaal_geregistreerd', 'donor', donorId);
      setCookie(ctx, DONOR_COOKIE, auth.createSession(db, 'donor', donorId));
      return publicDonor(get(db, 'SELECT * FROM donors WHERE id = ?', donorId));
    }],
    ['POST', '/api/donor/logout', (ctx) => {
      auth.destroySession(db, ctx.cookies[DONOR_COOKIE]);
      setCookie(ctx, DONOR_COOKIE, '');
    }],
    ['GET', '/api/donor/me', (ctx) => meWith(ctx, publicDonor(ctx.donor)), donor],

    // ================================================================ DONATEURSPORTAAL
    ['GET', '/api/portal/overview', (ctx) => {
      const d = ctx.donor;
      const impact = S.donorImpact(db, d.id);
      const board = SP.leaderboard(db, { limit: 500 });
      const kids = get(db, `SELECT COUNT(*) AS children, COALESCE(SUM(monthly_cents),0) AS monthly_cents FROM sponsorships
        WHERE donor_id = ? AND status <> 'beeindigd'`, d.id);
      const months = get(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS cents FROM sponsor_months WHERE donor_id = ?', d.id);
      const me = board.find((r) => r.donor_id === d.id);
      const unread = get(db, 'SELECT COUNT(*) AS n FROM donor_messages WHERE donor_id = ? AND read_at IS NULL', d.id).n;
      const recipients = get(db, `SELECT COUNT(DISTINCT e.recipient_id) AS n FROM allocations a
        JOIN expenditures e ON e.id = a.expenditure_id WHERE a.donor_id = ? AND e.recipient_id IS NOT NULL`, d.id).n;
      return {
        donor: publicDonor(d),
        impact,
        totals: {
          donated_cents: impact.reduce((s, r) => s + r.donated_cents, 0),
          waiting_cents: impact.reduce((s, r) => s + r.waiting_cents, 0),
          spent_cents: impact.reduce((s, r) => s + r.spent_cents, 0),
          recipients,
        },
        sponsor: { children: kids.children, monthly_cents: kids.monthly_cents, months: months.n, sponsored_cents: months.cents,
          unread_updates: get(db, 'SELECT COUNT(*) AS n FROM child_updates WHERE donor_id = ? AND read_at IS NULL', d.id).n },
        rank: me ? me.rank : null,
        ranked_donors: board.length,
        unread,
      };
    }, donor],
    ['GET', '/api/portal/donations', (ctx) => all(db, `
      SELECT dn.*, c.name AS category_name, c.icon, ce.id AS cell_id, ce.remaining_cents, ce.status AS cell_status
      FROM donations dn JOIN categories c ON c.key = dn.category_key LEFT JOIN cells ce ON ce.donation_id = dn.id
      WHERE dn.donor_id = ? ORDER BY dn.received_at DESC, dn.id DESC`, ctx.donor.id), donor],
    ['GET', '/api/portal/journey', (ctx) => donorJourney(db, ctx.donor.id), donor],
    ['GET', '/api/portal/messages', (ctx) => all(db, `
      SELECT dm.id, dm.read_at, dm.delivered_at, im.type, im.title, im.body, im.media_url, im.created_at,
        e.spent_at, e.description AS expenditure_description, c.name AS category_name, c.icon,
        r.name AS recipient_name, r.location AS recipient_location, r.country AS recipient_country,
        CASE WHEN r.consent = 1 THEN r.photo_url ELSE '' END AS recipient_photo,
        (SELECT SUM(a.amount_cents) FROM allocations a WHERE a.expenditure_id = e.id AND a.donor_id = dm.donor_id) AS my_share_cents
      FROM donor_messages dm JOIN impact_messages im ON im.id = dm.impact_message_id
      JOIN expenditures e ON e.id = im.expenditure_id JOIN categories c ON c.key = e.category_key
      LEFT JOIN recipients r ON r.id = im.recipient_id
      WHERE dm.donor_id = ? ORDER BY dm.delivered_at DESC, dm.id DESC`, ctx.donor.id), donor],
    ['POST', '/api/portal/messages/:id/read', (ctx) => {
      run(db, "UPDATE donor_messages SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND donor_id = ?",
        id(ctx.params.id), ctx.donor.id);
    }, donor],
    ['GET', '/api/portal/donations/:id', (ctx) => {
      const d = get(db, `SELECT dn.id, dn.status, dn.amount_cents, dn.frequency, dn.category_key, c.name AS category_name
        FROM donations dn JOIN categories c ON c.key = dn.category_key WHERE dn.id = ? AND dn.donor_id = ?`, id(ctx.params.id), ctx.donor.id);
      if (!d) throw new AppError(404, 'Donatie niet gevonden');
      return d;
    }, donor],
    // Mollie meldt een statuswijziging. We vertrouwen de inhoud niet en halen de betaling zelf op.
    ['POST', '/api/webhooks/mollie', async (ctx) => {
      const P = require('./payments');
      const payId = String(ctx.body.id || '');
      if (!P.isEnabled() || !/^tr_\w+$/.test(payId)) return { ok: true };
      const pay = await P.getPayment(payId);
      await handlePayment(pay);
      return { ok: true };
    }],
    ['PUT', '/api/portal/profile', (ctx) => {
      const allowed = ['first_name', 'last_name', 'phone', 'street', 'postal_code', 'city', 'country',
        'anonymous', 'display_name', 'newsletter', 'preferred_channel', 'language'];
      const data = cleanDonor(Object.fromEntries(allowed.filter((k) => k in ctx.body).map((k) => [k, ctx.body[k]])), { partial: true });
      const keys = Object.keys(data);
      if (keys.length) {
        run(db, `UPDATE donors SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
          ...keys.map((k) => data[k]), ctx.donor.id);
        S.audit(db, ctx.actor, 'profiel_gewijzigd', 'donor', ctx.donor.id, keys.join(','));
      }
      return publicDonor(get(db, 'SELECT * FROM donors WHERE id = ?', ctx.donor.id));
    }, donor],
    ['PUT', '/api/portal/language', (ctx) => {
      const T = require('./translate');
      if (!T.LANGUAGES[ctx.body.language]) throw new AppError(400, 'Onbekende taal');
      run(db, 'UPDATE donors SET language = ? WHERE id = ?', ctx.body.language, ctx.donor.id);
      return { language: ctx.body.language };
    }, donor],
    ['POST', '/api/portal/password', (ctx) => {
      if (!auth.verifyPassword(ctx.body.current || '', ctx.donor.password_hash)) throw new AppError(400, 'Huidig wachtwoord klopt niet');
      if (!ctx.body.password || String(ctx.body.password).length < 8) throw new AppError(400, 'Nieuw wachtwoord moet minimaal 8 tekens zijn');
      run(db, 'UPDATE donors SET password_hash = ? WHERE id = ?', auth.hashPassword(ctx.body.password), ctx.donor.id);
    }, donor],
    ['GET', '/api/portal/leaderboard', (ctx) => SP.leaderboard(db, ctx.query)
      .map(({ donor_id, ...rest }) => ({ ...rest, is_me: donor_id === ctx.donor.id })), donor],
    ['GET', '/api/portal/annual', (ctx) => annualStatement(db, ctx.donor.id, ctx.query.year), donor],
    ['GET', '/api/portal/campaigns', () => all(db, `SELECT cp.*,
      COALESCE((SELECT SUM(amount_cents) FROM donations WHERE campaign_id = cp.id AND status='ontvangen'),0) AS raised_cents
      FROM campaigns cp WHERE active = 1 AND (end_date IS NULL OR end_date >= date('now')) ORDER BY id DESC`), donor],
    ['GET', '/api/portal/categories', () => categories().filter((c) => c.active), donor],

    // ================================================================ DONATEURSPORTAAL: CHAT
    ['GET', '/api/portal/conversations', (ctx) => all(db, `SELECT r.id, r.name, r.kind, r.age, r.location, r.country, r.chat_moderated,
        (r.username IS NOT NULL AND r.password_hash IS NOT NULL) AS has_login,
        CASE WHEN r.consent = 1 THEN r.photo_url ELSE '' END AS photo_url,
        (SELECT body FROM chat_messages m WHERE m.recipient_id = r.id AND m.donor_id = ? AND (m.status='goedgekeurd' OR m.sender='donor')
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
        (SELECT MAX(created_at) FROM chat_messages m WHERE m.recipient_id = r.id AND m.donor_id = ?) AS last_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.recipient_id = r.id AND m.donor_id = ? AND m.sender='recipient'
          AND m.status='goedgekeurd' AND m.read_at IS NULL) AS unread
      FROM recipients r
      WHERE r.active = 1 AND r.chat_enabled = 1
        AND (r.id IN (SELECT e.recipient_id FROM allocations a JOIN expenditures e ON e.id = a.expenditure_id WHERE a.donor_id = ?)
          OR r.id IN (SELECT ch.family_id FROM sponsorships s JOIN children ch ON ch.id = s.child_id WHERE s.donor_id = ? AND s.status <> 'beeindigd'))
      ORDER BY last_at IS NULL, last_at DESC, r.name`, ctx.donor.id, ctx.donor.id, ctx.donor.id, ctx.donor.id, ctx.donor.id)
      .map((r) => ({ ...r, chat_moderated: S.isModerated(r) ? 1 : 0 })), donor],
    ['GET', '/api/portal/conversations/:id', async (ctx) => {
      const rid = id(ctx.params.id);
      if (!S.hasFunded(db, ctx.donor.id, rid)) throw new AppError(403, 'Je kunt alleen chatten met wie je hebt gesteund');
      const T = require('./translate');
      const r = get(db, 'SELECT * FROM recipients WHERE id = ?', rid);
      const mine = T.donorLanguage(ctx.donor);
      const res = await S.withTranslations(db, S.chatThread(db, rid, ctx.donor.id, 'donor', !ctx.impersonator), mine);
      return { ...res, my_language: mine, their_language: T.recipientLanguage(r), translation_enabled: T.isEnabled() };
    }, donor],
    ['POST', '/api/portal/conversations/:id', (ctx) => S.sendChat(db,
      { recipientId: id(ctx.params.id), donorId: ctx.donor.id, sender: 'donor', body: ctx.body.body }, ctx.actor), donor],

    // ================================================================ ONTVANGERSPORTAAL
    ['POST', '/api/recipient/login', (ctx) => {
      const r = get(db, 'SELECT * FROM recipients WHERE username = ? AND active = 1', str(ctx.body.username, 100));
      if (!r || !auth.verifyPassword(ctx.body.password || '', r.password_hash)) throw new AppError(401, 'Onjuiste gebruikersnaam of wachtwoord');
      run(db, "UPDATE recipients SET last_login_at = datetime('now') WHERE id = ?", r.id);
      setCookie(ctx, RECIPIENT_COOKIE, auth.createSession(db, 'recipient', r.id));
      return publicRecipient(r);
    }],
    ['POST', '/api/recipient/logout', (ctx) => {
      auth.destroySession(db, ctx.cookies[RECIPIENT_COOKIE]);
      setCookie(ctx, RECIPIENT_COOKIE, '');
    }],
    ['GET', '/api/recipient/me', (ctx) => meWith(ctx, { ...publicRecipient(ctx.recipient), language: require('./translate').recipientLanguage(ctx.recipient) }), recipient],
    ['GET', '/api/recipient/supporters', (ctx) => {
      if (!ctx.recipient.chat_enabled) return [];
      return supportersOf(ctx.recipient.id);
    }, recipient],
    ['GET', '/api/recipient/supporters/:id', async (ctx) => {
      const did = id(ctx.params.id);
      if (!S.hasFunded(db, did, ctx.recipient.id)) throw new AppError(403, 'Deze donateur heeft jou (nog) niet gesteund');
      const T = require('./translate');
      const d = get(db, 'SELECT * FROM donors WHERE id = ?', did);
      const mine = T.recipientLanguage(ctx.recipient);
      const res = await S.withTranslations(db, S.chatThread(db, ctx.recipient.id, did, 'recipient', !ctx.impersonator), mine);
      return { ...res, my_language: mine, their_language: T.donorLanguage(d), translation_enabled: T.isEnabled() };
    }, recipient],
    ['POST', '/api/recipient/supporters/:id', (ctx) => S.sendChat(db,
      { recipientId: ctx.recipient.id, donorId: id(ctx.params.id), sender: 'recipient', body: ctx.body.body }, ctx.actor), recipient],
    ['PUT', '/api/recipient/language', (ctx) => {
      const T = require('./translate');
      if (!T.LANGUAGES[ctx.body.language]) throw new AppError(400, 'Onbekende taal');
      run(db, 'UPDATE recipients SET language = ? WHERE id = ?', ctx.body.language, ctx.recipient.id);
      return { language: ctx.body.language };
    }, recipient],
    ['POST', '/api/recipient/password', (ctx) => {
      if (!auth.verifyPassword(ctx.body.current || '', ctx.recipient.password_hash)) throw new AppError(400, 'Huidig wachtwoord klopt niet');
      if (!ctx.body.password || String(ctx.body.password).length < 8) throw new AppError(400, 'Nieuw wachtwoord moet minimaal 8 tekens zijn');
      run(db, 'UPDATE recipients SET password_hash = ? WHERE id = ?', auth.hashPassword(ctx.body.password), ctx.recipient.id);
    }, recipient],

    // ================================================================ BEHEER: CHATMODERATIE
    ['GET', '/api/admin/chat', (ctx) => {
      const status = ['in_behandeling', 'goedgekeurd', 'afgewezen'].includes(ctx.query.status) ? ctx.query.status : null;
      return all(db, `SELECT m.*, r.name AS recipient_name, r.kind AS recipient_kind, r.managed_by,
          d.first_name, d.last_name, d.company_name, d.donor_type, u.name AS reviewed_by_name
        FROM chat_messages m JOIN recipients r ON r.id = m.recipient_id JOIN donors d ON d.id = m.donor_id
        LEFT JOIN users u ON u.id = m.reviewed_by
        ${status ? 'WHERE m.status = ?' : ''} ORDER BY ${status === 'in_behandeling' ? 'm.created_at ASC' : 'm.created_at DESC'}, m.id LIMIT 500`,
        ...(status ? [status] : [])).map((m) => ({ ...m, donor_name: S.donorFullName(m) }));
    }, staff],
    ['GET', '/api/admin/chat/thread', (ctx) => all(db, `SELECT m.*, u.name AS reviewed_by_name FROM chat_messages m
      LEFT JOIN users u ON u.id = m.reviewed_by WHERE m.recipient_id = ? AND m.donor_id = ? ORDER BY m.created_at, m.id`,
      id(ctx.query.recipient_id), id(ctx.query.donor_id)), staff],
    ['POST', '/api/admin/chat/:id/approve', (ctx) => S.moderateChat(db, id(ctx.params.id), true, '', ctx.user), staff],
    ['POST', '/api/admin/chat/:id/reject', (ctx) => S.moderateChat(db, id(ctx.params.id), false, ctx.body.reason, ctx.user), staff],

    // ================================================================ BEHEER: DASHBOARD
    ['GET', '/api/admin/dashboard', () => {
      const totals = get(db, `SELECT
        COALESCE((SELECT SUM(amount_cents) FROM donations WHERE status='ontvangen'),0) AS raised_cents,
        COALESCE((SELECT SUM(amount_cents) FROM donations WHERE status='ontvangen' AND received_at >= date('now','start of year')),0) AS raised_ytd_cents,
        COALESCE((SELECT SUM(amount_cents) FROM donations WHERE status='in_afwachting'),0) AS pending_cents,
        COALESCE((SELECT SUM(remaining_cents) FROM cells),0) AS waiting_cents,
        COALESCE((SELECT SUM(amount_cents) FROM expenditures),0) AS spent_cents,
        (SELECT COUNT(*) FROM donors) AS donors,
        (SELECT COUNT(*) FROM donors WHERE status='actief') AS active_donors,
        (SELECT COUNT(*) FROM donors WHERE created_at >= date('now','-30 days')) AS new_donors_30d,
        (SELECT COUNT(DISTINCT donor_id) FROM donations WHERE frequency <> 'eenmalig' AND status='ontvangen') AS recurring_donors,
        (SELECT COUNT(*) FROM cells WHERE remaining_cents > 0) AS open_cells,
        (SELECT COUNT(*) FROM expenditures e WHERE NOT EXISTS (SELECT 1 FROM impact_messages im WHERE im.expenditure_id = e.id)) AS expenditures_without_message,
        (SELECT COUNT(*) FROM tasks WHERE status='open') AS open_tasks,
        (SELECT COUNT(*) FROM tasks WHERE status='open' AND due_date < date('now')) AS overdue_tasks,
        (SELECT COUNT(*) FROM chat_messages WHERE status='in_behandeling') AS pending_chats`);
      const monthly = all(db, `SELECT strftime('%Y-%m', received_at) AS month, SUM(amount_cents) AS cents, COUNT(*) AS n
        FROM donations WHERE status='ontvangen' AND received_at >= date('now','start of month','-11 months')
        GROUP BY month ORDER BY month`);
      const monthlySpent = all(db, `SELECT strftime('%Y-%m', spent_at) AS month, SUM(amount_cents) AS cents
        FROM expenditures WHERE spent_at >= date('now','start of month','-11 months') GROUP BY month`);
      const recent = all(db, `SELECT dn.*, c.name AS category_name, c.icon, d.first_name, d.last_name, d.company_name, d.donor_type
        FROM donations dn JOIN donors d ON d.id = dn.donor_id JOIN categories c ON c.key = dn.category_key
        ORDER BY dn.received_at DESC, dn.id DESC LIMIT 8`).map((r) => ({ ...r, donor_name: S.donorFullName(r) }));
      const tasks = all(db, `SELECT t.*, d.first_name, d.last_name, d.company_name, d.donor_type FROM tasks t
        LEFT JOIN donors d ON d.id = t.donor_id WHERE t.status='open' ORDER BY t.due_date IS NULL, t.due_date LIMIT 8`)
        .map((t) => ({ ...t, donor_name: t.donor_id ? S.donorFullName(t) : '' }));
      const oldestCells = all(db, `SELECT ce.*, c.name AS category_name, c.icon, d.first_name, d.last_name, d.company_name, d.donor_type,
          CAST(julianday('now') - julianday(ce.created_at) AS INTEGER) AS age_days
        FROM cells ce JOIN categories c ON c.key = ce.category_key JOIN donors d ON d.id = ce.donor_id
        WHERE ce.remaining_cents > 0 ORDER BY ce.created_at LIMIT 6`).map((r) => ({ ...r, donor_name: S.donorFullName(r) }));
      return { totals, monthly, monthlySpent, recent, tasks, oldestCells, categories: S.categoryBalances(db) };
    }, staff],

    // ================================================================ BEHEER: DONATEURS
    ['GET', '/api/admin/donors', (ctx) => {
      const { q = '', status = '', tag = '', type = '', sort = 'name' } = ctx.query;
      const where = ['1=1'];
      const params = [];
      if (q) {
        where.push(`(d.first_name || ' ' || d.last_name LIKE ? OR d.company_name LIKE ? OR d.email LIKE ? OR d.city LIKE ? OR d.phone LIKE ?)`);
        const like = `%${q}%`;
        params.push(like, like, like, like, like);
      }
      if (status) { where.push('d.status = ?'); params.push(status); }
      if (type) { where.push('d.donor_type = ?'); params.push(type); }
      if (tag) { where.push("(',' || REPLACE(d.tags, ' ', '') || ',') LIKE ?"); params.push(`%,${tag.replace(/\s/g, '')},%`); }
      const order = {
        name: 'd.last_name COLLATE NOCASE, d.first_name COLLATE NOCASE, d.company_name COLLATE NOCASE',
        total: 'total_cents DESC', recent: 'last_donation DESC', created: 'd.created_at DESC',
      }[sort] || 'd.last_name';
      return all(db, `SELECT d.*,
          COALESCE((SELECT SUM(amount_cents) FROM donations WHERE donor_id=d.id AND status='ontvangen'),0) AS total_cents,
          COALESCE((SELECT SUM(remaining_cents) FROM cells WHERE donor_id=d.id),0) AS waiting_cents,
          (SELECT COUNT(*) FROM donations WHERE donor_id=d.id AND status='ontvangen') AS donation_count,
          (SELECT MAX(received_at) FROM donations WHERE donor_id=d.id AND status='ontvangen') AS last_donation,
          (SELECT COUNT(*) FROM donations WHERE donor_id=d.id AND frequency<>'eenmalig' AND status='ontvangen') AS recurring
        FROM donors d WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 1000`, ...params).map(publicDonor);
    }, staff],
    ['GET', '/api/admin/donors/export', () => {
      const rows = all(db, `SELECT d.*,
        COALESCE((SELECT SUM(amount_cents) FROM donations WHERE donor_id=d.id AND status='ontvangen'),0) AS total_cents
        FROM donors d ORDER BY d.last_name`);
      return csvResponse('donateurs.csv', csv(rows, [
        ['id', 'ID'], ['donor_type', 'Type'], ['first_name', 'Voornaam'], ['last_name', 'Achternaam'],
        ['company_name', 'Organisatie'], ['email', 'E-mail'], ['phone', 'Telefoon'], ['street', 'Adres'],
        ['postal_code', 'Postcode'], ['city', 'Plaats'], ['country', 'Land'], ['status', 'Status'], ['tags', 'Tags'],
        ['source', 'Bron'], ['anonymous', 'Anoniem', (v) => (v ? 'ja' : 'nee')], ['newsletter', 'Nieuwsbrief', (v) => (v ? 'ja' : 'nee')],
        ['total_cents', 'Totaal gedoneerd (EUR)', centsToEuro], ['created_at', 'Aangemaakt'],
      ]));
    }, staff],
    ['POST', '/api/admin/donors', (ctx) => {
      const data = cleanDonor(ctx.body);
      if (data.email && get(db, 'SELECT id FROM donors WHERE email = ?', data.email)) throw new AppError(409, 'E-mailadres is al in gebruik');
      const keys = Object.keys(data);
      const r = run(db, `INSERT INTO donors (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => data[k]));
      const newId = Number(r.lastInsertRowid);
      S.audit(db, ctx.actor, 'donateur_aangemaakt', 'donor', newId);
      return publicDonor(get(db, 'SELECT * FROM donors WHERE id = ?', newId));
    }, staff],
    ['GET', '/api/admin/donors/:id', (ctx) => {
      const donorId = id(ctx.params.id);
      const d = get(db, 'SELECT * FROM donors WHERE id = ?', donorId);
      if (!d) throw new AppError(404, 'Donateur niet gevonden');
      return {
        donor: publicDonor(d),
        impact: S.donorImpact(db, donorId),
        donations: all(db, `SELECT dn.*, c.name AS category_name, c.icon, cp.name AS campaign_name, ce.id AS cell_id,
            ce.remaining_cents, ce.status AS cell_status
          FROM donations dn JOIN categories c ON c.key = dn.category_key LEFT JOIN campaigns cp ON cp.id = dn.campaign_id
          LEFT JOIN cells ce ON ce.donation_id = dn.id WHERE dn.donor_id = ? ORDER BY dn.received_at DESC, dn.id DESC`, donorId),
        journey: donorJourney(db, donorId),
        interactions: all(db, `SELECT i.*, u.name AS user_name FROM interactions i LEFT JOIN users u ON u.id = i.user_id
          WHERE i.donor_id = ? ORDER BY i.occurred_at DESC, i.id DESC`, donorId),
        tasks: all(db, `SELECT t.*, u.name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
          WHERE t.donor_id = ? ORDER BY t.status, t.due_date`, donorId),
        emails: all(db, 'SELECT * FROM outbox WHERE donor_id = ? ORDER BY id DESC LIMIT 50', donorId),
        rank: (SP.leaderboard(db, { limit: 500 }).find((r) => r.donor_id === donorId) || {}).rank || null,
      };
    }, staff],
    ['PUT', '/api/admin/donors/:id', (ctx) => {
      const donorId = id(ctx.params.id);
      if (!get(db, 'SELECT id FROM donors WHERE id = ?', donorId)) throw new AppError(404, 'Donateur niet gevonden');
      const data = cleanDonor(ctx.body, { partial: true });
      if (data.email && get(db, 'SELECT id FROM donors WHERE email = ? AND id <> ?', data.email, donorId)) {
        throw new AppError(409, 'E-mailadres is al in gebruik');
      }
      const keys = Object.keys(data);
      if (keys.length) {
        run(db, `UPDATE donors SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
          ...keys.map((k) => data[k]), donorId);
        S.audit(db, ctx.actor, 'donateur_gewijzigd', 'donor', donorId, keys.join(','));
      }
      return publicDonor(get(db, 'SELECT * FROM donors WHERE id = ?', donorId));
    }, staff],
    ['DELETE', '/api/admin/donors/:id', (ctx) => {
      const donorId = id(ctx.params.id);
      if (get(db, 'SELECT id FROM allocations WHERE donor_id = ? LIMIT 1', donorId)) {
        throw new AppError(409, 'Deze donateur heeft bestedingen; anonimiseer in plaats van verwijderen.');
      }
      run(db, 'DELETE FROM donors WHERE id = ?', donorId);
      S.audit(db, ctx.actor, 'donateur_verwijderd', 'donor', donorId);
    }, admin],
    // AVG: recht op vergetelheid zonder de financiële administratie kapot te maken.
    ['POST', '/api/admin/donors/:id/anonymize', (ctx) => {
      const donorId = id(ctx.params.id);
      run(db, `UPDATE donors SET first_name='Geanonimiseerd', last_name='', company_name='', email=NULL, phone='', street='',
        postal_code='', city='', notes='', tags='', display_name='', anonymous=1, newsletter=0, password_hash=NULL,
        status='inactief', updated_at=datetime('now') WHERE id = ?`, donorId);
      run(db, 'DELETE FROM sessions WHERE kind = ? AND subject_id = ?', 'donor', donorId);
      run(db, 'DELETE FROM interactions WHERE donor_id = ?', donorId);
      run(db, 'DELETE FROM chat_messages WHERE donor_id = ?', donorId);
      run(db, 'UPDATE outbox SET to_email = ?, body = ? WHERE donor_id = ?', '', '[verwijderd]', donorId);
      S.audit(db, ctx.actor, 'donateur_geanonimiseerd', 'donor', donorId);
    }, admin],
    ['POST', '/api/admin/donors/:id/portal', (ctx) => {
      const donorId = id(ctx.params.id);
      const d = get(db, 'SELECT * FROM donors WHERE id = ?', donorId);
      if (!d) throw new AppError(404, 'Donateur niet gevonden');
      if (!d.email) throw new AppError(400, 'Donateur heeft geen e-mailadres');
      const password = ctx.body.password ? String(ctx.body.password) : crypto.randomBytes(6).toString('base64url');
      if (password.length < 8) throw new AppError(400, 'Wachtwoord moet minimaal 8 tekens zijn');
      run(db, 'UPDATE donors SET password_hash = ? WHERE id = ?', auth.hashPassword(password), donorId);
      S.sendMail(db, d, 'Je toegang tot het donateursportaal van Robin Foundation',
        `Beste ${d.first_name || S.donorFullName(d)},\n\nJe kunt nu inloggen op het donateursportaal met je e-mailadres. ` +
        `Je (tijdelijke) wachtwoord is: ${password}\n\nRobin Foundation`, 'portaal');
      S.audit(db, ctx.actor, 'portaaltoegang_ingesteld', 'donor', donorId);
      return { password };
    }, staff],
    ['POST', '/api/admin/donors/:id/impersonate', (ctx) => {
      const did = id(ctx.params.id);
      if (!get(db, 'SELECT id FROM donors WHERE id = ?', did)) throw new AppError(404, 'Donateur niet gevonden');
      return impersonate(ctx, 'donor', did, DONOR_COOKIE, '/portal');
    }, admin],
    ['POST', '/api/admin/recipients/:id/impersonate', (ctx) => {
      const rid = id(ctx.params.id);
      if (!get(db, 'SELECT id FROM recipients WHERE id = ? AND active = 1', rid)) throw new AppError(404, 'Ontvanger niet gevonden of inactief');
      return impersonate(ctx, 'recipient', rid, RECIPIENT_COOKIE, '/ontvanger');
    }, admin],
    ['GET', '/api/admin/donors/:id/annual', (ctx) => annualStatement(db, id(ctx.params.id), ctx.query.year), staff],
    ['POST', '/api/admin/donors/:id/interactions', (ctx) => {
      const donorId = id(ctx.params.id);
      const type = ctx.body.type || 'notitie';
      if (!['notitie', 'telefoon', 'email', 'afspraak', 'brief', 'evenement'].includes(type)) throw new AppError(400, 'Ongeldig type');
      if (!str(ctx.body.subject) && !str(ctx.body.body)) throw new AppError(400, 'Vul een onderwerp of omschrijving in');
      const r = run(db, `INSERT INTO interactions (donor_id, type, subject, body, user_id, occurred_at)
        VALUES (?,?,?,?,?, COALESCE(?, datetime('now')))`,
        donorId, type, str(ctx.body.subject, 300), str(ctx.body.body, 10000), ctx.user.id, ctx.body.occurred_at || null);
      return { id: Number(r.lastInsertRowid) };
    }, staff],
    ['DELETE', '/api/admin/interactions/:id', (ctx) => { run(db, 'DELETE FROM interactions WHERE id = ?', id(ctx.params.id)); }, staff],

    // ================================================================ BEHEER: DONATIES
    ['GET', '/api/admin/donations', (ctx) => {
      const { q = '', category = '', status = '', from = '', to = '', method = '', frequency = '', campaign = '' } = ctx.query;
      const where = ['1=1'];
      const p = [];
      if (q) { where.push(`(d.first_name || ' ' || d.last_name LIKE ? OR d.company_name LIKE ? OR dn.reference LIKE ?)`); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      if (category) { where.push('dn.category_key = ?'); p.push(category); }
      if (status) { where.push('dn.status = ?'); p.push(status); }
      if (method) { where.push('dn.method = ?'); p.push(method); }
      if (frequency) { where.push('dn.frequency = ?'); p.push(frequency); }
      if (campaign) { where.push('dn.campaign_id = ?'); p.push(Number(campaign)); }
      if (from) { where.push('dn.received_at >= ?'); p.push(from); }
      if (to) { where.push('dn.received_at <= ?'); p.push(to); }
      const rows = all(db, `SELECT dn.*, c.name AS category_name, c.icon, cp.name AS campaign_name,
          d.first_name, d.last_name, d.company_name, d.donor_type, ce.id AS cell_id, ce.remaining_cents, ce.status AS cell_status
        FROM donations dn JOIN donors d ON d.id = dn.donor_id JOIN categories c ON c.key = dn.category_key
        LEFT JOIN campaigns cp ON cp.id = dn.campaign_id LEFT JOIN cells ce ON ce.donation_id = dn.id
        WHERE ${where.join(' AND ')} ORDER BY dn.received_at DESC, dn.id DESC LIMIT 2000`, ...p)
        .map((r) => ({ ...r, donor_name: S.donorFullName(r) }));
      if (ctx.query.format === 'csv') {
        return csvResponse('donaties.csv', csv(rows, [
          ['id', 'ID'], ['received_at', 'Datum'], ['donor_name', 'Donateur'], ['category_name', 'Bestemming'],
          ['amount_cents', 'Bedrag (EUR)', centsToEuro], ['method', 'Betaalwijze'], ['frequency', 'Frequentie'],
          ['status', 'Status'], ['campaign_name', 'Campagne'], ['reference', 'Referentie'],
          ['remaining_cents', 'Nog in cel (EUR)', (v) => (v == null ? '' : centsToEuro(v))], ['cell_status', 'Celstatus'],
        ]));
      }
      return rows;
    }, staff],
    ['POST', '/api/admin/donations', (ctx) => S.createDonation(db, ctx.body, ctx.actor), staff],
    ['PUT', '/api/admin/donations/:id', (ctx) => S.updateDonation(db, id(ctx.params.id), ctx.body, ctx.actor), staff],
    ['DELETE', '/api/admin/donations/:id', (ctx) => S.deleteDonation(db, id(ctx.params.id), ctx.actor), admin],

    // ================================================================ BEHEER: CELLEN
    ['GET', '/api/admin/cells', (ctx) => {
      const { category = '', status = '', donor_id = '' } = ctx.query;
      const where = ['1=1'];
      const p = [];
      if (category) { where.push('ce.category_key = ?'); p.push(category); }
      if (status === 'open') where.push('ce.remaining_cents > 0');
      else if (status) { where.push('ce.status = ?'); p.push(status); }
      if (donor_id) { where.push('ce.donor_id = ?'); p.push(Number(donor_id)); }
      return all(db, `SELECT ce.*, c.name AS category_name, c.icon, c.color, dn.received_at, dn.frequency,
          d.first_name, d.last_name, d.company_name, d.donor_type,
          CAST(julianday('now') - julianday(ce.created_at) AS INTEGER) AS age_days
        FROM cells ce JOIN categories c ON c.key = ce.category_key JOIN donations dn ON dn.id = ce.donation_id
        JOIN donors d ON d.id = ce.donor_id WHERE ${where.join(' AND ')}
        ORDER BY ce.remaining_cents = 0, ce.created_at ASC, ce.id ASC LIMIT 2000`, ...p)
        .map((r) => ({ ...r, donor_name: S.donorFullName(r) }));
    }, staff],

    // ================================================================ BEHEER: BESTEDINGEN
    ['GET', '/api/admin/expenditures', (ctx) => {
      const { category = '' } = ctx.query;
      return all(db, `SELECT e.*, c.name AS category_name, c.icon, c.unit_label, c.unit_label_plural,
          r.name AS recipient_name, u.name AS created_by_name,
          (SELECT COUNT(DISTINCT donor_id) FROM allocations WHERE expenditure_id = e.id) AS donor_count,
          (SELECT COUNT(*) FROM impact_messages WHERE expenditure_id = e.id) AS message_count
        FROM expenditures e JOIN categories c ON c.key = e.category_key LEFT JOIN recipients r ON r.id = e.recipient_id
        LEFT JOIN users u ON u.id = e.created_by ${category ? 'WHERE e.category_key = ?' : ''}
        ORDER BY e.spent_at DESC, e.id DESC LIMIT 2000`, ...(category ? [category] : []));
    }, staff],
    ['POST', '/api/admin/expenditures', (ctx) => S.spend(db, ctx.body, ctx.actor, ctx.user.id), staff],
    ['GET', '/api/admin/expenditures/:id', (ctx) => {
      const expId = id(ctx.params.id);
      const e = get(db, `SELECT e.*, c.name AS category_name, c.icon, c.unit_label, c.unit_label_plural, r.name AS recipient_name
        FROM expenditures e JOIN categories c ON c.key = e.category_key LEFT JOIN recipients r ON r.id = e.recipient_id WHERE e.id = ?`, expId);
      if (!e) throw new AppError(404, 'Besteding niet gevonden');
      e.allocations = all(db, `SELECT a.*, d.first_name, d.last_name, d.company_name, d.donor_type, d.email, ce.amount_cents AS cell_amount_cents,
          dn.received_at FROM allocations a JOIN donors d ON d.id = a.donor_id JOIN cells ce ON ce.id = a.cell_id
          JOIN donations dn ON dn.id = ce.donation_id WHERE a.expenditure_id = ? ORDER BY a.amount_cents DESC`, expId)
        .map((r) => ({ ...r, donor_name: S.donorFullName(r) }));
      e.messages = all(db, `SELECT im.*, (SELECT COUNT(*) FROM donor_messages WHERE impact_message_id = im.id) AS delivered,
          (SELECT COUNT(*) FROM donor_messages WHERE impact_message_id = im.id AND read_at IS NOT NULL) AS read_count
        FROM impact_messages im WHERE im.expenditure_id = ? ORDER BY im.id`, expId);
      return e;
    }, staff],
    ['DELETE', '/api/admin/expenditures/:id', (ctx) => S.reverseExpenditure(db, id(ctx.params.id), ctx.actor), admin],
    ['POST', '/api/admin/expenditures/:id/messages', (ctx) => S.addImpactMessage(db, id(ctx.params.id), ctx.body, ctx.actor), staff],
    ['DELETE', '/api/admin/messages/:id', (ctx) => {
      run(db, 'DELETE FROM impact_messages WHERE id = ?', id(ctx.params.id));
      S.audit(db, ctx.actor, 'impactbericht_verwijderd', 'impact_message', id(ctx.params.id));
    }, staff],

    // ================================================================ BEHEER: ONTVANGERS
    ['GET', '/api/admin/recipients', () => all(db, `SELECT r.*,
        (SELECT COUNT(*) FROM expenditures WHERE recipient_id = r.id) AS expenditure_count,
        COALESCE((SELECT SUM(amount_cents) FROM expenditures WHERE recipient_id = r.id),0) AS received_cents,
        (SELECT COUNT(*) FROM chat_messages WHERE recipient_id = r.id) AS chat_count,
        (SELECT COUNT(*) FROM children WHERE family_id = r.id) AS children_count,
        (SELECT GROUP_CONCAT(first_name, ', ') FROM children WHERE family_id = r.id) AS children_names
      FROM recipients r ORDER BY r.active DESC, r.name COLLATE NOCASE`).map(publicRecipient), staff],
    ['POST', '/api/admin/recipients', (ctx) => {
      const b = recipientInput(ctx.body);
      const r = run(db, `INSERT INTO recipients (name, kind, age, school, location, country, story, photo_url, consent, active, street, barangay, province, phone)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.name, b.kind, b.age, b.school, b.location, b.country, b.story, b.photo_url, b.consent, b.active,
      b.street, b.barangay, b.province, b.phone);
      return publicRecipient(get(db, 'SELECT * FROM recipients WHERE id = ?', Number(r.lastInsertRowid)));
    }, staff],
    ['PUT', '/api/admin/recipients/:id', (ctx) => {
      const b = recipientInput(ctx.body);
      run(db, `UPDATE recipients SET name=?, kind=?, age=?, school=?, location=?, country=?, story=?, photo_url=?, consent=?, active=?,
        street=?, barangay=?, province=?, phone=? WHERE id=?`,
      b.name, b.kind, b.age, b.school, b.location, b.country, b.story, b.photo_url, b.consent, b.active,
      b.street, b.barangay, b.province, b.phone, id(ctx.params.id));
      return publicRecipient(get(db, 'SELECT * FROM recipients WHERE id = ?', id(ctx.params.id)));
    }, staff],
    // Inlog & chatinstellingen van een ontvanger.
    ['PUT', '/api/admin/recipients/:id/access', (ctx) => {
      const rid = id(ctx.params.id);
      const r = get(db, 'SELECT * FROM recipients WHERE id = ?', rid);
      if (!r) throw new AppError(404, 'Ontvanger niet gevonden');
      const b = ctx.body;
      const username = str(b.username, 60).toLowerCase() || null;
      if (username && !/^[a-z0-9._-]{3,60}$/.test(username)) throw new AppError(400, 'Gebruikersnaam: minimaal 3 tekens, alleen letters, cijfers, punt, - en _');
      if (username && get(db, 'SELECT id FROM recipients WHERE username = ? AND id <> ?', username, rid)) throw new AppError(409, 'Gebruikersnaam is al in gebruik');
      const managedBy = str(b.managed_by, 200);
      if (username && r.kind === 'kind' && !managedBy) throw new AppError(400, 'Een kind heeft een begeleider nodig die het account beheert');
      if (b.password && String(b.password).length < 8) throw new AppError(400, 'Wachtwoord moet minimaal 8 tekens zijn');
      if (username && !b.password && !r.password_hash) throw new AppError(400, 'Stel een wachtwoord in');
      const moderated = r.kind === 'kind' ? 1 : bool(b.chat_moderated);
      const language = require('./translate').LANGUAGES[b.language] ? b.language : (r.language || '');
      tx(db, () => {
        run(db, 'UPDATE recipients SET username = ?, managed_by = ?, chat_enabled = ?, chat_moderated = ?, language = ? WHERE id = ?',
          username, managedBy, bool(b.chat_enabled), moderated, language, rid);
        if (b.password) run(db, 'UPDATE recipients SET password_hash = ? WHERE id = ?', auth.hashPassword(b.password), rid);
        if (!username) {
          run(db, 'UPDATE recipients SET password_hash = NULL WHERE id = ?', rid);
          run(db, "DELETE FROM sessions WHERE kind = 'recipient' AND subject_id = ?", rid);
        }
      });
      S.audit(db, ctx.actor, 'ontvanger_toegang_gewijzigd', 'recipient', rid, { username, chat: bool(b.chat_enabled), moderated });
      return publicRecipient(get(db, 'SELECT * FROM recipients WHERE id = ?', rid));
    }, staff],
    ['DELETE', '/api/admin/recipients/:id', (ctx) => { run(db, 'DELETE FROM recipients WHERE id = ?', id(ctx.params.id)); }, admin],

    // ================================================================ BEHEER: TAKEN
    ['GET', '/api/admin/tasks', (ctx) => {
      const where = ['1=1'];
      const p = [];
      if (ctx.query.status) { where.push('t.status = ?'); p.push(ctx.query.status); }
      if (ctx.query.mine === '1') { where.push('t.assigned_to = ?'); p.push(ctx.user.id); }
      return all(db, `SELECT t.*, u.name AS assigned_name, d.first_name, d.last_name, d.company_name, d.donor_type
        FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN donors d ON d.id = t.donor_id
        WHERE ${where.join(' AND ')} ORDER BY t.status, t.due_date IS NULL, t.due_date, t.id DESC`, ...p)
        .map((t) => ({ ...t, donor_name: t.donor_id ? S.donorFullName(t) : '' }));
    }, staff],
    ['POST', '/api/admin/tasks', (ctx) => {
      const b = ctx.body;
      if (!str(b.title)) throw new AppError(400, 'Titel is verplicht');
      const r = run(db, `INSERT INTO tasks (donor_id, title, description, due_date, priority, assigned_to) VALUES (?,?,?,?,?,?)`,
        b.donor_id || null, str(b.title, 300), str(b.description, 5000), b.due_date || null,
        ['laag', 'normaal', 'hoog'].includes(b.priority) ? b.priority : 'normaal', b.assigned_to || ctx.user.id);
      return { id: Number(r.lastInsertRowid) };
    }, staff],
    ['PUT', '/api/admin/tasks/:id', (ctx) => {
      const t = get(db, 'SELECT * FROM tasks WHERE id = ?', id(ctx.params.id));
      if (!t) throw new AppError(404, 'Taak niet gevonden');
      const b = { ...t, ...ctx.body };
      run(db, `UPDATE tasks SET title=?, description=?, due_date=?, priority=?, status=?, assigned_to=?, donor_id=?,
        completed_at = CASE WHEN ? = 'afgerond' THEN COALESCE(completed_at, datetime('now')) ELSE NULL END WHERE id=?`,
        str(b.title, 300), str(b.description, 5000), b.due_date || null, b.priority, b.status === 'afgerond' ? 'afgerond' : 'open',
        b.assigned_to || null, b.donor_id || null, b.status, t.id);
    }, staff],
    ['DELETE', '/api/admin/tasks/:id', (ctx) => { run(db, 'DELETE FROM tasks WHERE id = ?', id(ctx.params.id)); }, staff],

    // ================================================================ BEHEER: CAMPAGNES
    ['GET', '/api/admin/campaigns', () => all(db, `SELECT cp.*, c.name AS category_name,
        COALESCE((SELECT SUM(amount_cents) FROM donations WHERE campaign_id = cp.id AND status='ontvangen'),0) AS raised_cents,
        (SELECT COUNT(DISTINCT donor_id) FROM donations WHERE campaign_id = cp.id AND status='ontvangen') AS donor_count
      FROM campaigns cp LEFT JOIN categories c ON c.key = cp.category_key ORDER BY cp.active DESC, cp.id DESC`), staff],
    ['POST', '/api/admin/campaigns', (ctx) => {
      const b = campaignInput(ctx.body);
      const r = run(db, `INSERT INTO campaigns (name, description, category_key, goal_cents, start_date, end_date, active) VALUES (?,?,?,?,?,?,?)`,
        b.name, b.description, b.category_key, b.goal_cents, b.start_date, b.end_date, b.active);
      return { id: Number(r.lastInsertRowid) };
    }, staff],
    ['PUT', '/api/admin/campaigns/:id', (ctx) => {
      const b = campaignInput(ctx.body);
      run(db, `UPDATE campaigns SET name=?, description=?, category_key=?, goal_cents=?, start_date=?, end_date=?, active=? WHERE id=?`,
        b.name, b.description, b.category_key, b.goal_cents, b.start_date, b.end_date, b.active, id(ctx.params.id));
    }, staff],
    ['DELETE', '/api/admin/campaigns/:id', (ctx) => { run(db, 'DELETE FROM campaigns WHERE id = ?', id(ctx.params.id)); }, admin],

    // ================================================================ BEHEER: RAPPORTAGES
    ['GET', '/api/admin/reports', (ctx) => {
      const year = /^\d{4}$/.test(ctx.query.year || '') ? ctx.query.year : String(new Date().getFullYear());
      const yf = "strftime('%Y', received_at) = ?";
      return {
        year,
        years: all(db, `SELECT DISTINCT strftime('%Y', received_at) AS y FROM donations ORDER BY y DESC`).map((r) => r.y),
        totals: get(db, `SELECT COALESCE(SUM(amount_cents),0) AS raised_cents, COUNT(*) AS donations, COUNT(DISTINCT donor_id) AS donors,
            COALESCE(AVG(amount_cents),0) AS avg_cents FROM donations WHERE status='ontvangen' AND ${yf}`, year),
        spent: get(db, `SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS n FROM expenditures WHERE strftime('%Y', spent_at) = ?`, year),
        byCategory: all(db, `SELECT c.key, c.name, c.icon, c.color, c.unit_label_plural,
            COALESCE((SELECT SUM(amount_cents) FROM donations WHERE category_key=c.key AND status='ontvangen' AND ${yf}),0) AS raised_cents,
            COALESCE((SELECT SUM(amount_cents) FROM expenditures WHERE category_key=c.key AND strftime('%Y', spent_at) = ?),0) AS spent_cents,
            COALESCE((SELECT SUM(units) FROM expenditures WHERE category_key=c.key AND strftime('%Y', spent_at) = ?),0) AS units
          FROM categories c ORDER BY c.sort_order`, year, year, year),
        byMonth: all(db, `SELECT strftime('%m', received_at) AS m, SUM(amount_cents) AS cents, COUNT(*) AS n
          FROM donations WHERE status='ontvangen' AND ${yf} GROUP BY m ORDER BY m`, year),
        byMethod: all(db, `SELECT method, SUM(amount_cents) AS cents, COUNT(*) AS n FROM donations
          WHERE status='ontvangen' AND ${yf} GROUP BY method ORDER BY cents DESC`, year),
        byFrequency: all(db, `SELECT frequency, SUM(amount_cents) AS cents, COUNT(*) AS n FROM donations
          WHERE status='ontvangen' AND ${yf} GROUP BY frequency ORDER BY cents DESC`, year),
        byType: all(db, `SELECT d.donor_type, SUM(dn.amount_cents) AS cents, COUNT(DISTINCT d.id) AS n FROM donations dn
          JOIN donors d ON d.id = dn.donor_id WHERE dn.status='ontvangen' AND strftime('%Y', dn.received_at) = ? GROUP BY d.donor_type`, year),
        retention: get(db, `SELECT
            (SELECT COUNT(DISTINCT donor_id) FROM donations WHERE status='ontvangen' AND strftime('%Y', received_at) = ?) AS this_year,
            (SELECT COUNT(DISTINCT donor_id) FROM donations WHERE status='ontvangen' AND strftime('%Y', received_at) = ?) AS last_year,
            (SELECT COUNT(DISTINCT a.donor_id) FROM donations a JOIN donations b ON a.donor_id = b.donor_id
              WHERE a.status='ontvangen' AND b.status='ontvangen' AND strftime('%Y', a.received_at) = ? AND strftime('%Y', b.received_at) = ?) AS retained`,
          year, String(Number(year) - 1), year, String(Number(year) - 1)),
        topDonors: S.leaderboard(db, { period: year, limit: 10 }).map((r) => {
          const d = get(db, 'SELECT * FROM donors WHERE id = ?', r.donor_id);
          return { ...r, full_name: S.donorFullName(d) };
        }),
        messageStats: get(db, `SELECT (SELECT COUNT(*) FROM donor_messages) AS delivered,
          (SELECT COUNT(*) FROM donor_messages WHERE read_at IS NOT NULL) AS read`),
      };
    }, staff],

    // ================================================================ BEHEER: LEADERBOARD (met echte namen)

    // ================================================================ BEHEER: E-MAIL LOG, AUDIT
    ['GET', '/api/admin/outbox', (ctx) => all(db, `SELECT o.* FROM outbox o
      ${ctx.query.kind ? 'WHERE o.kind = ?' : ''} ORDER BY o.id DESC LIMIT 500`, ...(ctx.query.kind ? [ctx.query.kind] : [])), staff],
    ['GET', '/api/admin/audit', () => all(db, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT 500'), admin],

    // ================================================================ BEHEER: INSTELLINGEN
    ['GET', '/api/admin/categories', () => S.categoryBalances(db), staff],
    ['PUT', '/api/admin/categories/:key', (ctx) => {
      const cat = S.getCategory(db, ctx.params.key);
      const b = ctx.body;
      const cost = b.unit_cost_cents === '' || b.unit_cost_cents == null ? null : Math.round(Number(b.unit_cost_cents));
      if (cost != null && (!Number.isInteger(cost) || cost <= 0)) throw new AppError(400, 'Ongeldige prijs per eenheid');
      run(db, `UPDATE categories SET name=?, description=?, unit_label=?, unit_label_plural=?, unit_cost_cents=?, icon=?, color=?, active=? WHERE key=?`,
        str(b.name ?? cat.name, 100), str(b.description ?? cat.description, 500), str(b.unit_label ?? cat.unit_label, 50),
        str(b.unit_label_plural ?? cat.unit_label_plural, 50), cost, str(b.icon ?? cat.icon, 10),
        /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : cat.color, b.active === undefined ? cat.active : bool(b.active), cat.key);
      S.audit(db, ctx.actor, 'bestemming_gewijzigd', 'category', null, cat.key);
    }, admin],
    ['GET', '/api/admin/translation/status', () => require('./translate').status(), admin],
    ['GET', '/api/admin/chat/moderation', () => ({ enabled: S.moderationEnabled() }), staff],
    ['PUT', '/api/admin/chat/moderation', (ctx) => {
      const on = !!ctx.body.enabled;
      run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('chat_moderation', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, on ? 'aan' : 'uit');
      S.setModeration(on);
      S.audit(db, ctx.actor, on ? 'chatmoderatie_aan' : 'chatmoderatie_uit', 'settings', null);
      return { enabled: on };
    }, admin],
    ['PUT', '/api/admin/translation/settings', (ctx) => {
      const T = require('./translate');
      const save = (k, v) => run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?,?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, v);
      const b = ctx.body;
      if (b.api_key !== undefined && b.api_key !== '') {
        const key = String(b.api_key).trim();
        const problem = T.keyProblem(key);
        if (problem) throw new AppError(400, problem);
        save('translate_api_key', key);
        T.configure({ apiKey: key });
      }
      if (b.remove_key) { save('translate_api_key', ''); T.configure({ apiKey: '' }); }
      if (b.workspace !== undefined) {
        const ws = String(b.workspace || '').trim();
        if (ws && !/^wrkspc_[A-Za-z0-9]{8,}$/.test(ws)) throw new AppError(400, 'Een Workspace-ID begint met "wrkspc_" (te vinden op platform.claude.com → Settings → Workspaces, kolom ID).');
        save('translate_workspace', ws);
        T.configure({ workspace: ws });
      }
      if (b.model !== undefined) {
        if (b.model && !T.MODELS[b.model]) throw new AppError(400, 'Onbekend model');
        save('translate_model', b.model || '');
        T.configure({ model: b.model || '' });
      }
      S.audit(db, ctx.actor, 'vertaalinstellingen_gewijzigd', 'settings', null,
        { key: b.remove_key ? 'verwijderd' : b.api_key ? 'gewijzigd' : 'ongewijzigd', model: b.model });
      return T.status();
    }, admin],
    ['POST', '/api/admin/translation/test', async () => {
      const T = require('./translate');
      const st = T.status();
      if (!st.enabled) return { ok: false, ...st, error: st.key_problem ? `Ongeldige API-sleutel${st.key_source === 'render' ? ' in Render' : ''}: ${st.key_problem}` : 'Vertalen staat uit (zie hierboven wat ontbreekt).' };
      const started = Date.now();
      try {
        const res = await T.translateBatch([{ id: 1, text: 'Bonjou! Mèsi anpil pou manje a, mwen kontan anpil.' }], 'nl');
        const t = res.get(1);
        return { ok: !!t, ...st, input: 'Bonjou! Mèsi anpil pou manje a, mwen kontan anpil.', output: t && t.text,
          source_language: t && t.source_language, ms: Date.now() - started };
      } catch (err) {
        return { ok: false, ...st, error: err.message, detail: err.detail || '' };
      }
    }, admin],
    ['GET', '/api/admin/users', () => all(db, 'SELECT id, email, name, role, active, created_at FROM users ORDER BY name'), staff],
    ['POST', '/api/admin/users', (ctx) => {
      const b = ctx.body;
      const email = str(b.email, 200).toLowerCase();
      if (!isEmail(email)) throw new AppError(400, 'Ongeldig e-mailadres');
      checkStrongPassword(b.password, email);
      if (get(db, 'SELECT id FROM users WHERE email = ?', email)) throw new AppError(409, 'Gebruiker bestaat al');
      const r = run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)',
        email, str(b.name, 100) || email, ROLES.includes(b.role) ? b.role : 'medewerker', auth.hashPassword(b.password));
      S.audit(db, ctx.actor, 'gebruiker_aangemaakt', 'user', Number(r.lastInsertRowid));
      return { id: Number(r.lastInsertRowid) };
    }, admin],
    ['PUT', '/api/admin/users/:id', (ctx) => {
      const userId = id(ctx.params.id);
      const u = get(db, 'SELECT * FROM users WHERE id = ?', userId);
      if (!u) throw new AppError(404, 'Gebruiker niet gevonden');
      const b = ctx.body;
      if (userId === ctx.user.id && (b.active === false || (b.role && b.role !== 'admin'))) {
        throw new AppError(400, 'Je kunt je eigen beheerrechten niet intrekken');
      }
      tx(db, () => {
        run(db, 'UPDATE users SET name=?, role=?, active=? WHERE id=?', str(b.name ?? u.name, 100),
          ROLES.includes(b.role ?? u.role) ? (b.role ?? u.role) : 'medewerker', b.active === undefined ? u.active : bool(b.active), userId);
        if (b.password) {
          checkStrongPassword(b.password, u.email);
          run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(b.password), userId);
        }
        if (b.email !== undefined && str(b.email, 200).toLowerCase() !== u.email) {
          const email = str(b.email, 200).toLowerCase();
          if (!email) throw new AppError(400, 'Vul een e-mailadres of gebruikersnaam in');
          if (get(db, 'SELECT id FROM users WHERE email = ? AND id <> ?', email, userId)) throw new AppError(409, 'Deze inlognaam is al in gebruik');
          run(db, 'UPDATE users SET email = ? WHERE id = ?', email, userId);
        }
        if (b.active === false) run(db, "DELETE FROM sessions WHERE kind='staff' AND subject_id = ?", userId);
      });
      S.audit(db, ctx.actor, 'gebruiker_gewijzigd', 'user', userId);
    }, admin],

    // ================================================================ BEHEER: INTEGRATIES (betalingen, e-mail)
    ['GET', '/api/admin/integrations', () => ({ payments: require('./payments').status(), email: require('./mailer').status(), idcheck: require('./idcheck').status() }), admin],
    ['PUT', '/api/admin/integrations', (ctx) => {
      const P = require('./payments'); const M = require('./mailer');
      const b = ctx.body;
      const save = (k, v) => run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?,?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, v);
      if (b.mollie_api_key) {
        const k = String(b.mollie_api_key).trim();
        if (!/^(test|live)_\w{20,}$/.test(k)) throw new AppError(400, 'Een Mollie API-sleutel begint met "test_" of "live_" (Mollie Dashboard → Ontwikkelaars → API-sleutels).');
        save('mollie_api_key', k); P.configure({ apiKey: k });
      }
      if (b.remove_mollie) { save('mollie_api_key', ''); P.configure({ apiKey: '' }); }
      if (b.mail_api_key) {
        const k = String(b.mail_api_key).trim();
        if (/\s/.test(k) || k.length < 20) throw new AppError(400, 'Dit lijkt geen Brevo API-sleutel (Brevo → SMTP & API → API Keys).');
        save('mail_api_key', k); M.configure({ apiKey: k });
      }
      if (b.remove_mail) { save('mail_api_key', ''); M.configure({ apiKey: '' }); }
      const V = require('./idcheck');
      for (const [field, k] of [['veriff_api_key', 'apiKey'], ['veriff_secret', 'secret']]) {
        if (!b[field]) continue;
        const v = String(b[field]).trim();
        if (/\s/.test(v) || v.length < 16) throw new AppError(400, 'Dit lijkt geen Veriff-sleutel (Veriff Station → Integrations → API keys).');
        save(field, v); V.configure({ [k]: v });
      }
      if (b.remove_veriff) { save('veriff_api_key', ''); save('veriff_secret', ''); V.configure({ apiKey: '', secret: '' }); }
      if (b.mail_from_email !== undefined) {
        const e = str(b.mail_from_email, 200).toLowerCase();
        if (e && !isEmail(e)) throw new AppError(400, 'Ongeldig afzenderadres');
        save('mail_from_email', e); M.configure({ fromEmail: e });
      }
      if (b.mail_from_name !== undefined) { save('mail_from_name', str(b.mail_from_name, 100)); M.configure({ fromName: str(b.mail_from_name, 100) }); }
      S.audit(db, ctx.actor, 'integraties_gewijzigd', 'settings', null,
        { mollie: b.remove_mollie ? 'verwijderd' : b.mollie_api_key ? 'gewijzigd' : '-', mail: b.remove_mail ? 'verwijderd' : b.mail_api_key ? 'gewijzigd' : '-' });
      return { payments: P.status(), email: M.status(), idcheck: V.status() };
    }, admin],
    ['POST', '/api/admin/integrations/test-mollie', async () => {
      const P = require('./payments');
      if (!P.isEnabled()) return { ok: false, error: 'Vul eerst een Mollie API-sleutel in.' };
      try { const r = await P.checkKey(); return { ok: true, mode: P.mode(), methods: ((r._embedded && r._embedded.methods) || []).map((m) => m.description) }; }
      catch (err) { return { ok: false, error: err.status === 401 ? 'Mollie accepteert deze sleutel niet.' : err.message }; }
    }, admin],
    ['POST', '/api/admin/integrations/test-mail', async (ctx) => {
      const M = require('./mailer');
      const to = str(ctx.body.to, 200).toLowerCase();
      if (!isEmail(to)) throw new AppError(400, 'Vul een geldig e-mailadres in om de test naartoe te sturen');
      if (!M.isEnabled()) return { ok: false, error: 'Vul eerst een Brevo API-sleutel en een afzenderadres in.' };
      try {
        await M.send({ to, subject: 'Test van het Robin Foundation CRM', text: 'Dit is een testbericht. Werkt! E-mails van het CRM worden nu echt verstuurd.\n\nRobin Foundation' });
        return { ok: true };
      } catch (err) { return { ok: false, error: err.message }; }
    }, admin],

    // ================================================================ BEHEER: LIVEGANG
    ['GET', '/api/admin/golive', (ctx) => {
      const me = get(db, 'SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
      const T = require('./translate');
      return {
        demo: isDemo(),
        weak_password: isWeakStored(me.password_hash),
        weak_users: all(db, 'SELECT id, email, password_hash FROM users WHERE active = 1').filter((u) => isWeakStored(u.password_hash)).map((u) => u.email),
        moderation: S.moderationEnabled(),
        impersonation_read_only: true,
        payments: require('./payments').isEnabled(),
        email: require('./mailer').isEnabled(),
        translation: T.isEnabled(),
        counts: get(db, `SELECT (SELECT COUNT(*) FROM donors) AS donors, (SELECT COUNT(*) FROM donations) AS donations,
          (SELECT COUNT(*) FROM recipients) AS recipients, (SELECT COUNT(*) FROM users) AS users`),
      };
    }, admin],
    // Alle demodata wissen. Bewaart: de ingelogde beheerder, bestemmingen en instellingen (sleutels).
    ['POST', '/api/admin/demo/wipe', (ctx) => {
      if (ctx.body.confirm !== 'VERWIJDER') throw new AppError(400, 'Typ VERWIJDER om te bevestigen');
      const me = get(db, 'SELECT * FROM users WHERE id = ?', ctx.user.id);
      if (isWeakStored(me.password_hash)) throw new AppError(400, 'Wijzig eerst je eigen wachtwoord; anders kan na het wissen iedereen met het demo-wachtwoord inloggen.');
      if (['robin', 'admin@robinfoundation.org'].includes(me.email)) throw new AppError(400, 'Geef je eigen account eerst een echte inlognaam (je e-mailadres) via Instellingen → Gebruikers.');
      tx(db, () => {
        db.exec(`DELETE FROM onboarding_files; DELETE FROM onboardings; DELETE FROM child_updates; DELETE FROM sponsor_months; DELETE FROM sponsorships; DELETE FROM children;
          DELETE FROM chat_translations; DELETE FROM chat_messages; DELETE FROM donor_messages; DELETE FROM impact_messages;
          DELETE FROM allocations; DELETE FROM expenditures; DELETE FROM cells; DELETE FROM donations; DELETE FROM interactions;
          DELETE FROM tasks; DELETE FROM campaigns; DELETE FROM recipients; DELETE FROM outbox; DELETE FROM donors;`);
        run(db, 'DELETE FROM sessions WHERE NOT (kind = ? AND subject_id = ?)', 'staff', me.id);
        run(db, 'DELETE FROM users WHERE id <> ?', me.id);
        run(db, "DELETE FROM settings WHERE key = 'chat_moderation'");
      });
      S.setModeration(true);
      // Geüploade bestanden hoorden bij de verwijderde berichten
      for (const f of fs.readdirSync(uploadDir)) { try { fs.unlinkSync(path.join(uploadDir, f)); } catch { /* negeren */ } }
      const privateDir = process.env.CRM_PRIVATE || path.join(path.dirname(path.resolve(uploadDir)), 'private');
      if (fs.existsSync(privateDir)) for (const f of fs.readdirSync(privateDir)) { try { fs.unlinkSync(path.join(privateDir, f)); } catch { /* negeren */ } }
      S.audit(db, ctx.actor, 'demodata_gewist', 'system', null);
      return { ok: true };
    }, admin],

    // ================================================================ BEHEER: UPLOADS (brieven, foto's, filmpjes)
    ['POST', '/api/admin/uploads', (ctx) => {
      const { filename = '', data = '' } = ctx.body;
      const ext = path.extname(String(filename)).toLowerCase();
      if (!UPLOAD_EXT.has(ext)) throw new AppError(400, `Bestandstype niet toegestaan (${[...UPLOAD_EXT].join(', ')})`);
      const base64 = String(data).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      if (!buf.length) throw new AppError(400, 'Leeg bestand');
      const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(uploadDir, name), buf);
      S.audit(db, ctx.actor, 'bestand_geupload', 'upload', null, name);
      return { url: `/uploads/${name}`, size: buf.length };
    }, staff],
  ];
}

function recipientInput(b) {
  const name = str(b.name, 200);
  if (!name) throw new AppError(400, 'Naam is verplicht');
  const kind = ['kind', 'gezin', 'school', 'gemeenschap', 'organisatie'].includes(b.kind) ? b.kind : 'gezin';
  const age = b.age === '' || b.age == null ? null : Number(b.age);
  return {
    name, kind, age: Number.isFinite(age) ? age : null, school: str(b.school, 200), location: str(b.location, 200),
    country: str(b.country, 100), story: str(b.story, 5000), photo_url: str(b.photo_url, 500), consent: bool(b.consent),
    active: b.active === undefined ? 1 : bool(b.active),
    street: str(b.street, 200), barangay: str(b.barangay, 120), province: str(b.province, 120), phone: str(b.phone, 40),
  };
}

function campaignInput(b) {
  const name = str(b.name, 200);
  if (!name) throw new AppError(400, 'Naam is verplicht');
  return {
    name, description: str(b.description, 2000), category_key: b.category_key || null,
    goal_cents: Math.max(0, Math.round(Number(b.goal_cents) || 0)), start_date: b.start_date || null,
    end_date: b.end_date || null, active: b.active === undefined ? 1 : bool(b.active),
  };
}

module.exports = { buildRoutes };

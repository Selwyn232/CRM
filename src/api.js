'use strict';
// Alle API-routes. Elke route: [methode, pad, handler, guard].

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, get, run, tx } = require('./db');
const auth = require('./auth');
const S = require('./services');
const { AppError } = S;

const STAFF_COOKIE = 'rf_staff';
const DONOR_COOKIE = 'rf_donor';
const UPLOAD_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.pdf']);

const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'Ongeldig id');
  return n;
};
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
  'newsletter', 'preferred_channel'];

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
  if (!partial && !out.first_name && !out.last_name && !out.company_name) throw new AppError(400, 'Naam is verplicht');
  return out;
}

function publicDonor(d) {
  if (!d) return d;
  const { password_hash, ...rest } = d;
  return { ...rest, has_portal: !!password_hash, full_name: S.donorFullName(d), public_name: S.donorPublicName(d) };
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
  // ------------------------------------------------------------ guards
  const staff = (ctx) => {
    const s = auth.getSession(db, ctx.cookies[STAFF_COOKIE]);
    if (!s || s.kind !== 'staff') throw new AppError(401, 'Niet ingelogd');
    const user = get(db, 'SELECT id, email, name, role, active FROM users WHERE id = ?', s.subject_id);
    if (!user || !user.active) throw new AppError(401, 'Niet ingelogd');
    ctx.user = user;
    ctx.actor = `medewerker:${user.email}`;
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
  };

  const setCookie = (ctx, name, token) => { ctx.headers = { 'Set-Cookie': auth.sessionCookie(name, token, ctx.secure) }; };

  const categories = () => all(db, 'SELECT * FROM categories ORDER BY sort_order');

  return [
    // ================================================================ PUBLIEK
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
    ['GET', '/api/public/leaderboard', (ctx) => S.leaderboard(db, ctx.query)
      .map(({ donor_id, ...rest }) => rest)],

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
    ['GET', '/api/staff/me', (ctx) => ctx.user, staff],

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
    ['GET', '/api/donor/me', (ctx) => publicDonor(ctx.donor), donor],

    // ================================================================ DONATEURSPORTAAL
    ['GET', '/api/portal/overview', (ctx) => {
      const d = ctx.donor;
      const impact = S.donorImpact(db, d.id);
      const board = S.leaderboard(db, { limit: 500 });
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
    ['POST', '/api/portal/donate', (ctx) => {
      // Betaling is hier gesimuleerd; koppel in productie een betaalprovider (bv. Mollie) en
      // maak de donatie pas 'ontvangen' na de betaal-webhook.
      const amount = Math.round(Number(ctx.body.amount_cents));
      if (!Number.isInteger(amount) || amount < 100) throw new AppError(400, 'Minimaal bedrag is € 1,00');
      if (amount > 10_000_000) throw new AppError(400, 'Neem voor grote giften contact met ons op');
      const donation = S.createDonation(db, {
        donor_id: ctx.donor.id, category_key: ctx.body.category_key, amount_cents: amount,
        frequency: ctx.body.frequency || 'eenmalig', method: 'ideal', campaign_id: ctx.body.campaign_id || null,
        reference: `PORTAAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      }, ctx.actor);
      return donation;
    }, donor],
    ['PUT', '/api/portal/profile', (ctx) => {
      const allowed = ['first_name', 'last_name', 'phone', 'street', 'postal_code', 'city', 'country',
        'anonymous', 'display_name', 'newsletter', 'preferred_channel'];
      const data = cleanDonor(Object.fromEntries(allowed.filter((k) => k in ctx.body).map((k) => [k, ctx.body[k]])), { partial: true });
      const keys = Object.keys(data);
      if (keys.length) {
        run(db, `UPDATE donors SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
          ...keys.map((k) => data[k]), ctx.donor.id);
        S.audit(db, ctx.actor, 'profiel_gewijzigd', 'donor', ctx.donor.id, keys.join(','));
      }
      return publicDonor(get(db, 'SELECT * FROM donors WHERE id = ?', ctx.donor.id));
    }, donor],
    ['POST', '/api/portal/password', (ctx) => {
      if (!auth.verifyPassword(ctx.body.current || '', ctx.donor.password_hash)) throw new AppError(400, 'Huidig wachtwoord klopt niet');
      if (!ctx.body.password || String(ctx.body.password).length < 8) throw new AppError(400, 'Nieuw wachtwoord moet minimaal 8 tekens zijn');
      run(db, 'UPDATE donors SET password_hash = ? WHERE id = ?', auth.hashPassword(ctx.body.password), ctx.donor.id);
    }, donor],
    ['GET', '/api/portal/leaderboard', (ctx) => S.leaderboard(db, ctx.query)
      .map(({ donor_id, ...rest }) => ({ ...rest, is_me: donor_id === ctx.donor.id })), donor],
    ['GET', '/api/portal/annual', (ctx) => annualStatement(db, ctx.donor.id, ctx.query.year), donor],
    ['GET', '/api/portal/campaigns', () => all(db, `SELECT cp.*,
      COALESCE((SELECT SUM(amount_cents) FROM donations WHERE campaign_id = cp.id AND status='ontvangen'),0) AS raised_cents
      FROM campaigns cp WHERE active = 1 AND (end_date IS NULL OR end_date >= date('now')) ORDER BY id DESC`), donor],
    ['GET', '/api/portal/categories', () => categories().filter((c) => c.active), donor],

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
        (SELECT COUNT(*) FROM tasks WHERE status='open' AND due_date < date('now')) AS overdue_tasks`);
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
        rank: (S.leaderboard(db, { limit: 500 }).find((r) => r.donor_id === donorId) || {}).rank || null,
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
        COALESCE((SELECT SUM(amount_cents) FROM expenditures WHERE recipient_id = r.id),0) AS received_cents
      FROM recipients r ORDER BY r.active DESC, r.name COLLATE NOCASE`), staff],
    ['POST', '/api/admin/recipients', (ctx) => {
      const b = recipientInput(ctx.body);
      const r = run(db, `INSERT INTO recipients (name, kind, age, school, location, country, story, photo_url, consent, active)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, b.name, b.kind, b.age, b.school, b.location, b.country, b.story, b.photo_url, b.consent, b.active);
      return get(db, 'SELECT * FROM recipients WHERE id = ?', Number(r.lastInsertRowid));
    }, staff],
    ['PUT', '/api/admin/recipients/:id', (ctx) => {
      const b = recipientInput(ctx.body);
      run(db, `UPDATE recipients SET name=?, kind=?, age=?, school=?, location=?, country=?, story=?, photo_url=?, consent=?, active=? WHERE id=?`,
        b.name, b.kind, b.age, b.school, b.location, b.country, b.story, b.photo_url, b.consent, b.active, id(ctx.params.id));
      return get(db, 'SELECT * FROM recipients WHERE id = ?', id(ctx.params.id));
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
    ['GET', '/api/admin/leaderboard', (ctx) => S.leaderboard(db, ctx.query).map((r) => {
      const d = get(db, 'SELECT * FROM donors WHERE id = ?', r.donor_id);
      return { ...r, full_name: S.donorFullName(d) };
    }), staff],

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
    ['GET', '/api/admin/users', () => all(db, 'SELECT id, email, name, role, active, created_at FROM users ORDER BY name'), staff],
    ['POST', '/api/admin/users', (ctx) => {
      const b = ctx.body;
      const email = str(b.email, 200).toLowerCase();
      if (!isEmail(email)) throw new AppError(400, 'Ongeldig e-mailadres');
      if (!b.password || String(b.password).length < 8) throw new AppError(400, 'Wachtwoord moet minimaal 8 tekens zijn');
      if (get(db, 'SELECT id FROM users WHERE email = ?', email)) throw new AppError(409, 'Gebruiker bestaat al');
      const r = run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)',
        email, str(b.name, 100) || email, b.role === 'admin' ? 'admin' : 'medewerker', auth.hashPassword(b.password));
      S.audit(db, ctx.actor, 'gebruiker_aangemaakt', 'user', Number(r.lastInsertRowid));
      return { id: Number(r.lastInsertRowid) };
    }, admin],
    ['PUT', '/api/admin/users/:id', (ctx) => {
      const userId = id(ctx.params.id);
      const u = get(db, 'SELECT * FROM users WHERE id = ?', userId);
      if (!u) throw new AppError(404, 'Gebruiker niet gevonden');
      const b = ctx.body;
      if (userId === ctx.user.id && (b.active === false || b.role === 'medewerker')) {
        throw new AppError(400, 'Je kunt je eigen beheerrechten niet intrekken');
      }
      tx(db, () => {
        run(db, 'UPDATE users SET name=?, role=?, active=? WHERE id=?', str(b.name ?? u.name, 100),
          (b.role ?? u.role) === 'admin' ? 'admin' : 'medewerker', b.active === undefined ? u.active : bool(b.active), userId);
        if (b.password) {
          if (String(b.password).length < 8) throw new AppError(400, 'Wachtwoord moet minimaal 8 tekens zijn');
          run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(b.password), userId);
        }
        if (b.active === false) run(db, "DELETE FROM sessions WHERE kind='staff' AND subject_id = ?", userId);
      });
      S.audit(db, ctx.actor, 'gebruiker_gewijzigd', 'user', userId);
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
  const kind = ['kind', 'gezin', 'school', 'gemeenschap', 'organisatie'].includes(b.kind) ? b.kind : 'kind';
  const age = b.age === '' || b.age == null ? null : Number(b.age);
  return {
    name, kind, age: Number.isFinite(age) ? age : null, school: str(b.school, 200), location: str(b.location, 200),
    country: str(b.country, 100), story: str(b.story, 5000), photo_url: str(b.photo_url, 500), consent: bool(b.consent),
    active: b.active === undefined ? 1 : bool(b.active),
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

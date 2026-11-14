'use strict';
// API-routes voor het sponsormodel: kinderen kiezen, maandbetalingen, mijn kinderen, beheer.

const crypto = require('node:crypto');
const { all, get, run, tx } = require('./db');
const S = require('./services');
const SP = require('./sponsoring');
const { AppError } = S;

const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'Ongeldig id');
  return n;
};
const parse = (j, d) => { try { return JSON.parse(j); } catch { return d; } };
const CHILD_STATUSES = ['concept', 'te_beoordelen', 'beschikbaar', 'gesponsord', 'inactief', 'afgekeurd'];

function childInput(db, b) {
  const first = str(b.first_name, 80);
  if (!first) throw new AppError(400, 'Voornaam is verplicht');
  const familyId = b.family_id ? id(b.family_id) : null;
  if (familyId && !get(db, 'SELECT id FROM recipients WHERE id = ?', familyId)) throw new AppError(400, 'Gezin niet gevonden');
  const birth = str(b.birth_date, 10);
  if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) throw new AppError(400, 'Geboortedatum: jjjj-mm-dd');
  return {
    family_id: familyId, first_name: first, last_name: str(b.last_name, 80), birth_date: birth || null,
    gender: ['jongen', 'meisje', ''].includes(b.gender) ? b.gender : '', school: str(b.school, 200), grade: str(b.grade, 60),
    story: str(b.story, 5000), photo_url: str(b.photo_url, 500),
  };
}

function buildSponsorRoutes({ db, guards, publicBase }) {
  const { staff, admin, donor } = guards;

  // Wat een sponsor over zijn eigen sponsorkind ziet.
  const myChild = (donorId, s) => {
    const c = get(db, `${SP.CHILD_SELECT} WHERE ch.id = ?`, s.child_id);
    const stats = get(db, 'SELECT COUNT(*) AS months, COALESCE(SUM(amount_cents),0) AS total FROM sponsor_months WHERE sponsorship_id = ?', s.id);
    const unread = get(db, 'SELECT COUNT(*) AS n FROM child_updates WHERE child_id = ? AND donor_id = ? AND read_at IS NULL', s.child_id, donorId).n;
    const updates = get(db, 'SELECT COUNT(*) AS n FROM child_updates WHERE child_id = ? AND donor_id = ?', s.child_id, donorId).n;
    const last = get(db, 'SELECT * FROM child_updates WHERE child_id = ? AND donor_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', s.child_id, donorId);
    const chat = c.family_id ? get(db, `SELECT chat_enabled FROM recipients WHERE id = ?`, c.family_id) : null;
    return {
      ...SP.publicChild(c), sponsorship_id: s.id, sponsorship_status: s.status, started_at: s.started_at, monthly_cents: s.monthly_cents,
      missed_months: s.missed_months, months: stats.months, total_cents: stats.total, unread_updates: unread, updates,
      last_update: last ? { title: last.title, type: last.type, media_url: last.media_url, created_at: last.created_at } : null,
      can_chat: !!(chat && chat.chat_enabled),
    };
  };
  const mySponsorships = (donorId) => all(db, "SELECT * FROM sponsorships WHERE donor_id = ? AND status <> 'beeindigd' ORDER BY started_at, id", donorId);

  // Abonnementsbedrag bij Mollie gelijk houden aan het aantal kinderen.
  async function syncSubscription(donorRow, subscriptionId, actor) {
    const P = require('./payments');
    if (!subscriptionId || !P.isEnabled() || !donorRow.mollie_customer_id) return;
    const left = all(db, "SELECT * FROM sponsorships WHERE subscription_id = ? AND status <> 'beeindigd'", subscriptionId);
    try {
      if (!left.length) await P.cancelSubscription(donorRow.mollie_customer_id, subscriptionId);
      else await P.updateSubscription(donorRow.mollie_customer_id, subscriptionId, { cents: left.reduce((s, x) => s + x.monthly_cents, 0) });
    } catch (err) { S.audit(db, actor, 'abonnement_aanpassen_mislukt', 'subscription', null, `${subscriptionId}: ${err.message}`); }
  }

  // Maandelijkse automatische incasso starten bij Mollie voor deze sponsorschappen (vanaf volgende maand).
  async function startSubscription(donorRow, ids, { webhookUrl, reference }) {
    const P = require('./payments');
    const cents = all(db, `SELECT monthly_cents FROM sponsorships WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).reduce((t, x) => t + x.monthly_cents, 0);
    const start = new Date(); start.setMonth(start.getMonth() + 1);
    const sub = await P.createSubscription(donorRow.mollie_customer_id, {
      cents, interval: '1 month', description: `Robin Foundation – sponsoring ${ids.length} ${ids.length === 1 ? 'kind' : 'kinderen'} #${reference}`,
      webhookUrl, startDate: start.toISOString().slice(0, 10), metadata: { sponsor: true, reference },
    });
    run(db, `UPDATE sponsorships SET subscription_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, sub.id, ...ids);
    return sub;
  }
  // Lukt de automatische incasso niet, dan een taak voor kantoor (anders stopt de betaling na de eerste maand ongemerkt).
  function incassoTask(donorId, reason) {
    const d = get(db, 'SELECT * FROM donors WHERE id = ?', donorId);
    run(db, "INSERT INTO tasks (title, description, donor_id, priority, due_date) VALUES (?, ?, ?, 'hoog', date('now', '+3 days'))",
      `Automatische incasso niet gestart: ${S.donorFullName(d)}`,
      `De eerste betaling is binnen, maar Mollie kon de maandelijkse incasso niet starten (${reason}). Ga naar Sponsorschappen en kies "Automatische incasso starten", of neem contact op met de sponsor.`, donorId);
  }

  // Wordt vanuit de Mollie-webhook aangeroepen. Geeft true als de betaling bij het sponsormodel hoort.
  async function handleSponsorPayment(pay) {
    const P = require('./payments');
    const paid = pay.status === 'paid';
    const failed = ['failed', 'canceled', 'expired'].includes(pay.status);
    const donation = get(db, 'SELECT * FROM donations WHERE external_id = ?', pay.id);

    // Vervolgbetaling van een sponsorabonnement
    if (!donation && pay.subscriptionId) {
      const spons = all(db, "SELECT * FROM sponsorships WHERE subscription_id = ? AND status <> 'beeindigd'", pay.subscriptionId);
      if (!spons.length) return !!get(db, 'SELECT 1 AS x FROM sponsorships WHERE subscription_id = ?', pay.subscriptionId);
      if (paid) {
        const res = SP.bookPayment(db, { donorId: spons[0].donor_id, sponsorshipIds: spons.map((s) => s.id),
          amountCents: Math.round(Number(pay.amount.value) * 100), reference: pay.id, method: 'incasso', actor: 'mollie' });
        if (res) run(db, 'UPDATE donations SET external_id = ?, subscription_id = ? WHERE id = ?', pay.id, pay.subscriptionId, res.donation_id);
      } else if (failed) {
        // Elke mislukte betaling maar één keer tellen
        if (!get(db, "SELECT 1 AS x FROM audit_log WHERE action = 'sponsorbetaling_mislukt' AND details = ?", pay.id)) {
          S.audit(db, 'mollie', 'sponsorbetaling_mislukt', 'subscription', null, pay.id);
          SP.missedPayment(db, spons.map((s) => s.id), 'mollie');
          await syncSubscription(get(db, 'SELECT * FROM donors WHERE id = ?', spons[0].donor_id), pay.subscriptionId, 'mollie');
        }
      }
      return true;
    }
    if (!donation || donation.category_key !== 'sponsoring') return false;
    const meta = parse(donation.meta, {});
    if (paid && donation.status === 'in_afwachting') {
      const ids = SP.startSponsorships(db, donation.donor_id, meta.child_ids || [], { actor: 'mollie' });
      if (!ids.length) {
        // Alle kinderen inmiddels vergeven (zeldzaam): melden zodat een medewerker contact opneemt en terugbetaalt.
        run(db, "UPDATE donations SET status = 'ontvangen', note = 'Betaald, maar gekozen kinderen waren niet meer vrij. Terugbetalen of nieuw kind koppelen.' WHERE id = ?", donation.id);
        run(db, "INSERT INTO tasks (title, description, donor_id, status) VALUES (?, ?, ?, 'open')", 'Sponsorbetaling zonder vrij kind',
          `Donatie #${donation.id}: gekozen kinderen waren niet meer beschikbaar.`, donation.donor_id);
        return true;
      }
      SP.bookPayment(db, { donorId: donation.donor_id, sponsorshipIds: ids, amountCents: donation.amount_cents, method: pay.method || 'online', donationId: donation.id, actor: 'mollie' });
      const donorRow = get(db, 'SELECT * FROM donors WHERE id = ?', donation.donor_id);
      if (pay.customerId && donorRow.mollie_customer_id) {
        try {
          const sub = await startSubscription(donorRow, ids, { webhookUrl: pay.webhookUrl, reference: donation.id });
          run(db, 'UPDATE donations SET subscription_id = ? WHERE id = ?', sub.id, donation.id);
        } catch (err) {
          S.audit(db, 'mollie', 'abonnement_mislukt', 'donation', donation.id, err.message);
          incassoTask(donation.donor_id, err.message);
        }
      } else {
        incassoTask(donation.donor_id, 'geen Mollie-klant bij deze betaling');
      }
    } else if (failed && donation.status === 'in_afwachting') {
      run(db, "UPDATE donations SET status = 'geannuleerd', note = ? WHERE id = ?", `Betaling ${pay.status}`, donation.id);
      run(db, `UPDATE children SET reserved_until = NULL, reserved_by = NULL WHERE reserved_by = ? AND status = 'beschikbaar'`, donation.donor_id);
    }
    return true;
  }

  const routes = [
    // ------------------------------------------------------------------ publiek
    ['GET', '/api/public/sponsor', () => {
      const cfg = SP.getConfig(db);
      // Publiek (zonder inloggen): voornaam, leeftijd, provincie en foto. Verhaal, school en gezin pas na inloggen.
      const available = SP.availableChildren(db).slice(0, 8).map((c) => ({ id: c.id, first_name: c.first_name, age: c.age, province: c.province, country: c.country, photo_url: c.photo_url }));
      return { config: cfg, available, counts: get(db, `SELECT
        (SELECT COUNT(*) FROM children WHERE status = 'beschikbaar') AS available,
        (SELECT COUNT(*) FROM children WHERE status = 'gesponsord') AS sponsored,
        (SELECT COUNT(DISTINCT donor_id) FROM sponsorships WHERE status <> 'beeindigd') AS sponsors`) };
    }],
    // Labels (groepen sponsoren) met het aantal sponsoren dat nu een kind sponsort.
    ['GET', '/api/public/labels', () => all(db, `SELECT l.id, l.name, (SELECT COUNT(DISTINCT s.donor_id) FROM sponsorships s JOIN donors d ON d.id = s.donor_id
      WHERE d.label_id = l.id AND s.status <> 'beeindigd') AS sponsors FROM sponsor_labels l ORDER BY l.sort_order, l.name`)],
    ['GET', '/api/admin/labels', () => all(db, `SELECT l.*, (SELECT COUNT(*) FROM donors d WHERE d.label_id = l.id) AS donors
      FROM sponsor_labels l ORDER BY l.sort_order, l.name`), staff],
    ['POST', '/api/admin/labels', (ctx) => {
      const name = str(ctx.body.name, 40);
      if (!name) throw new AppError(400, 'Geef het label een naam');
      if (get(db, 'SELECT id FROM sponsor_labels WHERE name = ?', name)) throw new AppError(409, 'Dit label bestaat al');
      const r = run(db, 'INSERT INTO sponsor_labels (name, sort_order) VALUES (?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM sponsor_labels))', name);
      S.audit(db, ctx.actor, 'label_aangemaakt', 'label', Number(r.lastInsertRowid), name);
      return get(db, 'SELECT * FROM sponsor_labels WHERE id = ?', Number(r.lastInsertRowid));
    }, admin],
    ['PUT', '/api/admin/labels/:id', (ctx) => {
      const lid = id(ctx.params.id);
      const name = str(ctx.body.name, 40);
      if (!name) throw new AppError(400, 'Geef het label een naam');
      if (get(db, 'SELECT id FROM sponsor_labels WHERE name = ? AND id <> ?', name, lid)) throw new AppError(409, 'Dit label bestaat al');
      run(db, 'UPDATE sponsor_labels SET name = ? WHERE id = ?', name, lid);
      if (ctx.body.move) {
        // Een plek omhoog/omlaag schuiven
        const list = all(db, 'SELECT id FROM sponsor_labels ORDER BY sort_order, name').map((x) => x.id);
        const i = list.indexOf(lid); const j = i + (ctx.body.move < 0 ? -1 : 1);
        if (i >= 0 && j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; list.forEach((x, k) => run(db, 'UPDATE sponsor_labels SET sort_order = ? WHERE id = ?', k + 1, x)); }
      }
      return get(db, 'SELECT * FROM sponsor_labels WHERE id = ?', lid);
    }, admin],
    ['DELETE', '/api/admin/labels/:id', (ctx) => {
      const l = get(db, 'SELECT * FROM sponsor_labels WHERE id = ?', id(ctx.params.id));
      if (!l) throw new AppError(404, 'Label niet gevonden');
      if (l.key) throw new AppError(409, `"${l.name}" is een standaardlabel en kan niet worden verwijderd (wel hernoemd)`);
      const n = get(db, 'SELECT COUNT(*) AS n FROM donors WHERE label_id = ?', l.id).n;
      if (n) throw new AppError(409, `Er ${n === 1 ? 'hoort nog 1 sponsor' : `horen nog ${n} sponsoren`} bij dit label. Geef ${n === 1 ? 'die' : 'ze'} eerst een ander label.`);
      run(db, 'DELETE FROM sponsor_labels WHERE id = ?', l.id);
      S.audit(db, ctx.actor, 'label_verwijderd', 'label', l.id, l.name);
    }, admin],
    // Kinderen om uit te kiezen bij het aanmelden (zonder achternaam, adres of gezin).
    ['GET', '/api/public/children', () => SP.availableChildren(db).slice(0, 60)
      .map(({ family_id, family_story, family_photo, ...c }) => c)],
    ['GET', '/api/public/leaderboard', (ctx) => SP.leaderboard(db, ctx.query).map(({ donor_id, ...r }) => r)],

    // ------------------------------------------------------------------ sponsorportaal
    ['GET', '/api/portal/sponsor/config', () => SP.getConfig(db), donor],
    ['GET', '/api/portal/children', (ctx) => SP.availableChildren(db, ctx.donor.id), donor],
    ['POST', '/api/portal/sponsor', async (ctx) => {
      const P = require('./payments');
      const cfg = SP.getConfig(db);
      // Eerst beveiligen (Face ID of wachtwoord), anders kan de sponsor later niet meer inloggen.
      if (!ctx.donor.password_hash && !get(db, "SELECT 1 AS x FROM passkeys WHERE kind = 'donor' AND subject_id = ?", ctx.donor.id)) {
        throw new AppError(400, 'Beveilig eerst je account met Face ID of een wachtwoord');
      }
      const ids = SP.reserve(db, ctx.donor.id, Array.isArray(ctx.body.child_ids) ? ctx.body.child_ids : []);
      const total = ids.length * cfg.amount_cents;
      if (!P.isEnabled()) {
        // Demo: zonder betaalprovider start het sponsorschap meteen en wordt de eerste maand geboekt.
        const sids = SP.startSponsorships(db, ctx.donor.id, ids, { actor: ctx.actor });
        const res = SP.bookPayment(db, { donorId: ctx.donor.id, sponsorshipIds: sids, method: 'ideal',
          reference: `DEMO-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, actor: ctx.actor });
        return { done: true, sponsorship_ids: sids, donation_id: res && res.donation_id };
      }
      const r = run(db, `INSERT INTO donations (donor_id, category_key, amount_cents, method, frequency, status, meta)
        VALUES (?, 'sponsoring', ?, 'online', 'maandelijks', 'in_afwachting', ?)`, ctx.donor.id, total, JSON.stringify({ child_ids: ids }));
      const donationId = Number(r.lastInsertRowid);
      const base = publicBase(ctx);
      try {
        let customerId = ctx.donor.mollie_customer_id;
        if (!customerId) {
          customerId = (await P.createCustomer(S.donorFullName(ctx.donor), ctx.donor.email)).id;
          run(db, 'UPDATE donors SET mollie_customer_id = ? WHERE id = ?', customerId, ctx.donor.id);
        }
        const pay = await P.createPayment({
          cents: total, description: `Robin Foundation – sponsoring ${ids.length} ${ids.length === 1 ? 'kind' : 'kinderen'} (maandelijks)`,
          redirectUrl: `${base}/portal#/sponsoren/klaar/${donationId}`, webhookUrl: `${base}/api/webhooks/mollie`,
          metadata: { donation_id: donationId, sponsor: true }, customerId, sequenceType: 'first',
        });
        run(db, 'UPDATE donations SET external_id = ?, reference = ? WHERE id = ?', pay.id, pay.id, donationId);
        return { id: donationId, checkout_url: pay._links && pay._links.checkout && pay._links.checkout.href };
      } catch (err) {
        run(db, "UPDATE donations SET status = 'geannuleerd', note = ? WHERE id = ?", `Betaling kon niet starten: ${err.message}`, donationId);
        run(db, "UPDATE children SET reserved_until = NULL, reserved_by = NULL WHERE reserved_by = ? AND status = 'beschikbaar'", ctx.donor.id);
        throw new AppError(502, 'De betaling kon niet worden gestart. Probeer het later opnieuw.');
      }
    }, donor],
    ['GET', '/api/portal/sponsor/:id', (ctx) => {
      const d = get(db, "SELECT id, status, amount_cents FROM donations WHERE id = ? AND donor_id = ? AND category_key = 'sponsoring'", id(ctx.params.id), ctx.donor.id);
      if (!d) throw new AppError(404, 'Betaling niet gevonden');
      return d;
    }, donor],
    ['GET', '/api/portal/my-children', (ctx) => mySponsorships(ctx.donor.id).map((s) => myChild(ctx.donor.id, s)), donor],
    ['GET', '/api/portal/my-children/:id', (ctx) => {
      const s = get(db, "SELECT * FROM sponsorships WHERE donor_id = ? AND child_id = ? AND status <> 'beeindigd'", ctx.donor.id, id(ctx.params.id));
      if (!s) throw new AppError(404, 'Dit kind sponsor je (nu) niet');
      const months = all(db, 'SELECT month, amount_cents, lines, created_at FROM sponsor_months WHERE sponsorship_id = ? ORDER BY month DESC', s.id)
        .map((m) => ({ ...m, lines: parse(m.lines, []) }));
      const updates = all(db, 'SELECT id, month, type, title, body, media_url, read_at, created_at FROM child_updates WHERE child_id = ? AND donor_id = ? ORDER BY created_at DESC, id DESC', s.child_id, ctx.donor.id);
      if (!ctx.impersonator) run(db, "UPDATE child_updates SET read_at = datetime('now') WHERE child_id = ? AND donor_id = ? AND read_at IS NULL", s.child_id, ctx.donor.id);
      const totals = {};
      for (const m of months) for (const l of m.lines) {
        totals[l.key] = totals[l.key] || { ...l, cents: 0 };
        totals[l.key].cents += l.cents;
      }
      return { child: myChild(ctx.donor.id, s), months, updates, totals: Object.values(totals), config: SP.getConfig(db) };
    }, donor],
    ['POST', '/api/portal/my-children/:id/stop', async (ctx) => {
      const s = get(db, "SELECT * FROM sponsorships WHERE donor_id = ? AND child_id = ? AND status <> 'beeindigd'", ctx.donor.id, id(ctx.params.id));
      if (!s) throw new AppError(404, 'Dit kind sponsor je (nu) niet');
      SP.endSponsorship(db, s.id, str(ctx.body.reason, 200) || 'Gestopt door sponsor', ctx.actor);
      await syncSubscription(ctx.donor, s.subscription_id, ctx.actor);
      return { ok: true };
    }, donor],

    // ------------------------------------------------------------------ beheer
    ['GET', '/api/admin/sponsor/overview', () => {
      const month = SP.currentMonth();
      const totals = get(db, `SELECT
        (SELECT COUNT(DISTINCT donor_id) FROM sponsorships WHERE status <> 'beeindigd') AS sponsors,
        (SELECT COUNT(*) FROM sponsorships WHERE status <> 'beeindigd') AS sponsorships,
        (SELECT COUNT(*) FROM children WHERE status = 'gesponsord') AS sponsored,
        (SELECT COUNT(*) FROM children WHERE status = 'beschikbaar') AS available,
        (SELECT COUNT(*) FROM children WHERE status IN ('concept','te_beoordelen')) AS in_review,
        (SELECT COALESCE(SUM(monthly_cents),0) FROM sponsorships WHERE status <> 'beeindigd') AS monthly_cents,
        (SELECT COUNT(*) FROM sponsorships WHERE status = 'betaling_gemist') AS missed,
        (SELECT COALESCE(SUM(remaining_cents),0) FROM cells WHERE category_key = 'noodfonds') AS fund_cents,
        (SELECT COUNT(*) FROM sponsorships s WHERE s.status <> 'beeindigd'
          AND NOT EXISTS (SELECT 1 FROM child_updates u WHERE u.child_id = s.child_id AND u.donor_id = s.donor_id AND u.month = ?)) AS updates_missing`, month);
      return { month, totals, config: SP.getConfig(db) };
    }, staff],
    ['GET', '/api/admin/sponsor/config', () => SP.getConfig(db), staff],
    ['PUT', '/api/admin/sponsor/config', (ctx) => SP.setConfig(db, ctx.body, ctx.actor), admin],

    ['GET', '/api/admin/children', (ctx) => {
      const where = ['1=1']; const args = [];
      if (CHILD_STATUSES.includes(ctx.query.status)) { where.push('ch.status = ?'); args.push(ctx.query.status); }
      if (ctx.query.q) { where.push("(ch.first_name || ' ' || ch.last_name || ' ' || COALESCE(r.name,'') || ' ' || ch.school) LIKE ?"); args.push(`%${ctx.query.q}%`); }
      return all(db, `SELECT ch.*, r.name AS family_name, r.location AS city, r.province,
          s.id AS sponsorship_id, s.status AS sponsorship_status, s.donor_id, s.missed_months,
          d.first_name AS d_first, d.last_name AS d_last, d.company_name AS d_company, d.donor_type AS d_type
        FROM children ch LEFT JOIN recipients r ON r.id = ch.family_id
        LEFT JOIN sponsorships s ON s.child_id = ch.id AND s.status <> 'beeindigd'
        LEFT JOIN donors d ON d.id = s.donor_id
        WHERE ${where.join(' AND ')} ORDER BY ch.status = 'gesponsord', ch.first_name COLLATE NOCASE`, ...args)
        .map((c) => ({ ...c, age: SP.age(c.birth_date),
          sponsor_name: c.donor_id ? S.donorFullName({ first_name: c.d_first, last_name: c.d_last, company_name: c.d_company, donor_type: c.d_type }) : '' }));
    }, staff],
    ['GET', '/api/admin/children/:id', (ctx) => {
      const cid = id(ctx.params.id);
      const c = get(db, `SELECT ch.*, r.name AS family_name, r.location AS city, r.province FROM children ch LEFT JOIN recipients r ON r.id = ch.family_id WHERE ch.id = ?`, cid);
      if (!c) throw new AppError(404, 'Kind niet gevonden');
      const sponsorships = all(db, `SELECT s.*, d.first_name, d.last_name, d.company_name, d.donor_type,
          (SELECT COUNT(*) FROM sponsor_months m WHERE m.sponsorship_id = s.id) AS months
        FROM sponsorships s JOIN donors d ON d.id = s.donor_id WHERE s.child_id = ? ORDER BY s.started_at DESC`, cid)
        .map((s) => ({ ...s, donor_name: S.donorFullName(s) }));
      const updates = all(db, 'SELECT u.*, us.name AS created_by_name FROM child_updates u LEFT JOIN users us ON us.id = u.created_by WHERE u.child_id = ? ORDER BY u.created_at DESC', cid);
      const months = all(db, 'SELECT month, amount_cents, donor_id FROM sponsor_months WHERE child_id = ? ORDER BY month DESC LIMIT 24', cid);
      return { ...c, age: SP.age(c.birth_date), sponsorships, updates, months };
    }, staff],
    ['POST', '/api/admin/children', (ctx) => {
      const b = childInput(db, ctx.body);
      const status = ['concept', 'te_beoordelen', 'beschikbaar'].includes(ctx.body.status) ? ctx.body.status : 'beschikbaar';
      const r = run(db, `INSERT INTO children (family_id, first_name, last_name, birth_date, gender, school, grade, story, photo_url, status)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, b.family_id, b.first_name, b.last_name, b.birth_date, b.gender, b.school, b.grade, b.story, b.photo_url, status);
      S.audit(db, ctx.actor, 'kind_toegevoegd', 'child', Number(r.lastInsertRowid));
      return get(db, 'SELECT * FROM children WHERE id = ?', Number(r.lastInsertRowid));
    }, staff],
    ['PUT', '/api/admin/children/:id', (ctx) => {
      const cid = id(ctx.params.id);
      const cur = get(db, 'SELECT * FROM children WHERE id = ?', cid);
      if (!cur) throw new AppError(404, 'Kind niet gevonden');
      const b = childInput(db, ctx.body);
      let status = cur.status;
      if (ctx.body.status && ctx.body.status !== cur.status) {
        if (cur.status === 'gesponsord') throw new AppError(409, 'Beëindig eerst het sponsorschap');
        if (!CHILD_STATUSES.includes(ctx.body.status) || ctx.body.status === 'gesponsord') throw new AppError(400, 'Ongeldige status');
        status = ctx.body.status;
      }
      run(db, `UPDATE children SET family_id=?, first_name=?, last_name=?, birth_date=?, gender=?, school=?, grade=?, story=?, photo_url=?, status=?,
        available_since = CASE WHEN ? = 'beschikbaar' AND status <> 'beschikbaar' THEN datetime('now') ELSE available_since END WHERE id=?`,
      b.family_id, b.first_name, b.last_name, b.birth_date, b.gender, b.school, b.grade, b.story, b.photo_url, status, status, cid);
      S.audit(db, ctx.actor, 'kind_gewijzigd', 'child', cid);
      return get(db, 'SELECT * FROM children WHERE id = ?', cid);
    }, staff],
    ['DELETE', '/api/admin/children/:id', (ctx) => {
      const cid = id(ctx.params.id);
      if (get(db, 'SELECT 1 AS x FROM sponsorships WHERE child_id = ?', cid)) throw new AppError(409, 'Dit kind heeft (gehad) een sponsor. Zet de status op inactief in plaats van verwijderen.');
      run(db, 'DELETE FROM children WHERE id = ?', cid);
      S.audit(db, ctx.actor, 'kind_verwijderd', 'child', cid);
    }, admin],

    ['GET', '/api/admin/sponsorships', (ctx) => {
      const where = ['1=1']; const args = [];
      if (['actief', 'betaling_gemist', 'beeindigd'].includes(ctx.query.status)) { where.push('s.status = ?'); args.push(ctx.query.status); }
      else where.push("s.status <> 'beeindigd'");
      if (ctx.query.donor_id) { where.push('s.donor_id = ?'); args.push(id(ctx.query.donor_id)); }
      return all(db, `SELECT s.*, ch.first_name AS child_name, ch.photo_url, ch.birth_date, r.name AS family_name,
          d.first_name, d.last_name, d.company_name, d.donor_type,
          (SELECT COUNT(*) FROM sponsor_months m WHERE m.sponsorship_id = s.id) AS months,
          (SELECT MAX(month) FROM sponsor_months m WHERE m.sponsorship_id = s.id) AS last_month
        FROM sponsorships s JOIN children ch ON ch.id = s.child_id JOIN donors d ON d.id = s.donor_id
        LEFT JOIN recipients r ON r.id = ch.family_id WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC, s.id DESC LIMIT 1000`, ...args)
        .map((s) => ({ ...s, donor_name: S.donorFullName(s), age: SP.age(s.birth_date) }));
    }, staff],
    // Medewerker koppelt een sponsor aan kinderen (bv. bij betaling per bankoverschrijving).
    ['POST', '/api/admin/sponsorships', (ctx) => {
      const did = id(ctx.body.donor_id);
      if (!get(db, 'SELECT id FROM donors WHERE id = ?', did)) throw new AppError(404, 'Sponsor niet gevonden');
      const ids = SP.reserve(db, did, Array.isArray(ctx.body.child_ids) ? ctx.body.child_ids : []);
      const sids = SP.startSponsorships(db, did, ids, { actor: ctx.actor });
      if (ctx.body.book_first) SP.bookPayment(db, { donorId: did, sponsorshipIds: sids, method: str(ctx.body.method, 30) || 'overschrijving', reference: str(ctx.body.reference, 100), actor: ctx.actor });
      return { sponsorship_ids: sids };
    }, staff],
    ['POST', '/api/admin/sponsorships/payment', (ctx) => {
      const did = id(ctx.body.donor_id);
      const sids = Array.isArray(ctx.body.sponsorship_ids) && ctx.body.sponsorship_ids.length
        ? ctx.body.sponsorship_ids.map(id) : mySponsorships(did).map((s) => s.id);
      const month = /^\d{4}-\d{2}$/.test(ctx.body.month || '') ? ctx.body.month : SP.currentMonth();
      const res = SP.bookPayment(db, { donorId: did, sponsorshipIds: sids, month, method: str(ctx.body.method, 30) || 'overschrijving', reference: str(ctx.body.reference, 100), actor: ctx.actor });
      if (!res) throw new AppError(400, 'Geen lopende sponsorschappen gevonden');
      return res;
    }, staff],
    // Automatische incasso (opnieuw) starten voor alle lopende sponsorschappen van deze sponsor zonder incasso.
    ['POST', '/api/admin/sponsorships/:id/subscription', async (ctx) => {
      const P = require('./payments');
      if (!P.isEnabled()) throw new AppError(400, 'Koppel eerst Mollie (Instellingen → Integraties)');
      const sp = get(db, 'SELECT * FROM sponsorships WHERE id = ?', id(ctx.params.id));
      if (!sp) throw new AppError(404, 'Sponsorschap niet gevonden');
      const donorRow = get(db, 'SELECT * FROM donors WHERE id = ?', sp.donor_id);
      if (!donorRow.mollie_customer_id) throw new AppError(400, 'Deze sponsor heeft nog nooit online betaald. Laat de sponsor één keer betalen via het portaal; daarmee geeft hij toestemming voor automatische incasso.');
      let mandates = [];
      try { mandates = ((await P.mandates(donorRow.mollie_customer_id))._embedded || {}).mandates || []; } catch { /* hieronder gemeld */ }
      if (!mandates.some((m) => m.status === 'valid' || m.status === 'pending')) {
        throw new AppError(400, 'Mollie heeft geen geldige machtiging voor deze sponsor. De sponsor moet één keer opnieuw betalen via het portaal.');
      }
      const ids = all(db, "SELECT id FROM sponsorships WHERE donor_id = ? AND status <> 'beeindigd' AND subscription_id IS NULL", sp.donor_id).map((x) => x.id);
      if (!ids.length) throw new AppError(409, 'Alle sponsorschappen van deze sponsor hebben al een automatische incasso');
      try {
        const sub = await startSubscription(donorRow, ids, { webhookUrl: `${publicBase(ctx)}/api/webhooks/mollie`, reference: `s${sp.id}` });
        S.audit(db, ctx.actor, 'incasso_gestart', 'sponsorship', sp.id, sub.id);
        return { ok: true, subscription_id: sub.id, sponsorships: ids.length };
      } catch (err) { throw new AppError(502, `Mollie: ${err.message}`); }
    }, staff],
    ['POST', '/api/admin/sponsorships/:id/missed', (ctx) => SP.missedPayment(db, [id(ctx.params.id)], ctx.actor), staff],
    ['POST', '/api/admin/sponsorships/:id/end', async (ctx) => {
      const s = get(db, 'SELECT * FROM sponsorships WHERE id = ?', id(ctx.params.id));
      if (!s) throw new AppError(404, 'Sponsorschap niet gevonden');
      SP.endSponsorship(db, s.id, str(ctx.body.reason, 200) || 'Beëindigd door medewerker', ctx.actor);
      await syncSubscription(get(db, 'SELECT * FROM donors WHERE id = ?', s.donor_id), s.subscription_id, ctx.actor);
      return { ok: true };
    }, staff],

    // Maandelijkse updates per kind
    ['GET', '/api/admin/updates', (ctx) => {
      const month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : SP.currentMonth();
      const rows = all(db, `SELECT s.id AS sponsorship_id, s.donor_id, ch.id AS child_id, ch.first_name, ch.photo_url, r.name AS family_name,
          d.first_name AS d_first, d.last_name AS d_last, d.company_name AS d_company, d.donor_type AS d_type,
          (SELECT COUNT(*) FROM child_updates u WHERE u.child_id = ch.id AND u.donor_id = s.donor_id AND u.month = ?) AS updates
        FROM sponsorships s JOIN children ch ON ch.id = s.child_id JOIN donors d ON d.id = s.donor_id
        LEFT JOIN recipients r ON r.id = ch.family_id WHERE s.status <> 'beeindigd' ORDER BY updates > 0, ch.first_name`, month)
        .map((x) => ({ ...x, sponsor_name: S.donorFullName({ first_name: x.d_first, last_name: x.d_last, company_name: x.d_company, donor_type: x.d_type }) }));
      return { month, rows, recent: all(db, `SELECT u.*, ch.first_name FROM child_updates u JOIN children ch ON ch.id = u.child_id ORDER BY u.created_at DESC LIMIT 30`) };
    }, staff],
    ['POST', '/api/admin/children/:id/updates', (ctx) => {
      const cid = id(ctx.params.id);
      const child = get(db, 'SELECT * FROM children WHERE id = ?', cid);
      if (!child) throw new AppError(404, 'Kind niet gevonden');
      const title = str(ctx.body.title, 200);
      if (!title) throw new AppError(400, 'Titel is verplicht');
      const type = ['brief', 'video', 'foto', 'tekst'].includes(ctx.body.type) ? ctx.body.type : 'foto';
      const month = /^\d{4}-\d{2}$/.test(ctx.body.month || '') ? ctx.body.month : SP.currentMonth();
      const s = get(db, "SELECT * FROM sponsorships WHERE child_id = ? AND status <> 'beeindigd'", cid);
      const r = run(db, 'INSERT INTO child_updates (child_id, donor_id, month, type, title, body, media_url, created_by) VALUES (?,?,?,?,?,?,?,?)',
        cid, s ? s.donor_id : null, month, type, title, str(ctx.body.body, 5000), str(ctx.body.media_url, 500), ctx.user.id);
      if (s) {
        const d = get(db, 'SELECT * FROM donors WHERE id = ?', s.donor_id);
        S.sendMail(db, d, `Nieuwe update van ${child.first_name}`,
          `Beste ${d.first_name || S.donorFullName(d)},\n\nEr staat een nieuwe update van ${child.first_name} voor je klaar: “${title}”. `
          + 'Bekijk hem in je sponsorportaal bij Mijn kinderen.\n\nRobin Foundation', 'update');
      }
      S.audit(db, ctx.actor, 'kindupdate_geplaatst', 'child', cid, title);
      return get(db, 'SELECT * FROM child_updates WHERE id = ?', Number(r.lastInsertRowid));
    }, staff],
    ['DELETE', '/api/admin/updates/:id', (ctx) => {
      run(db, 'DELETE FROM child_updates WHERE id = ?', id(ctx.params.id));
      S.audit(db, ctx.actor, 'kindupdate_verwijderd', 'child_update', id(ctx.params.id));
    }, staff],
    // Noodfonds: één gezamenlijke pot (gevuld met het noodfondsdeel van elke sponsorbetaling).
    ['GET', '/api/admin/noodfonds', () => {
      const t = get(db, `SELECT
        COALESCE((SELECT SUM(remaining_cents) FROM cells WHERE category_key = 'noodfonds'),0) AS balance_cents,
        COALESCE((SELECT SUM(amount_cents) FROM cells WHERE category_key = 'noodfonds'),0) AS in_cents,
        COALESCE((SELECT SUM(amount_cents) FROM expenditures WHERE category_key = 'noodfonds'),0) AS out_cents,
        (SELECT COUNT(*) FROM expenditures WHERE category_key = 'noodfonds') AS deployments`);
      // Inleg per maand (uit sponsorbetalingen en losse giften), alle jaren.
      const monthly = all(db, `SELECT strftime('%Y-%m', created_at) AS month, SUM(amount_cents) AS cents, COUNT(*) AS payments FROM cells
        WHERE category_key = 'noodfonds' GROUP BY month ORDER BY month DESC`);
      const items = all(db, `SELECT e.id, e.amount_cents, e.description, e.spent_at, e.created_at, r.id AS family_id, r.name AS family_name,
          r.location, r.province, u.name AS created_by_name
        FROM expenditures e LEFT JOIN recipients r ON r.id = e.recipient_id LEFT JOIN users u ON u.id = e.created_by
        WHERE e.category_key = 'noodfonds' ORDER BY e.spent_at DESC, e.id DESC LIMIT 500`);
      return { ...t, monthly, items };
    }, staff],
    ['POST', '/api/admin/noodfonds', (ctx) => S.spend(db, {
      category_key: 'noodfonds', amount_cents: ctx.body.amount_cents, recipient_id: ctx.body.recipient_id || null,
      description: str(ctx.body.description, 2000), spent_at: /^\d{4}-\d{2}-\d{2}$/.test(ctx.body.spent_at || '') ? ctx.body.spent_at : null, notify: false,
    }, ctx.actor, ctx.user.id), staff],
    ['DELETE', '/api/admin/noodfonds/:id', (ctx) => {
      const e = get(db, "SELECT id FROM expenditures WHERE id = ? AND category_key = 'noodfonds'", id(ctx.params.id));
      if (!e) throw new AppError(404, 'Inzet niet gevonden');
      return S.reverseExpenditure(db, e.id, ctx.actor);
    }, admin],
    ['GET', '/api/admin/leaderboard', (ctx) => SP.leaderboard(db, { limit: 500, label: ctx.query.label })
      .map((r) => ({ ...r, full_name: S.donorFullName(get(db, 'SELECT * FROM donors WHERE id = ?', r.donor_id)) })), staff],
  ];
  return { routes, handleSponsorPayment };
}

module.exports = { buildSponsorRoutes };

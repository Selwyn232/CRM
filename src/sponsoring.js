'use strict';
// Sponsormodel: een vast bedrag per kind per maand (standaard € 50), verdeeld over vaste onderdelen.
// Een betaling wordt automatisch geboekt als maand(en) voor de gesponsorde kinderen; het
// noodfonds-deel komt in een cel van de gezamenlijke noodfonds-pot.

const { tx, all, get, run } = require('./db');
const S = require('./services');
const { AppError } = S;

const DEFAULT_CONFIG = {
  amount_cents: 5000,
  parts: [
    { key: 'maaltijden', label: 'Schoolmaaltijden', description: 'Elke schooldag een voedzame maaltijd', icon: 'utensils', cents: 2300 },
    { key: 'school', label: 'Schoolgeld en schoolspullen', description: 'Inschrijving, uniform, schriften en vervoer', icon: 'graduation-cap', cents: 1700 },
    { key: 'verzorging', label: 'Basisverzorging', description: 'Zeep, tandenborstel en tandpasta', icon: 'heart-pulse', cents: 500 },
    { key: 'noodfonds', label: 'Robin Noodfonds', description: 'Gezamenlijke pot voor orkanen en overstromingen', icon: 'cloud-lightning', cents: 500, fund: true },
  ],
};
const REMINDER_AFTER = 1; // gemiste maanden tot herinnering
const RELEASE_AFTER = 2; // gemiste maanden tot het kind weer vrijkomt

function getConfig(db) {
  const row = get(db, "SELECT value FROM settings WHERE key = 'sponsor_config'");
  try { if (row && row.value) return JSON.parse(row.value); } catch { /* standaard */ }
  return DEFAULT_CONFIG;
}

function setConfig(db, input, actor) {
  const amount = Math.round(Number(input.amount_cents));
  if (!Number.isInteger(amount) || amount < 100) throw new AppError(400, 'Kies een bedrag per kind');
  if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 12) throw new AppError(400, 'Voeg minimaal één onderdeel toe');
  const keys = new Set();
  const parts = input.parts.map((p, i) => {
    const cents = Math.round(Number(p.cents));
    const label = String(p.label || '').trim().slice(0, 60);
    if (!label) throw new AppError(400, `Onderdeel ${i + 1} heeft geen naam`);
    if (!Number.isInteger(cents) || cents < 0) throw new AppError(400, `Ongeldig bedrag bij “${label}”`);
    let key = String(p.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || `deel${i + 1}`;
    while (keys.has(key)) key += 'x';
    keys.add(key);
    return { key, label, description: String(p.description || '').trim().slice(0, 140), icon: String(p.icon || 'circle').slice(0, 30), cents, fund: !!p.fund };
  });
  const sum = parts.reduce((s, p) => s + p.cents, 0);
  if (sum !== amount) throw new AppError(400, `De onderdelen tellen op tot ${S.euro(sum)}, maar het bedrag per kind is ${S.euro(amount)}.`);
  if (parts.filter((p) => p.fund).length > 1) throw new AppError(400, 'Maar één onderdeel kan naar het noodfonds gaan');
  const config = { amount_cents: amount, parts };
  run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('sponsor_config', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify(config));
  run(db, "UPDATE categories SET unit_cost_cents = ? WHERE key = 'sponsoring'", amount);
  S.audit(db, actor, 'sponsorbedrag_gewijzigd', 'settings', null, config);
  return config;
}

const currentMonth = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return currentMonth(new Date(y, mo, 1)); };
const age = (birth) => {
  if (!birth) return null;
  const b = new Date(birth); const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
};

// Publiek (voor donateurs) toonbare info over een kind: geen achternaam, adres of documenten.
function publicChild(c) {
  return {
    id: c.id, first_name: c.first_name, age: age(c.birth_date), gender: c.gender, school: c.school, grade: c.grade,
    story: c.story, photo_url: c.photo_url, city: c.city || '', province: c.province || '', country: c.country || 'Filipijnen',
    family_id: c.family_id, // gezinsverhaal en -foto blijven intern; het portaal draait om het kind
  };
}

const CHILD_SELECT = `SELECT ch.*, r.location AS city, r.province, r.country, r.story AS family_story,
  CASE WHEN r.consent = 1 THEN r.photo_url ELSE '' END AS family_photo, r.name AS family_name
  FROM children ch LEFT JOIN recipients r ON r.id = ch.family_id`;

function availableChildren(db, donorId = null) {
  return all(db, `${CHILD_SELECT} WHERE ch.status = 'beschikbaar'
      AND (ch.reserved_until IS NULL OR ch.reserved_until < datetime('now') OR ch.reserved_by = ?)
    ORDER BY ch.available_since ASC, ch.id ASC`, donorId || 0).map(publicChild);
}

// Kinderen tijdelijk reserveren tijdens het afrekenen (30 minuten), zodat twee donateurs niet hetzelfde kind kiezen.
function reserve(db, donorId, childIds) {
  const ids = [...new Set(childIds.map(Number).filter(Boolean))];
  if (!ids.length) throw new AppError(400, 'Kies minimaal één kind');
  if (ids.length > 50) throw new AppError(400, 'Neem voor meer dan 50 kinderen contact met ons op');
  return tx(db, () => {
    for (const id of ids) {
      const c = get(db, 'SELECT * FROM children WHERE id = ?', id);
      const free = c && c.status === 'beschikbaar' && (!c.reserved_until || c.reserved_until < new Date().toISOString().replace('T', ' ').slice(0, 19) || c.reserved_by === donorId);
      if (!free) throw new AppError(409, `${c ? c.first_name : 'Een kind'} is net door iemand anders gekozen. Kies een ander kind.`);
      run(db, "UPDATE children SET reserved_until = datetime('now', '+30 minutes'), reserved_by = ? WHERE id = ?", donorId, id);
    }
    return ids;
  });
}

// Sponsorschappen starten voor de gekozen kinderen.
function startSponsorships(db, donorId, childIds, { subscriptionId = null, actor = 'systeem' } = {}) {
  const cfg = getConfig(db);
  const created = [];
  for (const id of childIds) {
    const c = get(db, 'SELECT * FROM children WHERE id = ?', id);
    if (!c || c.status !== 'beschikbaar') continue; // inmiddels niet meer vrij (komt zelden voor)
    const r = run(db, 'INSERT INTO sponsorships (donor_id, child_id, monthly_cents, subscription_id) VALUES (?,?,?,?)',
      donorId, id, cfg.amount_cents, subscriptionId);
    run(db, "UPDATE children SET status = 'gesponsord', reserved_until = NULL, reserved_by = NULL WHERE id = ?", id);
    created.push(Number(r.lastInsertRowid));
    S.audit(db, actor, 'sponsoring_gestart', 'child', id, { donorId });
  }
  if (created.length) {
    const donor = get(db, 'SELECT * FROM donors WHERE id = ?', donorId);
    run(db, "UPDATE donors SET status = 'actief' WHERE id = ? AND status = 'prospect'", donorId);
    const names = all(db, `SELECT ch.first_name FROM sponsorships s JOIN children ch ON ch.id = s.child_id WHERE s.id IN (${created.map(() => '?').join(',')})`, ...created).map((x) => x.first_name);
    S.sendMail(db, donor, `Welkom als sponsor van ${names.join(', ')}!`,
      `Beste ${donor.first_name || S.donorFullName(donor)},\n\nWat fijn dat je ${names.length === 1 ? names[0] : `${names.length} kinderen`} gaat sponsoren. `
      + `Voor ${S.euro(cfg.amount_cents)} per maand betaal je per kind: ${cfg.parts.map((p) => `${p.label.toLowerCase()} (${S.euro(p.cents)})`).join(', ')}.\n\n`
      + 'In je donateursportaal zie je elke maand waar je geld heen gaat, ontvang je foto’s en updates, en kun je chatten met het gezin.\n\nRobin Foundation', 'welkom');
  }
  return created;
}

// Een ontvangen maandbetaling boeken voor de opgegeven sponsorschappen.
function bookPayment(db, { donorId, sponsorshipIds, amountCents = null, reference = '', method = 'online', month = currentMonth(), actor = 'systeem', donationId: existing = null }) {
  const cfg = getConfig(db);
  const spons = sponsorshipIds.map((id) => get(db, 'SELECT * FROM sponsorships WHERE id = ? AND donor_id = ?', id, donorId)).filter((x) => x && x.status !== 'beeindigd');
  if (!spons.length) return null;
  const expected = spons.reduce((s, x) => s + x.monthly_cents, 0);
  const total = amountCents ?? expected;
  return tx(db, () => {
    let donationId = existing;
    if (existing) {
      run(db, "UPDATE donations SET status = 'ontvangen', method = ?, amount_cents = ?, received_at = date('now') WHERE id = ?", method, total, existing);
    } else {
      const r = run(db, `INSERT INTO donations (donor_id, category_key, amount_cents, method, frequency, status, reference, received_at)
        VALUES (?, 'sponsoring', ?, ?, 'maandelijks', 'ontvangen', ?, date('now'))`, donorId, total, method, reference);
      donationId = Number(r.lastInsertRowid);
    }
    let fundCents = 0;
    for (const sp of spons) {
      // Verdeling per kind naar rato van het bedrag van dit sponsorschap (normaal precies de config)
      const share = sp.monthly_cents / cfg.amount_cents;
      const lines = cfg.parts.map((p) => ({ key: p.key, label: p.label, description: p.description, icon: p.icon, fund: !!p.fund, cents: Math.round(p.cents * share) }));
      fundCents += lines.filter((l) => l.fund).reduce((s, l) => s + l.cents, 0);
      // Een maand die al geboekt is (bv. dubbele webhook) schuift door naar de volgende maand.
      let m = month;
      while (get(db, 'SELECT id FROM sponsor_months WHERE sponsorship_id = ? AND month = ?', sp.id, m)) m = nextMonth(m);
      run(db, 'INSERT INTO sponsor_months (sponsorship_id, donor_id, child_id, donation_id, month, amount_cents, lines) VALUES (?,?,?,?,?,?,?)',
        sp.id, donorId, sp.child_id, donationId, m, sp.monthly_cents, JSON.stringify(lines));
      run(db, "UPDATE sponsorships SET missed_months = 0, status = 'actief' WHERE id = ?", sp.id);
    }
    if (fundCents > 0) {
      run(db, `INSERT INTO cells (donation_id, donor_id, category_key, amount_cents, remaining_cents, status) VALUES (?,?, 'noodfonds', ?, ?, 'wachtend')`,
        donationId, donorId, fundCents, fundCents);
    }
    S.audit(db, actor, 'maand_geboekt', 'donation', donationId, { donorId, sponsorships: spons.length, total });
    return { donation_id: donationId, months: spons.length, fund_cents: fundCents };
  });
}

// Gemiste betaling (bv. mislukte incasso). Na 1 keer herinnering, na 2 keer komt het kind vrij.
function missedPayment(db, sponsorshipIds, actor = 'systeem') {
  const out = [];
  for (const id of sponsorshipIds) {
    const sp = get(db, 'SELECT * FROM sponsorships WHERE id = ?', id);
    if (!sp || sp.status === 'beeindigd') continue;
    const missed = sp.missed_months + 1;
    const child = get(db, 'SELECT * FROM children WHERE id = ?', sp.child_id);
    const donor = get(db, 'SELECT * FROM donors WHERE id = ?', sp.donor_id);
    if (missed >= RELEASE_AFTER) {
      endSponsorship(db, id, 'Betaling 2 maanden niet gelukt', actor);
      out.push({ id, released: true });
    } else {
      run(db, "UPDATE sponsorships SET missed_months = ?, status = 'betaling_gemist' WHERE id = ?", missed, id);
      if (missed >= REMINDER_AFTER) {
        S.sendMail(db, donor, `Je betaling voor ${child.first_name} is niet gelukt`,
          `Beste ${donor.first_name || S.donorFullName(donor)},\n\nDe maandelijkse betaling voor ${child.first_name} is niet gelukt. `
          + `Wil je controleren of er genoeg saldo is of je betaalgegevens kloppen? Lukt ook de volgende betaling niet, dan zoeken we een nieuwe sponsor voor ${child.first_name}.\n\nRobin Foundation`, 'herinnering');
      }
      out.push({ id, missed });
    }
  }
  return out;
}

function endSponsorship(db, id, reason = '', actor = 'systeem') {
  const sp = get(db, 'SELECT * FROM sponsorships WHERE id = ?', id);
  if (!sp || sp.status === 'beeindigd') return;
  const child = get(db, 'SELECT * FROM children WHERE id = ?', sp.child_id);
  const donor = get(db, 'SELECT * FROM donors WHERE id = ?', sp.donor_id);
  tx(db, () => {
    run(db, "UPDATE sponsorships SET status = 'beeindigd', ended_at = datetime('now'), end_reason = ? WHERE id = ?", String(reason).slice(0, 200), id);
    run(db, "UPDATE children SET status = 'beschikbaar', available_since = datetime('now') WHERE id = ? AND status = 'gesponsord'", sp.child_id);
  });
  S.sendMail(db, donor, `Je sponsorschap van ${child.first_name} is beëindigd`,
    `Beste ${donor.first_name || S.donorFullName(donor)},\n\nJe sponsorschap van ${child.first_name} is beëindigd${reason ? ` (${reason})` : ''}. `
    + `Dank je wel voor alles wat je voor ${child.first_name} hebt gedaan. We zoeken een nieuwe sponsor zodat de hulp doorgaat.\n\nRobin Foundation`, 'sponsoring');
  S.audit(db, actor, 'sponsoring_beeindigd', 'sponsorship', id, reason);
}

// Leaderboard: op aantal actieve sponsorkinderen, daarna op totaal gesponsorde maanden.
function leaderboard(db, { limit = 50 } = {}) {
  return all(db, `SELECT d.id, d.anonymous, d.display_name, d.first_name, d.last_name, d.company_name, d.donor_type, d.city,
      (SELECT COUNT(*) FROM sponsorships s WHERE s.donor_id = d.id AND s.status <> 'beeindigd') AS children,
      (SELECT COUNT(*) FROM sponsor_months m WHERE m.donor_id = d.id) AS months,
      (SELECT MIN(started_at) FROM sponsorships s WHERE s.donor_id = d.id) AS since
    FROM donors d WHERE EXISTS (SELECT 1 FROM sponsorships s WHERE s.donor_id = d.id AND s.status <> 'beeindigd')
    ORDER BY children DESC, months DESC, since ASC LIMIT ?`, Math.min(Number(limit) || 50, 500))
    .map((r, i) => ({ rank: i + 1, donor_id: r.id, name: S.donorPublicName(r), anonymous: !!r.anonymous, city: r.anonymous ? '' : r.city,
      children: r.children, months: r.months, since: r.since }));
}

module.exports = {
  DEFAULT_CONFIG, getConfig, setConfig, currentMonth, nextMonth, age, publicChild, CHILD_SELECT,
  availableChildren, reserve, startSponsorships, bookPayment, missedPayment, endSponsorship, leaderboard,
};

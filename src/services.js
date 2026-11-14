'use strict';
// Domeinlogica: donaties -> cellen -> bestedingen -> impactberichten.

const { tx, all, get, run } = require('./db');

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const euro = (cents) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);

function audit(db, actor, action, entity, entityId, details = '') {
  run(db, 'INSERT INTO audit_log (actor, action, entity, entity_id, details) VALUES (?,?,?,?,?)',
    actor || 'systeem', action, entity, entityId ?? null,
    typeof details === 'string' ? details : JSON.stringify(details));
}

function getCategory(db, key) {
  const cat = get(db, 'SELECT * FROM categories WHERE key = ?', key);
  if (!cat) throw new AppError(400, `Onbekende bestemming: ${key}`);
  return cat;
}

function donorFullName(d) {
  if (!d) return '';
  if (d.donor_type !== 'particulier' && d.company_name) return d.company_name;
  return `${d.first_name || ''} ${d.last_name || ''}`.trim() || d.email || `Donateur #${d.id}`;
}

// Naam zoals die publiek (leaderboard) wordt getoond.
function donorPublicName(d) {
  if (d.anonymous) return 'Anonieme donateur';
  if (d.display_name) return d.display_name;
  if (d.donor_type !== 'particulier' && d.company_name) return d.company_name;
  const initial = d.last_name ? ` ${d.last_name.trim().charAt(0).toUpperCase()}.` : '';
  return `${d.first_name || 'Donateur'}${initial}`;
}

// ---------------------------------------------------------------------------
// E-mail (gesimuleerd): alles komt in de outbox-tabel terecht.
// ---------------------------------------------------------------------------
function sendMail(db, donor, subject, body, kind = 'algemeen') {
  if (!donor || !donor.email) return;
  const r = run(db, 'INSERT INTO outbox (donor_id, to_email, subject, body, kind) VALUES (?,?,?,?,?)',
    donor.id, donor.email, subject, body, kind);
  deliver(db, Number(r.lastInsertRowid));
}

// Echt versturen (als e-mail is ingesteld) ná de huidige transactie; resultaat komt in de e-mail log.
function deliver(db, outboxId) {
  const mailer = require('./mailer');
  if (!mailer.isEnabled()) return;
  setImmediate(async () => {
    const m = get(db, 'SELECT * FROM outbox WHERE id = ?', outboxId);
    if (!m || m.status === 'verzonden') return; // bv. transactie teruggedraaid
    try {
      const pid = await mailer.send({ to: m.to_email, subject: m.subject, text: m.body });
      run(db, "UPDATE outbox SET status = 'verzonden', provider_id = ?, error = '' WHERE id = ?", pid, outboxId);
    } catch (err) {
      run(db, "UPDATE outbox SET status = 'mislukt', error = ? WHERE id = ?", String(err.message).slice(0, 300), outboxId);
    }
  });
}

// ---------------------------------------------------------------------------
// Donaties & cellen
// ---------------------------------------------------------------------------
function createCellForDonation(db, donation) {
  run(db, `INSERT INTO cells (donation_id, donor_id, category_key, amount_cents, remaining_cents, status)
           VALUES (?,?,?,?,?, 'wachtend')`,
    donation.id, donation.donor_id, donation.category_key, donation.amount_cents, donation.amount_cents);
}

function createDonation(db, input, actor) {
  const amount = Math.round(Number(input.amount_cents));
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError(400, 'Bedrag moet groter zijn dan 0');
  const donor = get(db, 'SELECT * FROM donors WHERE id = ?', input.donor_id);
  if (!donor) throw new AppError(404, 'Donateur niet gevonden');
  const cat = getCategory(db, input.category_key);
  if (cat.key === 'sponsoring' && !input._sponsor) throw new AppError(400, 'Sponsorbetalingen registreer je bij Sponsorschappen.');
  const status = input.status || 'ontvangen';

  return tx(db, () => {
    const r = run(db, `INSERT INTO donations
      (donor_id, category_key, campaign_id, amount_cents, method, frequency, status, reference, note, received_at)
      VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, date('now')))`,
      donor.id, cat.key, input.campaign_id || null, amount, input.method || 'ideal',
      input.frequency || 'eenmalig', status, input.reference || '', input.note || '',
      input.received_at || null);
    const donation = get(db, 'SELECT * FROM donations WHERE id = ?', Number(r.lastInsertRowid));
    if (status === 'ontvangen') {
      createCellForDonation(db, donation);
      sendMail(db, donor, `Bedankt voor je donatie van ${euro(amount)}!`,
        `Beste ${donor.first_name || donorFullName(donor)},\n\nHartelijk dank voor je donatie van ${euro(amount)} ` +
        `voor "${cat.name}". Je geld staat veilig in een eigen cel tot het wordt uitgegeven. ` +
        `Zodra dat gebeurt, ontvang je een bericht van degene die ermee geholpen is.\n\nRobin Foundation`,
        'bedankt');
    }
    if (donor.status === 'prospect') run(db, "UPDATE donors SET status='actief' WHERE id=?", donor.id);
    audit(db, actor, 'donatie_aangemaakt', 'donation', donation.id, { amount, category: cat.key, status });
    return donation;
  });
}

function updateDonation(db, id, input, actor) {
  const donation = get(db, 'SELECT * FROM donations WHERE id = ?', id);
  if (!donation) throw new AppError(404, 'Donatie niet gevonden');
  const cell = get(db, 'SELECT * FROM cells WHERE donation_id = ?', id);
  const touched = cell && cell.remaining_cents !== cell.amount_cents;

  const next = {
    amount_cents: input.amount_cents != null ? Math.round(Number(input.amount_cents)) : donation.amount_cents,
    category_key: input.category_key || donation.category_key,
    status: input.status || donation.status,
    method: input.method ?? donation.method,
    frequency: input.frequency ?? donation.frequency,
    reference: input.reference ?? donation.reference,
    note: input.note ?? donation.note,
    received_at: input.received_at || donation.received_at,
    campaign_id: input.campaign_id !== undefined ? (input.campaign_id || null) : donation.campaign_id,
  };
  if (!Number.isInteger(next.amount_cents) || next.amount_cents <= 0) throw new AppError(400, 'Ongeldig bedrag');
  getCategory(db, next.category_key);

  const financialChange = next.amount_cents !== donation.amount_cents ||
    next.category_key !== donation.category_key || next.status !== donation.status;
  if (donation.category_key === 'sponsoring' && financialChange) {
    throw new AppError(409, 'Dit is een sponsorbetaling. Pas sponsorschappen aan via Sponsorschappen.');
  }
  if (touched && financialChange) {
    throw new AppError(409, 'Deze donatie is (deels) uitgegeven; bedrag, bestemming en status kunnen niet meer worden gewijzigd. Draai eerst de besteding terug.');
  }

  return tx(db, () => {
    run(db, `UPDATE donations SET amount_cents=?, category_key=?, status=?, method=?, frequency=?, reference=?,
             note=?, received_at=?, campaign_id=? WHERE id=?`,
      next.amount_cents, next.category_key, next.status, next.method, next.frequency, next.reference,
      next.note, next.received_at, next.campaign_id, id);
    const updated = get(db, 'SELECT * FROM donations WHERE id = ?', id);
    if (next.status === 'ontvangen') {
      if (!cell) createCellForDonation(db, updated);
      else run(db, 'UPDATE cells SET amount_cents=?, remaining_cents=?, category_key=? WHERE id=?',
        next.amount_cents, next.amount_cents, next.category_key, cell.id);
    } else if (cell) {
      run(db, 'DELETE FROM cells WHERE id = ?', cell.id);
    }
    audit(db, actor, 'donatie_gewijzigd', 'donation', id, next);
    return updated;
  });
}

function deleteDonation(db, id, actor) {
  const cell = get(db, 'SELECT * FROM cells WHERE donation_id = ?', id);
  if (cell && cell.remaining_cents !== cell.amount_cents) {
    throw new AppError(409, 'Deze donatie is (deels) uitgegeven en kan niet worden verwijderd.');
  }
  tx(db, () => {
    run(db, 'DELETE FROM donations WHERE id = ?', id);
    audit(db, actor, 'donatie_verwijderd', 'donation', id);
  });
}

function refreshCellStatus(db, cellId) {
  const c = get(db, 'SELECT * FROM cells WHERE id = ?', cellId);
  let status = 'wachtend';
  if (c.remaining_cents === 0) status = 'besteed';
  else if (c.remaining_cents < c.amount_cents) status = 'deels_besteed';
  run(db, `UPDATE cells SET status = ?, spent_at = CASE WHEN ? = 'besteed' THEN datetime('now') ELSE NULL END
           WHERE id = ?`, status, status, cellId);
}

// ---------------------------------------------------------------------------
// Besteding: geld uit cellen halen ("cel triggeren").
//  - met cell_ids: precies die cellen (in die volgorde) worden aangesproken
//  - zonder cell_ids: oudste cellen eerst (FIFO) binnen de bestemming
// ---------------------------------------------------------------------------
function spend(db, input, actor, userId = null) {
  const cat = getCategory(db, input.category_key);
  const cellIds = Array.isArray(input.cell_ids) ? input.cell_ids.map(Number).filter(Boolean) : [];

  let cells;
  if (cellIds.length) {
    const placeholders = cellIds.map(() => '?').join(',');
    const found = all(db, `SELECT * FROM cells WHERE id IN (${placeholders})`, ...cellIds);
    const byId = new Map(found.map((c) => [c.id, c]));
    cells = cellIds.map((id) => byId.get(id)).filter(Boolean);
    if (cells.length !== cellIds.length) throw new AppError(400, 'Eén of meer cellen bestaan niet');
    if (cells.some((c) => c.category_key !== cat.key)) {
      throw new AppError(400, 'Alle geselecteerde cellen moeten dezelfde bestemming hebben');
    }
    cells = cells.filter((c) => c.remaining_cents > 0);
  } else if (input.donor_id) {
    // Alleen uit de cellen van één donateur (oudste eerst).
    cells = all(db, `SELECT * FROM cells WHERE category_key = ? AND donor_id = ? AND remaining_cents > 0
                     ORDER BY created_at ASC, id ASC`, cat.key, Number(input.donor_id));
  } else {
    cells = all(db, `SELECT * FROM cells WHERE category_key = ? AND remaining_cents > 0
                     ORDER BY created_at ASC, id ASC`, cat.key);
  }
  const available = cells.reduce((s, c) => s + c.remaining_cents, 0);

  let units = input.units != null && input.units !== '' ? Math.round(Number(input.units)) : null;
  let amount = input.amount_cents != null && input.amount_cents !== '' ? Math.round(Number(input.amount_cents)) : null;
  if (amount == null && units != null && cat.unit_cost_cents) amount = units * cat.unit_cost_cents;
  if (amount == null && cellIds.length) amount = available; // hele geselecteerde cellen besteden
  if (units == null && amount != null && cat.unit_cost_cents) {
    const u = Math.floor(amount / cat.unit_cost_cents);
    units = u > 0 ? u : null;
  }
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError(400, 'Geef een bedrag of aantal op');
  if (available < amount) {
    throw new AppError(409, `Onvoldoende saldo in de cellen voor "${cat.name}"${input.donor_id && !cellIds.length ? ' van deze donateur' : ''}: beschikbaar ${euro(available)}, nodig ${euro(amount)}.`);
  }
  if (input.recipient_id && !get(db, 'SELECT id FROM recipients WHERE id = ?', input.recipient_id)) {
    throw new AppError(400, 'Ontvanger niet gevonden');
  }

  const result = tx(db, () => {
    const r = run(db, `INSERT INTO expenditures (category_key, recipient_id, amount_cents, units, description, spent_at, created_by)
                       VALUES (?,?,?,?,?, COALESCE(?, date('now')), ?)`,
      cat.key, input.recipient_id || null, amount, units, input.description || '', input.spent_at || null, userId);
    const expenditureId = Number(r.lastInsertRowid);

    let left = amount;
    const perDonor = new Map();
    for (const cell of cells) {
      if (left === 0) break;
      const take = Math.min(cell.remaining_cents, left);
      run(db, 'INSERT INTO allocations (expenditure_id, cell_id, donor_id, amount_cents) VALUES (?,?,?,?)',
        expenditureId, cell.id, cell.donor_id, take);
      run(db, 'UPDATE cells SET remaining_cents = remaining_cents - ? WHERE id = ?', take, cell.id);
      refreshCellStatus(db, cell.id);
      perDonor.set(cell.donor_id, (perDonor.get(cell.donor_id) || 0) + take);
      left -= take;
    }

    const recipient = input.recipient_id ? get(db, 'SELECT * FROM recipients WHERE id = ?', input.recipient_id) : null;
    for (const [donorId, cents] of perDonor) {
      const donor = get(db, 'SELECT * FROM donors WHERE id = ?', donorId);
      sendMail(db, donor, `Je donatie is besteed: ${cat.name}`,
        `Beste ${donor.first_name || donorFullName(donor)},\n\n${euro(cents)} uit jouw cel is zojuist besteed aan ` +
        `"${cat.name}"${recipient ? ` voor ${recipient.name}` : ''}.` +
        `${input.description ? `\n\n${input.description}` : ''}\n\nBekijk in je donateursportaal waar je geld precies heen is gegaan.` +
        `\n\nRobin Foundation`, 'besteding');
    }
    audit(db, actor, 'besteding_aangemaakt', 'expenditure', expenditureId,
      { amount, category: cat.key, cells: cells.length, donors: perDonor.size });

    if (input.message && input.message.title) {
      addImpactMessage(db, expenditureId, input.message, actor, false);
    }
    return { id: expenditureId, amount_cents: amount, units, donors: perDonor.size };
  });
  return result;
}

// Besteding terugdraaien: geld terug in de cellen.
function reverseExpenditure(db, id, actor) {
  const exp = get(db, 'SELECT * FROM expenditures WHERE id = ?', id);
  if (!exp) throw new AppError(404, 'Besteding niet gevonden');
  tx(db, () => {
    const allocs = all(db, 'SELECT * FROM allocations WHERE expenditure_id = ?', id);
    for (const a of allocs) {
      run(db, 'UPDATE cells SET remaining_cents = remaining_cents + ? WHERE id = ?', a.amount_cents, a.cell_id);
      refreshCellStatus(db, a.cell_id);
    }
    run(db, 'DELETE FROM expenditures WHERE id = ?', id);
    audit(db, actor, 'besteding_teruggedraaid', 'expenditure', id, { amount: exp.amount_cents });
  });
}

// Brief / filmpje / foto van de ontvanger koppelen en bezorgen bij alle betrokken donateurs.
function addImpactMessage(db, expenditureId, msg, actor, useTx = true) {
  const exp = get(db, 'SELECT * FROM expenditures WHERE id = ?', expenditureId);
  if (!exp) throw new AppError(404, 'Besteding niet gevonden');
  if (!msg.title || !String(msg.title).trim()) throw new AppError(400, 'Titel is verplicht');
  const type = msg.type || 'brief';
  if (!['brief', 'video', 'foto', 'tekst'].includes(type)) throw new AppError(400, 'Ongeldig berichttype');

  const work = () => {
    const r = run(db, `INSERT INTO impact_messages (expenditure_id, recipient_id, type, title, body, media_url)
                       VALUES (?,?,?,?,?,?)`,
      expenditureId, msg.recipient_id || exp.recipient_id || null, type, String(msg.title).trim(),
      msg.body || '', msg.media_url || '');
    const messageId = Number(r.lastInsertRowid);
    const donors = all(db, `SELECT DISTINCT d.* FROM allocations a JOIN donors d ON d.id = a.donor_id
                            WHERE a.expenditure_id = ?`, expenditureId);
    const label = { brief: 'een brief', video: 'een filmpje', foto: 'een foto', tekst: 'een bericht' }[type];
    for (const d of donors) {
      run(db, 'INSERT OR IGNORE INTO donor_messages (donor_id, impact_message_id) VALUES (?,?)', d.id, messageId);
      sendMail(db, d, `Je hebt ${label} ontvangen: ${msg.title}`,
        `Beste ${d.first_name || donorFullName(d)},\n\nDankzij jouw donatie hebben we ${label} ontvangen van ` +
        `degene die je geholpen hebt. Log in op je donateursportaal om het te bekijken.\n\nRobin Foundation`,
        'impactbericht');
    }
    audit(db, actor, 'impactbericht_verstuurd', 'impact_message', messageId, { expenditureId, donors: donors.length });
    return { id: messageId, delivered_to: donors.length };
  };
  return useTx ? tx(db, work) : work();
}

// ---------------------------------------------------------------------------
// Rapportage-hulpjes
// ---------------------------------------------------------------------------
function categoryBalances(db) {
  return all(db, `
    SELECT c.*,
      COALESCE((SELECT SUM(amount_cents) FROM donations WHERE category_key=c.key AND status='ontvangen'),0) AS received_cents,
      COALESCE((SELECT SUM(remaining_cents) FROM cells WHERE category_key=c.key),0) AS waiting_cents,
      COALESCE((SELECT SUM(amount_cents) FROM expenditures WHERE category_key=c.key),0) AS spent_cents,
      COALESCE((SELECT SUM(units) FROM expenditures WHERE category_key=c.key),0) AS units_spent,
      (SELECT COUNT(*) FROM cells WHERE category_key=c.key AND remaining_cents>0) AS open_cells
    FROM categories c ORDER BY c.sort_order`);
}

// Impact per bestemming voor één donateur.
function donorImpact(db, donorId) {
  return all(db, `
    SELECT c.key, c.name, c.icon, c.color, c.unit_label, c.unit_label_plural, c.unit_cost_cents,
      COALESCE((SELECT SUM(amount_cents) FROM donations WHERE donor_id=? AND category_key=c.key AND status='ontvangen'),0) AS donated_cents,
      COALESCE((SELECT SUM(remaining_cents) FROM cells WHERE donor_id=? AND category_key=c.key),0) AS waiting_cents,
      COALESCE((SELECT SUM(a.amount_cents) FROM allocations a JOIN cells ce ON ce.id=a.cell_id
                WHERE a.donor_id=? AND ce.category_key=c.key),0) AS spent_cents
    FROM categories c ORDER BY c.sort_order`, donorId, donorId, donorId)
    .map((r) => ({ ...r, units_funded: r.unit_cost_cents ? r.spent_cents / r.unit_cost_cents : null }));
}

function leaderboard(db, { period = 'all', category = '', limit = 50 } = {}) {
  const where = ["dn.status = 'ontvangen'"];
  const params = [];
  if (period === 'year') where.push("dn.received_at >= date('now','start of year')");
  else if (period === 'month') where.push("dn.received_at >= date('now','start of month')");
  else if (/^\d{4}$/.test(String(period))) { where.push("strftime('%Y', dn.received_at) = ?"); params.push(String(period)); }
  if (category) { where.push('dn.category_key = ?'); params.push(category); }
  const rows = all(db, `
    SELECT d.id, d.anonymous, d.display_name, d.first_name, d.last_name, d.company_name, d.donor_type, d.city,
      SUM(dn.amount_cents) AS total_cents, COUNT(dn.id) AS donation_count,
      COUNT(DISTINCT dn.category_key) AS category_count,
      COALESCE((SELECT SUM(a.amount_cents) FROM allocations a WHERE a.donor_id = d.id),0) AS spent_cents,
      (SELECT COUNT(*) FROM donor_messages m WHERE m.donor_id = d.id) AS messages
    FROM donations dn JOIN donors d ON d.id = dn.donor_id
    WHERE ${where.join(' AND ')}
    GROUP BY d.id ORDER BY total_cents DESC, MIN(dn.received_at) ASC
    LIMIT ?`, ...params, Math.min(Number(limit) || 50, 500));
  return rows.map((r, i) => ({
    rank: i + 1,
    donor_id: r.id,
    name: donorPublicName(r),
    anonymous: !!r.anonymous,
    city: r.anonymous ? '' : r.city,
    total_cents: r.total_cents,
    donation_count: r.donation_count,
    category_count: r.category_count,
    spent_cents: r.spent_cents,
    messages: r.messages,
  }));
}


// ---------------------------------------------------------------------------
// Chat tussen ontvanger en donateur
//  - alleen tussen een donateur en een ontvanger aan wie diens geld is besteed
//  - kinderen: altijd moderatie; contactgegevens/geldverzoeken: altijd moderatie
// ---------------------------------------------------------------------------
const CONTACT_PATTERNS = [
  [/[^\s@]+@[^\s@]+\.[^\s@]{2,}/, 'e-mailadres'],
  [/\+?\d[\d\s\-().]{7,}\d/, 'telefoonnummer'],
  [/(https?:\/\/|www\.)\S+/i, 'link'],
  [/\b(whatsapp|instagram|insta|facebook|tiktok|snapchat|snap|telegram|signal|discord)\b/i, 'social media'],
  [/(^|\s)@[a-z0-9_.]{3,}/i, 'social media'],
  [/\b(adres|address|woon ik|i live)\b/i, 'adres'],
  [/\b(iban|bankrekening|rekeningnummer|western union|moneygram|paypal|stuur (me |mij )?geld|send (me )?money)\b/i, 'geldverzoek'],
];

function chatFlags(body) {
  return [...new Set(CONTACT_PATTERNS.filter(([re]) => re.test(body)).map(([, why]) => why))];
}

function chatRecipient(db, recipientId) {
  const r = get(db, 'SELECT * FROM recipients WHERE id = ?', recipientId);
  if (!r || !r.active || !r.chat_enabled) throw new AppError(403, 'Chatten met deze ontvanger staat uit');
  return r;
}

// Een donateur mag chatten met een gezin als hij een kind uit dat gezin sponsort (of, vroeger, geld aan hen besteedde).
function hasFunded(db, donorId, recipientId) {
  return !!get(db, `SELECT 1 AS ok FROM sponsorships s JOIN children ch ON ch.id = s.child_id
      WHERE s.donor_id = ? AND ch.family_id = ? AND s.status <> 'beeindigd'
    UNION SELECT 1 FROM allocations a JOIN expenditures e ON e.id = a.expenditure_id
      WHERE a.donor_id = ? AND e.recipient_id = ? LIMIT 1`, donorId, recipientId, donorId, recipientId);
}

// Algemene schakelaar (Instellingen). Staat de moderatie uit, dan wordt alles direct afgeleverd;
// berichten met contactgegevens e.d. worden dan nog wel gemarkeerd (flag_reason) voor controle achteraf.
let moderationOn = true;
const setModeration = (on) => { moderationOn = !!on; };
const moderationEnabled = () => moderationOn;
const isModerated = (r) => moderationOn && (!!r.chat_moderated || r.kind === 'kind');

function notifyChat(db, msg, recipient) {
  if (msg.sender !== 'recipient') return; // ontvangers krijgen geen e-mail; zij zien het bij inloggen
  const donor = get(db, 'SELECT * FROM donors WHERE id = ?', msg.donor_id);
  sendMail(db, donor, `Nieuw bericht van ${recipient.name}`,
    `Beste ${donor.first_name || donorFullName(donor)},\n\n${recipient.name} heeft je een bericht gestuurd. ` +
    `Log in op je donateursportaal (Chat) om het te lezen en te antwoorden.\n\nRobin Foundation`, 'chat');
}

function sendChat(db, { recipientId, donorId, sender, body }, actor) {
  const text = String(body || '').trim();
  if (!text) throw new AppError(400, 'Bericht is leeg');
  if (text.length > 2000) throw new AppError(400, 'Bericht is te lang (max. 2000 tekens)');
  const recipient = chatRecipient(db, recipientId);
  if (!hasFunded(db, donorId, recipientId)) throw new AppError(403, 'Je kunt alleen chatten met wie je hebt gesteund');
  const flags = chatFlags(text);
  const status = moderationOn && (isModerated(recipient) || flags.length) ? 'in_behandeling' : 'goedgekeurd';
  const r = run(db, `INSERT INTO chat_messages (recipient_id, donor_id, sender, body, status, flag_reason) VALUES (?,?,?,?,?,?)`,
    recipientId, donorId, sender, text, status, flags.join(', '));
  const msg = get(db, 'SELECT * FROM chat_messages WHERE id = ?', Number(r.lastInsertRowid));
  if (status === 'goedgekeurd') notifyChat(db, msg, recipient);
  audit(db, actor, 'chatbericht_verstuurd', 'chat_message', msg.id, { status, flags });
  return msg;
}

function moderateChat(db, id, approve, reason, user) {
  const msg = get(db, 'SELECT * FROM chat_messages WHERE id = ?', id);
  if (!msg) throw new AppError(404, 'Bericht niet gevonden');
  if (msg.status !== 'in_behandeling') throw new AppError(409, 'Dit bericht is al beoordeeld');
  const status = approve ? 'goedgekeurd' : 'afgewezen';
  run(db, `UPDATE chat_messages SET status = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`,
    status, approve ? '' : String(reason || '').slice(0, 500), user ? user.id : null, id);
  if (approve) notifyChat(db, msg, get(db, 'SELECT * FROM recipients WHERE id = ?', msg.recipient_id));
  audit(db, user ? `medewerker:${user.email}` : 'systeem', approve ? 'chat_goedgekeurd' : 'chat_afgewezen', 'chat_message', id);
  return { ...msg, status };
}

// Gesprek zoals één partij het ziet: goedgekeurde berichten + eigen berichten (met status).
function chatThread(db, recipientId, donorId, viewer, markRead = true) {
  const rows = all(db, `SELECT id, sender, body, status, reject_reason, read_at, created_at FROM chat_messages
    WHERE recipient_id = ? AND donor_id = ? AND (status = 'goedgekeurd' OR sender = ?) ORDER BY created_at, id`,
    recipientId, donorId, viewer);
  const other = viewer === 'donor' ? 'recipient' : 'donor';
  if (markRead) run(db, `UPDATE chat_messages SET read_at = datetime('now') WHERE recipient_id = ? AND donor_id = ?
    AND sender = ? AND status = 'goedgekeurd' AND read_at IS NULL`, recipientId, donorId, other);
  return rows.map((m) => ({ ...m, mine: m.sender === viewer, reject_reason: m.sender === viewer ? m.reject_reason : '' }));
}

// Voegt vertalingen toe aan berichten van de andere partij (eigen berichten blijven zoals ze zijn).
// Vertalingen worden gecachet; mislukt vertalen, dan komt de originele tekst terug met een foutmelding.
async function withTranslations(db, msgs, lang) {
  const T = require('./translate');
  if (!lang) return { messages: msgs };
  if (!T.isEnabled()) return { messages: msgs, translate_error: 'Vertalen is nog niet ingesteld' };
  if (!T.LANGUAGES[lang]) throw new AppError(400, 'Onbekende taal');
  const theirs = msgs.filter((m) => !m.mine);
  if (!theirs.length) return { messages: msgs };
  const ids = theirs.map((m) => m.id);
  const cached = new Map(all(db, `SELECT * FROM chat_translations WHERE lang = ? AND message_id IN (${ids.map(() => '?').join(',')})`, lang, ...ids)
    .map((r) => [r.message_id, r]));
  const missing = theirs.filter((m) => !cached.has(m.id));
  let error = null;
  if (missing.length) {
    try {
      // In porties van 40 berichten om grote verzoeken te vermijden.
      for (let i = 0; i < missing.length; i += 40) {
        const part = missing.slice(i, i + 40);
        const res = await T.translateBatch(part.map((m) => ({ id: m.id, text: m.body })), lang);
        for (const [id, t] of res) {
          run(db, 'INSERT OR REPLACE INTO chat_translations (message_id, lang, text, source_lang) VALUES (?,?,?,?)', id, lang, t.text, t.source_language);
          cached.set(id, { text: t.text, source_lang: t.source_language });
        }
      }
    } catch (err) { error = err.message; }
  }
  return {
    messages: msgs.map((m) => {
      const t = !m.mine && cached.get(m.id);
      if (!t || t.source_lang === lang || t.text.trim() === m.body.trim()) return m;
      return { ...m, translation: t.text, source_lang: t.source_lang };
    }),
    translate_error: error,
  };
}

module.exports = {
  withTranslations,
  chatFlags, hasFunded, isModerated, setModeration, moderationEnabled, sendChat, moderateChat, chatThread,
  AppError, euro, audit, getCategory, donorFullName, donorPublicName, sendMail, deliver,
  createDonation, updateDonation, deleteDonation, spend, reverseExpenditure, addImpactMessage,
  categoryBalances, donorImpact, leaderboard,
};

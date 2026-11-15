'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { openDb, get, all, run } = require('../src/db');
const S = require('../src/services');
const SP = require('../src/sponsoring');
const { createServer } = require('../server');
const { hashPassword } = require('../src/auth');

function freshDb() {
  return openDb(':memory:');
}
function addDonor(db, extra = {}) {
  const r = run(db, 'INSERT INTO donors (first_name, last_name, email, anonymous) VALUES (?,?,?,?)',
    extra.first_name || 'Test', extra.last_name || 'Donor', extra.email || `t${Math.random()}@x.nl`, extra.anonymous ?? 1);
  return Number(r.lastInsertRowid);
}

test('ontvangen donatie krijgt een eigen cel', () => {
  const db = freshDb();
  const donor = addDonor(db);
  const d = S.createDonation(db, { donor_id: donor, category_key: 'schoolmaaltijd', amount_cents: 2500 });
  const cell = get(db, 'SELECT * FROM cells WHERE donation_id = ?', d.id);
  assert.equal(cell.amount_cents, 2500);
  assert.equal(cell.remaining_cents, 2500);
  assert.equal(cell.status, 'wachtend');
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind='bedankt'").n, 1);
});

test('donatie in afwachting krijgt pas een cel na ontvangst', () => {
  const db = freshDb();
  const donor = addDonor(db);
  const d = S.createDonation(db, { donor_id: donor, category_key: 'noodfonds', amount_cents: 1000, status: 'in_afwachting' });
  assert.equal(get(db, 'SELECT * FROM cells WHERE donation_id = ?', d.id), undefined);
  S.updateDonation(db, d.id, { status: 'ontvangen' });
  assert.equal(get(db, 'SELECT remaining_cents FROM cells WHERE donation_id = ?', d.id).remaining_cents, 1000);
});

test('besteding haalt geld FIFO uit cellen en verdeelt over donateurs', () => {
  const db = freshDb();
  const a = addDonor(db);
  const b = addDonor(db);
  const d1 = S.createDonation(db, { donor_id: a, category_key: 'schoolgeld', amount_cents: 10000 });
  run(db, "UPDATE cells SET created_at = '2024-01-01' WHERE donation_id = ?", d1.id);
  S.createDonation(db, { donor_id: b, category_key: 'schoolgeld', amount_cents: 10000 });

  const res = S.spend(db, { category_key: 'schoolgeld', units: 1 }); // 1 schooljaar = € 150
  assert.equal(res.amount_cents, 15000);
  assert.equal(res.donors, 2);
  const cells = all(db, 'SELECT * FROM cells ORDER BY created_at');
  assert.equal(cells[0].remaining_cents, 0);
  assert.equal(cells[0].status, 'besteed');
  assert.equal(cells[1].remaining_cents, 5000);
  assert.equal(cells[1].status, 'deels_besteed');
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind='besteding'").n, 2);
});

test('besteding met specifieke cellen ("cel triggeren")', () => {
  const db = freshDb();
  const a = addDonor(db);
  const d1 = S.createDonation(db, { donor_id: a, category_key: 'gezondheidspakket', amount_cents: 5000 });
  const d2 = S.createDonation(db, { donor_id: a, category_key: 'gezondheidspakket', amount_cents: 2500 });
  const c2 = get(db, 'SELECT id FROM cells WHERE donation_id = ?', d2.id).id;
  const res = S.spend(db, { category_key: 'gezondheidspakket', cell_ids: [c2] });
  assert.equal(res.amount_cents, 2500);
  assert.equal(res.units, 1);
  assert.equal(get(db, 'SELECT remaining_cents FROM cells WHERE donation_id = ?', d1.id).remaining_cents, 5000);
  assert.equal(get(db, 'SELECT status FROM cells WHERE id = ?', c2).status, 'besteed');
});

test('onvoldoende saldo of verkeerde bestemming wordt geweigerd', () => {
  const db = freshDb();
  const a = addDonor(db);
  S.createDonation(db, { donor_id: a, category_key: 'schoolmaaltijd', amount_cents: 1000 });
  const d = S.createDonation(db, { donor_id: a, category_key: 'noodfonds', amount_cents: 1000 });
  assert.throws(() => S.spend(db, { category_key: 'schoolmaaltijd', amount_cents: 5000 }), /Onvoldoende saldo/);
  const cell = get(db, 'SELECT id FROM cells WHERE donation_id = ?', d.id).id;
  assert.throws(() => S.spend(db, { category_key: 'schoolmaaltijd', cell_ids: [cell] }), /dezelfde bestemming/);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM expenditures').n, 0);
});

test('impactbericht wordt bezorgd bij alle betrokken donateurs', () => {
  const db = freshDb();
  const a = addDonor(db);
  const b = addDonor(db);
  const c = addDonor(db);
  S.createDonation(db, { donor_id: a, category_key: 'schoolmaaltijd', amount_cents: 500 });
  S.createDonation(db, { donor_id: b, category_key: 'schoolmaaltijd', amount_cents: 500 });
  S.createDonation(db, { donor_id: c, category_key: 'noodfonds', amount_cents: 500 });
  const exp = S.spend(db, { category_key: 'schoolmaaltijd', units: 20 }); // 20 x € 0,50 = € 10
  const msg = S.addImpactMessage(db, exp.id, { type: 'brief', title: 'Bedankt!', body: 'Lieve donateur…' });
  assert.equal(msg.delivered_to, 2);
  const inbox = all(db, 'SELECT donor_id FROM donor_messages ORDER BY donor_id').map((r) => r.donor_id);
  assert.deepEqual(inbox, [a, b]);
});

test('besteding terugdraaien zet geld terug in de cellen', () => {
  const db = freshDb();
  const a = addDonor(db);
  S.createDonation(db, { donor_id: a, category_key: 'noodfonds', amount_cents: 8000 });
  const exp = S.spend(db, { category_key: 'noodfonds', amount_cents: 3000 });
  S.addImpactMessage(db, exp.id, { type: 'foto', title: 'Nieuw dak' });
  S.reverseExpenditure(db, exp.id);
  const cell = get(db, 'SELECT * FROM cells');
  assert.equal(cell.remaining_cents, 8000);
  assert.equal(cell.status, 'wachtend');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM donor_messages').n, 0);
});

test('uitgegeven donatie kan niet meer gewijzigd of verwijderd worden', () => {
  const db = freshDb();
  const a = addDonor(db);
  const d = S.createDonation(db, { donor_id: a, category_key: 'noodfonds', amount_cents: 8000 });
  S.spend(db, { category_key: 'noodfonds', amount_cents: 1000 });
  assert.throws(() => S.updateDonation(db, d.id, { amount_cents: 9000 }), /uitgegeven/);
  assert.throws(() => S.deleteDonation(db, d.id), /uitgegeven/);
  // Niet-financiële velden mogen wel
  S.updateDonation(db, d.id, { note: 'bijgewerkt' });
});

test('leaderboard toont anonieme donateurs als "Anonieme sponsor"', () => {
  const db = freshDb();
  const a = addDonor(db, { first_name: 'Sanne', last_name: 'de Vries', anonymous: 0 });
  const b = addDonor(db, { first_name: 'Geheim', last_name: 'Persoon', anonymous: 1 });
  S.createDonation(db, { donor_id: a, category_key: 'noodfonds', amount_cents: 1000 });
  S.createDonation(db, { donor_id: b, category_key: 'noodfonds', amount_cents: 5000 });
  const lb = S.leaderboard(db);
  assert.equal(lb[0].name, 'Anonieme sponsor');
  assert.equal(lb[0].city, '');
  assert.equal(lb[1].name, 'Sanne D.');
  assert.ok(!JSON.stringify(lb).includes('Geheim'));
});

test('HTTP: publieke leaderboard lekt geen ids of namen, portaal & beheer vereisen login', async (t) => {
  const db = freshDb();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  const donor = addDonor(db, { first_name: 'Geheim', email: 'g@x.nl', anonymous: 1 });
  run(db, 'UPDATE donors SET password_hash = ? WHERE id = ?', hashPassword('welkom123'), donor);
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'a@rf.org', 'A', 'admin', hashPassword('admin123'));
  const child = Number(run(db, "INSERT INTO children (first_name) VALUES ('Maria')").lastInsertRowid);
  SP.startSponsorships(db, donor, [child]);

  const server = createServer({ db, uploadDir }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const lb = await (await fetch(`${base}/api/public/leaderboard`)).json();
  assert.equal(lb.length, 1);
  assert.equal(lb[0].donor_id, undefined);
  assert.equal(lb[0].name, 'Anonieme sponsor');

  assert.equal((await fetch(`${base}/api/admin/donors`)).status, 401);
  assert.equal((await fetch(`${base}/api/portal/overview`)).status, 401);

  const login = await fetch(`${base}/api/donor/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'g@x.nl', password: 'welkom123' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const overview = await (await fetch(`${base}/api/portal/overview`, { headers: { cookie } })).json();
  assert.equal(overview.sponsor.children, 1);
  assert.equal(overview.rank, 1);
  // Donateur-sessie geeft geen toegang tot beheer.
  assert.equal((await fetch(`${base}/api/admin/donors`, { headers: { cookie } })).status, 401);
  // Mutaties zonder JSON content-type worden geweigerd (CSRF).
  assert.equal((await fetch(`${base}/api/portal/sponsor`, { method: 'POST', headers: { cookie }, body: 'child_ids=1' })).status, 415);
});

// ------------------------------------------------------------------ sponsormodel
function sponsorSetup() {
  const db = freshDb();
  const donor = addDonor(db, { first_name: 'Sanne', anonymous: 0 });
  const fam = Number(run(db, "INSERT INTO recipients (name, kind) VALUES ('Familie Santos', 'gezin')").lastInsertRowid);
  const kids = ['Maria', 'Jose', 'Ana'].map((n) => Number(run(db, 'INSERT INTO children (first_name, family_id) VALUES (?,?)', n, fam).lastInsertRowid));
  return { db, donor, fam, kids };
}

test('sponsoren: maand boeken verdeelt € 50 over de onderdelen en vult het noodfonds', () => {
  const { db, donor, fam, kids } = sponsorSetup();
  const sids = SP.startSponsorships(db, donor, kids.slice(0, 2));
  assert.equal(sids.length, 2);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM children WHERE status = 'gesponsord'").n, 2);
  const res = SP.bookPayment(db, { donorId: donor, sponsorshipIds: sids });
  assert.equal(get(db, 'SELECT amount_cents FROM donations WHERE id = ?', res.donation_id).amount_cents, 10000);
  assert.equal(res.fund_cents, 1000);
  assert.equal(get(db, "SELECT remaining_cents FROM cells WHERE category_key = 'noodfonds'").remaining_cents, 1000);
  const lines = JSON.parse(get(db, 'SELECT lines FROM sponsor_months WHERE sponsorship_id = ?', sids[0]).lines);
  assert.deepEqual(lines.map((l) => l.cents), [2300, 1700, 500, 500]);
  // Dubbele boeking schuift door naar de volgende maand
  SP.bookPayment(db, { donorId: donor, sponsorshipIds: [sids[0]] });
  assert.equal(get(db, 'SELECT COUNT(DISTINCT month) AS n FROM sponsor_months WHERE sponsorship_id = ?', sids[0]).n, 2);
  // Sponsor mag chatten met het gezin; leaderboard op aantal kinderen
  assert.equal(S.hasFunded(db, donor, fam), true);
  assert.equal(SP.leaderboard(db)[0].children, 2);
  // Een kind kan maar één sponsor hebben
  const other = addDonor(db);
  assert.throws(() => SP.reserve(db, other, [kids[0]]), /gekozen/);
});

test('sponsoren: na 2 gemiste betalingen komt het kind weer vrij', () => {
  const { db, donor, kids } = sponsorSetup();
  const [sid] = SP.startSponsorships(db, donor, [kids[0]]);
  SP.missedPayment(db, [sid]);
  assert.equal(get(db, 'SELECT status FROM sponsorships WHERE id = ?', sid).status, 'betaling_gemist');
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'herinnering'").n, 1);
  SP.missedPayment(db, [sid]);
  assert.equal(get(db, 'SELECT status FROM sponsorships WHERE id = ?', sid).status, 'beeindigd');
  assert.equal(get(db, 'SELECT status FROM children WHERE id = ?', kids[0]).status, 'beschikbaar');
});

test('sponsoren: verdeling instellen moet optellen tot het bedrag', () => {
  const { db } = sponsorSetup();
  const cfg = SP.getConfig(db);
  assert.throws(() => SP.setConfig(db, { ...cfg, amount_cents: 6000 }, 't'), /tellen op/);
  const parts = cfg.parts.map((p) => (p.key === 'maaltijden' ? { ...p, cents: 3300 } : p));
  SP.setConfig(db, { amount_cents: 6000, parts }, 't');
  assert.equal(SP.getConfig(db).amount_cents, 6000);
});

test('HTTP: donateur kiest kinderen in het portaal (demo zonder Mollie)', async (t) => {
  const { db, donor, kids } = sponsorSetup();
  run(db, 'UPDATE donors SET password_hash = ?, email = ? WHERE id = ?', hashPassword('welkom123'), 's@x.nl', donor);
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/donor/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 's@x.nl', password: 'welkom123' }) });
  const h = { cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(`${base}/api/portal/children`, { headers: h })).json()).length, 3);
  const r = await fetch(`${base}/api/portal/sponsor`, { method: 'POST', headers: h, body: JSON.stringify({ child_ids: [kids[1], kids[2]] }) });
  assert.equal(r.status, 200);
  const mine = await (await fetch(`${base}/api/portal/my-children`, { headers: h })).json();
  assert.deepEqual(mine.map((c) => c.first_name).sort(), ['Ana', 'Jose']);
  assert.equal(mine[0].months, 1);
  assert.equal(mine[0].last_name, undefined); // geen achternaam naar donateurs
  const detail = await (await fetch(`${base}/api/portal/my-children/${kids[1]}`, { headers: h })).json();
  assert.equal(detail.totals.reduce((s, l) => s + l.cents, 0), 5000);
  const stop = await fetch(`${base}/api/portal/my-children/${kids[1]}/stop`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(stop.status, 200);
  assert.equal(get(db, 'SELECT status FROM children WHERE id = ?', kids[1]).status, 'beschikbaar');
});

// ------------------------------------------------------------------ chat
function chatSetup(kind = 'kind', moderated = 1) {
  S.setModeration(true);
  const db = freshDb();
  const donor = addDonor(db, { first_name: 'Sanne', last_name: 'V', anonymous: 0 });
  const other = addDonor(db);
  const rid = Number(run(db, `INSERT INTO recipients (name, kind, username, password_hash, managed_by, chat_moderated)
    VALUES ('Grace', ?, 'grace', ?, 'Juf Marie', ?)`, kind, hashPassword('welkom123'), moderated).lastInsertRowid);
  S.createDonation(db, { donor_id: donor, category_key: 'schoolmaaltijd', amount_cents: 1000 });
  S.createDonation(db, { donor_id: other, category_key: 'noodfonds', amount_cents: 1000 });
  S.spend(db, { category_key: 'schoolmaaltijd', units: 10, recipient_id: rid });
  return { db, donor, other, rid };
}

test('chat alleen tussen donateur en ontvanger die gesteund is', () => {
  const { db, other, rid } = chatSetup();
  assert.throws(() => S.sendChat(db, { recipientId: rid, donorId: other, sender: 'donor', body: 'Hoi' }), /gesteund/);
});

test('chat met kind wordt gemodereerd en pas na goedkeuring zichtbaar', () => {
  const { db, donor, rid } = chatSetup('kind', 0); // ook als moderatie uit staat: kind = altijd moderatie
  const msg = S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'donor', body: 'Hoi Grace!' });
  assert.equal(msg.status, 'in_behandeling');
  assert.equal(S.chatThread(db, rid, donor, 'recipient').length, 0);   // ontvanger ziet nog niets
  assert.equal(S.chatThread(db, rid, donor, 'donor').length, 1);       // afzender ziet eigen bericht (in behandeling)
  S.moderateChat(db, msg.id, true, '', null);
  assert.equal(S.chatThread(db, rid, donor, 'recipient').length, 1);
});

test('chat met school zonder moderatie, maar contactgegevens worden tegengehouden', () => {
  const { db, donor, rid } = chatSetup('school', 0);
  assert.equal(S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'donor', body: 'Veel succes dit jaar!' }).status, 'goedgekeurd');
  const flagged = S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'donor', body: 'Bel me op 06-12345678 of via WhatsApp' });
  assert.equal(flagged.status, 'in_behandeling');
  assert.match(flagged.flag_reason, /telefoonnummer/);
  // antwoord van ontvanger -> e-mailmelding naar donateur
  S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'recipient', body: 'Dankjewel!' });
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind='chat'").n, 1);
});

test('HTTP: ontvanger logt in, ziet anonieme donateur anoniem en kan niet bij beheer of portaal', async (t) => {
  const { db, donor, rid } = chatSetup('school', 0);
  run(db, 'UPDATE donors SET anonymous = 1 WHERE id = ?', donor);
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/recipient/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'grace', password: 'welkom123' }),
  });
  assert.equal(login.status, 200);
  const me = await login.json();
  assert.equal(me.password_hash, undefined);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const supporters = await (await fetch(`${base}/api/recipient/supporters`, { headers: { cookie } })).json();
  assert.equal(supporters.length, 1);
  assert.equal(supporters[0].name, 'Anonieme sponsor 1');
  assert.ok(!JSON.stringify(supporters).includes('Sanne'));
  const sent = await fetch(`${base}/api/recipient/supporters/${donor}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ body: 'Dankjewel!' }),
  });
  assert.equal(sent.status, 200);
  assert.equal((await fetch(`${base}/api/admin/recipients`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${base}/api/portal/overview`, { headers: { cookie } })).status, 401);
  assert.equal(rid > 0, true);
});

test('besteding uit cellen van één gekozen donateur (niet FIFO over iedereen)', () => {
  const db = freshDb();
  const oud = addDonor(db);
  const selwyn = addDonor(db);
  const d1 = S.createDonation(db, { donor_id: oud, category_key: 'schoolgeld', amount_cents: 30000 });
  run(db, "UPDATE cells SET created_at = '2020-01-01' WHERE donation_id = ?", d1.id);
  S.createDonation(db, { donor_id: selwyn, category_key: 'schoolgeld', amount_cents: 15000 });
  const rid = Number(run(db, "INSERT INTO recipients (name, kind) VALUES ('Elias', 'kind')").lastInsertRowid);
  S.spend(db, { category_key: 'schoolgeld', units: 1, recipient_id: rid, donor_id: selwyn });
  assert.equal(S.hasFunded(db, selwyn, rid), true);
  assert.equal(S.hasFunded(db, oud, rid), false);
  assert.throws(() => S.spend(db, { category_key: 'schoolgeld', units: 1, donor_id: selwyn }), /van deze sponsor/);
});

test('donateur kan chatten met gesteunde ontvanger zonder inlog (bericht wacht)', () => {
  S.setModeration(true);
  const db = freshDb();
  const selwyn = addDonor(db);
  S.createDonation(db, { donor_id: selwyn, category_key: 'schoolgeld', amount_cents: 15000 });
  const rid = Number(run(db, "INSERT INTO recipients (name, kind) VALUES ('Elias', 'kind')").lastInsertRowid);
  S.spend(db, { category_key: 'schoolgeld', units: 1, recipient_id: rid, donor_id: selwyn });
  const m = S.sendChat(db, { recipientId: rid, donorId: selwyn, sender: 'donor', body: 'Hoi Elias!' });
  assert.equal(m.status, 'in_behandeling');
});

test('HTTP: "inloggen als" alleen voor beheerders, volledige toegang of alleen-lezen (instelbaar), gelogd', async (t) => {
  const { db, donor, rid } = chatSetup('school', 0);
  S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'recipient', body: 'Dankjewel!' });
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'a@rf.org', 'Admin', 'admin', hashPassword('admin123'));
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'm@rf.org', 'Mila', 'medewerker', hashPassword('medewerker123'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const login = async (email, password) => (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: json, body: JSON.stringify({ email, password }) }))
    .headers.get('set-cookie').split(';')[0];

  const mila = await login('m@rf.org', 'medewerker123');
  assert.equal((await fetch(`${base}/api/admin/donors/${donor}/impersonate`, { method: 'POST', headers: { ...json, cookie: mila }, body: '{}' })).status, 403);

  const admin = await login('a@rf.org', 'admin123');
  const res = await fetch(`${base}/api/admin/donors/${donor}/impersonate`, { method: 'POST', headers: { ...json, cookie: admin }, body: '{}' });
  assert.equal(res.status, 200);
  const as = res.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/api/donor/me`, { headers: { cookie: as } })).json();
  assert.equal(me.impersonated_by, 'Admin');
  const thread = await (await fetch(`${base}/api/portal/conversations/${rid}`, { headers: { cookie: as } })).json();
  assert.equal(thread.messages.length, 1);
  assert.equal(get(db, 'SELECT read_at FROM chat_messages').read_at, null); // meekijken markeert niets als gelezen
  // Standaard: volledige toegang. Chatten namens de donateur lukt en staat met beide namen in het audit log.
  assert.equal(me.impersonation_write, true);
  const post = await fetch(`${base}/api/portal/conversations/${rid}`, { method: 'POST', headers: { ...json, cookie: as }, body: JSON.stringify({ body: 'hoi' }) });
  assert.equal(post.status, 200);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chatbericht_verstuurd' AND actor LIKE 'medewerker:a@rf.org als donateur:%'").n, 1);
  // Wachtwoord en Face ID nooit namens iemand anders
  assert.equal((await fetch(`${base}/api/portal/password`, { method: 'POST', headers: { ...json, cookie: as }, body: JSON.stringify({ current: 'x', password: 'nieuwwachtwoord' }) })).status, 403);
  assert.equal((await fetch(`${base}/api/passkeys/donor/options`, { method: 'POST', headers: { ...json, cookie: as }, body: '{}' })).status, 403);
  // Medewerker kan de instelling niet wijzigen; beheerder zet hem uit -> alleen-lezen
  assert.equal((await fetch(`${base}/api/admin/settings/impersonation`, { method: 'PUT', headers: { ...json, cookie: mila }, body: JSON.stringify({ write: true }) })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/settings/impersonation`, { method: 'PUT', headers: { ...json, cookie: admin }, body: JSON.stringify({ write: false }) })).status, 200);
  assert.equal((await fetch(`${base}/api/portal/conversations/${rid}`, { method: 'POST', headers: { ...json, cookie: as }, body: JSON.stringify({ body: 'nog een' }) })).status, 403);
  assert.equal((await fetch(`${base}/api/portal/sponsor`, { method: 'POST', headers: { ...json, cookie: as }, body: JSON.stringify({ child_ids: [1] }) })).status, 403);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ingelogd_als'").n, 1);

  // ontvanger zonder eigen wachtwoord kan ook bekeken worden
  run(db, 'UPDATE recipients SET password_hash = NULL, username = NULL WHERE id = ?', rid);
  const r2 = await fetch(`${base}/api/admin/recipients/${rid}/impersonate`, { method: 'POST', headers: { ...json, cookie: admin }, body: '{}' });
  const asR = r2.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/recipient/supporters`, { headers: { cookie: asR } })).status, 200);
});

test('chat vertalen: alleen berichten van de ander, gecachet, fout breekt chat niet', async () => {
  const T = require('../src/translate');
  const orig = T.translateBatch;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 't'.repeat(30);
  let calls = 0;
  T.translateBatch = async (items, lang) => {
    calls++;
    return new Map(items.map((i) => [i.id, { text: `[${lang}] ${i.text}`, source_language: 'ht' }]));
  };
  try {
    const { db, donor, rid } = chatSetup('school', 0);
    S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'recipient', body: 'Mèsi anpil!' });
    S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'donor', body: 'Graag gedaan' });
    const thread = () => S.chatThread(db, rid, donor, 'donor');
    const r1 = await S.withTranslations(db, thread(), 'nl');
    assert.equal(r1.messages.find((m) => !m.mine).translation, '[nl] Mèsi anpil!');
    assert.equal(r1.messages.find((m) => m.mine).translation, undefined);
    await S.withTranslations(db, thread(), 'nl');
    assert.equal(calls, 1); // tweede keer uit cache
    T.translateBatch = async () => { throw new Error('Vertaaldienst niet bereikbaar'); };
    const r3 = await S.withTranslations(db, thread(), 'en');
    assert.equal(r3.translate_error, 'Vertaaldienst niet bereikbaar');
    assert.equal(r3.messages.length, 2);
    delete process.env.ANTHROPIC_API_KEY;
    assert.match((await S.withTranslations(db, thread(), 'nl')).translate_error, /niet ingesteld/);
  } finally {
    T.translateBatch = orig;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('taal: Nederlands is de standaard, eigen keuze gaat voor', () => {
  const T = require('../src/translate');
  assert.equal(T.recipientLanguage({ country: 'Haïti', language: '' }), 'nl');
  assert.equal(T.recipientLanguage({ country: 'Honduras', language: '' }), 'nl');
  assert.equal(T.recipientLanguage({ country: 'Haïti', language: 'ht' }), 'ht');
  assert.equal(T.donorLanguage({ language: 'nl' }), 'nl');
  assert.equal(T.donorLanguage({}), 'nl');
});

test('HTTP: chatgesprek geeft eigen taal en taal van de ander; taal wijzigen', async (t) => {
  const { db, donor, rid } = chatSetup('school', 0);
  run(db, "UPDATE recipients SET country = 'Haïti' WHERE id = ?", rid);
  run(db, 'UPDATE donors SET password_hash = ?, email = ? WHERE id = ?', hashPassword('welkom123'), 'd@x.nl', donor);
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const cookie = (await fetch(`${base}/api/donor/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'd@x.nl', password: 'welkom123' }) }))
    .headers.get('set-cookie').split(';')[0];
  let th = await (await fetch(`${base}/api/portal/conversations/${rid}`, { headers: { cookie } })).json();
  assert.equal(th.my_language, 'nl');
  assert.equal(th.their_language, 'nl');
  assert.equal((await fetch(`${base}/api/portal/language`, { method: 'PUT', headers: { ...json, cookie }, body: JSON.stringify({ language: 'tl' }) })).status, 200);
  assert.equal((await fetch(`${base}/api/portal/language`, { method: 'PUT', headers: { ...json, cookie }, body: JSON.stringify({ language: 'xx' }) })).status, 400);
  th = await (await fetch(`${base}/api/portal/conversations/${rid}`, { headers: { cookie } })).json();
  assert.equal(th.my_language, 'tl');
});

test('vertaalsleutel in het CRM instellen (alleen beheerder), wordt nooit teruggegeven', async (t) => {
  const prev = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const db = freshDb();
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'a@rf.org', 'Admin', 'admin', hashPassword('admin123'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => { server.close(); require('../src/translate').configure({ apiKey: '', model: '' }); if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const cookie = (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'a@rf.org', password: 'admin123' }) }))
    .headers.get('set-cookie').split(';')[0];
  const put = (body) => fetch(`${base}/api/admin/translation/settings`, { method: 'PUT', headers: { ...json, cookie }, body: JSON.stringify(body) });
  assert.equal((await put({ api_key: 'geen-sleutel' })).status, 400);
  const key = 'sk-ant-api03-' + 'x'.repeat(40) + 'WXYZ';
  const res = await put({ api_key: key, model: 'claude-haiku-5-5' });
  const st = await res.json();
  assert.equal(st.api_key_set, true);
  assert.equal(st.key_source, 'crm');
  assert.equal(st.key_hint, '…WXYZ');
  assert.equal(st.model, 'claude-haiku-5-5');
  assert.ok(!JSON.stringify(st).includes(key));
  assert.equal(get(db, "SELECT value FROM settings WHERE key = 'translate_model'").value, 'claude-haiku-5-5');
  assert.equal(require('../src/translate').isEnabled(), true);
  assert.equal((await fetch(`${base}/api/admin/translation/status`)).status, 401);
});

test('chatmoderatie uit: alles direct afgeleverd, contactgegevens wel gemarkeerd', () => {
  const { db, donor, rid } = chatSetup('kind', 1);
  S.setModeration(false);
  try {
    const m1 = S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'donor', body: 'Hoi Grace!' });
    assert.equal(m1.status, 'goedgekeurd');
    const m2 = S.sendChat(db, { recipientId: rid, donorId: donor, sender: 'donor', body: 'Bel me: 06-12345678' });
    assert.equal(m2.status, 'goedgekeurd');
    assert.match(m2.flag_reason, /telefoonnummer/);
    assert.equal(S.chatThread(db, rid, donor, 'recipient').length, 2);
  } finally { S.setModeration(true); }
});

test('vertalen: persoonlijke sleutel + workspace-ID worden meegestuurd', async (t) => {
  const http = require('node:http');
  let seen = null;
  const fake = http.createServer((req, res) => {
    seen = req.headers;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ translations: [{ id: 1, source_language: 'ht', text: 'Hallo!' }] }) }],
        usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  }).listen(0);
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  const T = require('../src/translate');
  t.after(() => {
    fake.close();
    T.configure({ apiKey: '', workspace: '', model: '' });
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  });
  const key = 'sk-ant-usr-' + 'a'.repeat(40);
  assert.equal(T.keyProblem(key), null);
  assert.match(T.keyProblem('rnd_abc123'), /Render/);
  assert.match(T.keyProblem('abc-123-xyz'), /sk-ant-/);
  assert.equal(T.keyProblem('sk-ant-iets-nieuws-0123456789'), null);
  assert.match(T.keyProblem('❌ fout'), /ongeldig teken/);
  T.configure({ apiKey: key, workspace: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ', model: 'claude-haiku-5-5' });
  const out = await T.translateBatch([{ id: 1, text: 'Bonjou!' }], 'nl');
  assert.equal(out.get(1).text, 'Hallo!');
  assert.equal(seen['anthropic-workspace-id'], 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ');
  assert.equal(seen.authorization, `Bearer ${key}`);
});

// ------------------------------------------------------------------ livegang: betalingen, e-mail, beveiliging
function fakeProvider(handler) {
  const http = require('node:http');
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      calls.push(call);
      const [status, out] = handler(call);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  }).listen(0);
  return { srv, calls, url: () => `http://127.0.0.1:${srv.address().port}` };
}

test('Mollie: sponsorbetaling starten, webhook start sponsoring en abonnement, vervolg en mislukte incasso', async (t) => {
  const payments = {};
  let n = 0;
  const mollie = fakeProvider((c) => {
    if (c.method === 'POST' && c.url === '/customers') return [201, { id: 'cst_test1' }];
    if (c.method === 'POST' && c.url === '/payments') {
      const id = `tr_test${++n}`;
      payments[id] = { id, status: 'open', amount: c.body.amount, customerId: c.body.customerId, sequenceType: c.body.sequenceType, webhookUrl: c.body.webhookUrl, _links: { checkout: { href: `https://mollie.test/checkout/${id}` } } };
      return [201, payments[id]];
    }
    if (c.method === 'GET' && c.url.startsWith('/payments/')) return [200, payments[c.url.split('/')[2]]];
    if (c.method === 'POST' && /\/subscriptions$/.test(c.url)) return [201, { id: 'sub_test1' }];
    if (c.method === 'PATCH' && /\/subscriptions\//.test(c.url)) return [200, { id: 'sub_test1' }];
    return [404, {}];
  });
  process.env.MOLLIE_API_BASE = mollie.url();
  const P = require('../src/payments');
  const { db, donor, kids } = sponsorSetup();
  run(db, 'UPDATE donors SET password_hash = ?, email = ? WHERE id = ?', hashPassword('welkom123'), 'p@x.nl', donor);
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  P.configure({ apiKey: 'test_' + 'a'.repeat(30) });
  t.after(() => { server.close(); mollie.srv.close(); P.configure({ apiKey: '' }); delete process.env.MOLLIE_API_BASE; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const cookie = (await fetch(`${base}/api/donor/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'p@x.nl', password: 'welkom123' }) })).headers.get('set-cookie').split(';')[0];

  const res = await (await fetch(`${base}/api/portal/sponsor`, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ child_ids: [kids[0], kids[1]] }) })).json();
  assert.match(res.checkout_url, /checkout\/tr_test1/);
  assert.equal(get(db, 'SELECT status FROM donations WHERE id = ?', res.id).status, 'in_afwachting');
  const first = mollie.calls.find((c) => c.url === '/payments').body;
  assert.equal(first.sequenceType, 'first');
  assert.equal(first.amount.value, '100.00');
  // Gereserveerd: een andere donateur kan deze kinderen nu niet kiezen
  assert.equal(SP.availableChildren(db, addDonor(db)).length, 1);

  payments.tr_test1.status = 'paid'; payments.tr_test1.method = 'ideal';
  assert.equal((await fetch(`${base}/api/webhooks/mollie`, { method: 'POST', headers: form, body: 'id=tr_test1' })).status, 200);
  assert.equal(get(db, 'SELECT status FROM donations WHERE id = ?', res.id).status, 'ontvangen');
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM sponsorships WHERE subscription_id = 'sub_test1'").n, 2);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM sponsor_months').n, 2);
  assert.equal(mollie.calls.find((c) => /\/subscriptions$/.test(c.url)).body.amount.value, '100.00');
  // Tweede keer dezelfde webhook: niets dubbel
  await fetch(`${base}/api/webhooks/mollie`, { method: 'POST', headers: form, body: 'id=tr_test1' });
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM sponsorships').n, 2);
  // Vervolgbetaling vanuit het abonnement boekt de volgende maand
  payments.tr_sub2 = { id: 'tr_sub2', status: 'paid', subscriptionId: 'sub_test1', amount: { value: '100.00' } };
  await fetch(`${base}/api/webhooks/mollie`, { method: 'POST', headers: form, body: 'id=tr_sub2' });
  await fetch(`${base}/api/webhooks/mollie`, { method: 'POST', headers: form, body: 'id=tr_sub2' });
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM sponsor_months').n, 4);
  // Twee mislukte incasso's: kinderen komen vrij
  for (const id of ['tr_f1', 'tr_f2']) {
    payments[id] = { id, status: 'failed', subscriptionId: 'sub_test1', amount: { value: '100.00' } };
    await fetch(`${base}/api/webhooks/mollie`, { method: 'POST', headers: form, body: `id=${id}` });
    await fetch(`${base}/api/webhooks/mollie`, { method: 'POST', headers: form, body: `id=${id}` }); // dubbel telt niet
  }
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM sponsorships WHERE status = 'beeindigd'").n, 2);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM children WHERE status = 'beschikbaar'").n, 3);
});

test('Brevo: e-mails worden echt verstuurd en de status komt in de log', async (t) => {
  const brevo = fakeProvider((c) => (c.headers['api-key'] === 'xkeysib-' + 'b'.repeat(30) ? [201, { messageId: '<m1@brevo>' }] : [401, { message: 'Key not found' }]));
  process.env.BREVO_API_BASE = brevo.url();
  const M = require('../src/mailer');
  M.configure({ apiKey: 'xkeysib-' + 'b'.repeat(30), fromEmail: 'info@robin.test', fromName: 'Robin' });
  t.after(() => { brevo.srv.close(); M.configure({ apiKey: '', fromEmail: '', fromName: '' }); delete process.env.BREVO_API_BASE; });
  const db = freshDb();
  const donor = addDonor(db, { email: 'mail@x.nl' });
  S.createDonation(db, { donor_id: donor, category_key: 'noodfonds', amount_cents: 1000 });
  await new Promise((r) => setTimeout(r, 150));
  const m = get(db, 'SELECT * FROM outbox');
  assert.equal(m.status, 'verzonden');
  assert.equal(m.provider_id, '<m1@brevo>');
  assert.equal(brevo.calls[0].body.to[0].email, 'mail@x.nl');
  assert.equal(brevo.calls[0].body.sender.email, 'info@robin.test');
});

test('Livegang: sterke wachtwoorden verplicht en demodata wissen met waarborgen', async (t) => {
  const db = freshDb();
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'robin', 'Robin', 'admin', hashPassword('robin'));
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'medewerker@robinfoundation.org', 'Mila', 'medewerker', hashPassword('medewerker123'));
  const d = addDonor(db, { email: 'demo@example.nl' });
  S.createDonation(db, { donor_id: d, category_key: 'noodfonds', amount_cents: 1000 });
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const cookie = (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'robin', password: 'robin' }) })).headers.get('set-cookie').split(';')[0];
  const h = { ...json, cookie };
  assert.equal((await (await fetch(`${base}/api/staff/me`, { headers: h })).json()).weak_password, true);
  assert.equal((await (await fetch(`${base}/api/public/config`)).json()).demo, true);
  // Wissen weigert zolang het demo-wachtwoord en de demo-inlognaam gebruikt worden
  assert.equal((await fetch(`${base}/api/admin/demo/wipe`, { method: 'POST', headers: h, body: JSON.stringify({ confirm: 'VERWIJDER' }) })).status, 400);
  // Te zwak wachtwoord wordt geweigerd
  assert.equal((await fetch(`${base}/api/staff/password`, { method: 'POST', headers: h, body: JSON.stringify({ current: 'robin', password: 'kort' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/staff/password`, { method: 'POST', headers: h, body: JSON.stringify({ current: 'robin', password: 'Lange zin met gecko 42' }) })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/users/1`, { method: 'PUT', headers: h, body: JSON.stringify({ email: 'beheer@robin.test' }) })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/demo/wipe`, { method: 'POST', headers: h, body: JSON.stringify({ confirm: 'nee' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/admin/demo/wipe`, { method: 'POST', headers: h, body: JSON.stringify({ confirm: 'VERWIJDER' }) })).status, 200);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM donors').n, 0);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM users').n, 1);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM categories').n, 5);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM children').n, 0);
  assert.equal((await (await fetch(`${base}/api/public/config`)).json()).demo, false);
  assert.equal((await fetch(`${base}/api/staff/me`, { headers: h })).status, 200); // nog steeds ingelogd
});

test('eigen menuvolgorde opslaan, opschonen en herstellen', async (t) => {
  const db = freshDb();
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'a@rf.org', 'A', 'medewerker', hashPassword('Lange zin met gecko 42'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const cookie = (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'a@rf.org', password: 'Lange zin met gecko 42' }) })).headers.get('set-cookie').split(';')[0];
  const h = { ...json, cookie };
  const nav = [{ group: '', items: ['taken', 'dashboard', 'taken', 'X<script>'] }, { group: 'Fondsenwerving', items: ['donateurs'] }];
  const r = await (await fetch(`${base}/api/staff/preferences/nav`, { method: 'PUT', headers: h, body: JSON.stringify({ nav }) })).json();
  assert.deepEqual(r.nav[0].items, ['taken', 'dashboard']); // dubbel en ongeldig eruit
  assert.deepEqual((await (await fetch(`${base}/api/staff/me`, { headers: h })).json()).nav, r.nav);
  await fetch(`${base}/api/staff/preferences/nav`, { method: 'PUT', headers: h, body: JSON.stringify({ nav: null }) });
  assert.equal((await (await fetch(`${base}/api/staff/me`, { headers: h })).json()).nav, null);
});

// ------------------------------------------------------------------ onboarding
test('Onboarding: veldmedewerker meldt aan, tweede medewerker keurt goed, ID-foto’s worden verwijderd', async (t) => {
  const db = freshDb();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  process.env.CRM_PRIVATE = path.join(uploadDir, '..', path.basename(uploadDir) + '-private');
  run(db, "INSERT INTO users (email, name, role, password_hash) VALUES ('veld@rf.org','Veld','veldmedewerker',?)", hashPassword('Veld wachtwoord 1'));
  run(db, "INSERT INTO users (email, name, role, password_hash) VALUES ('kantoor@rf.org','Kantoor','medewerker',?)", hashPassword('Kantoor wachtwoord 1'));
  const server = createServer({ db, uploadDir }).listen(0);
  t.after(() => { server.close(); delete process.env.CRM_PRIVATE; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => ({ 'Content-Type': 'application/json',
    cookie: (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie').split(';')[0] });
  const veld = await login('veld@rf.org', 'Veld wachtwoord 1');
  const kantoor = await login('kantoor@rf.org', 'Kantoor wachtwoord 1');
  const call = async (h, method, url, body) => { const r = await fetch(`${base}${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };

  // Veldmedewerker kan niet bij donateurs
  assert.equal((await call(veld, 'GET', '/api/admin/donors')).status, 403);
  assert.equal((await call(veld, 'GET', '/api/staff/me')).status, 200);

  const onb = (await call(veld, 'POST', '/api/onboarding', { data: {} })).json;
  assert.equal(onb.id_method, 'handmatig');
  const story = 'Een verhaal van ruim veertig tekens over dit gezin en hun leven.';
  await call(veld, 'PUT', `/api/onboarding/${onb.id}`, { data: {
    family: { name: 'Familie Cruz', barangay: 'San Roque', city: 'Tacloban', province: 'Leyte', story, street: 'Purok 3' },
    guardian: { first_name: 'Liza', last_name: 'Cruz', relation: 'moeder', birth_date: '1988-02-01', id_type: 'philsys', id_last4: '1234' },
    children: [{ first_name: 'Ana', last_name: 'Cruz', birth_date: '2017-05-05', gender: 'meisje', school: 'San Roque ES', grade: 'Grade 3', story }],
    consent: { agreed: true, share_photos: true, signed_by: 'Liza Cruz' },
  } });
  // Indienen zonder documenten lukt niet
  const early = await call(veld, 'POST', `/api/onboarding/${onb.id}/submit`);
  assert.equal(early.status, 400);
  assert.match(early.json.error, /paspoort/);
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  for (const [kind, child_index] of [['id_document'], ['selfie'], ['foto_gezin'], ['adres'], ['handtekening'], ['foto_kind', 0], ['geboorteakte', 0], ['inschrijving', 0]]) {
    assert.equal((await call(veld, 'POST', `/api/onboarding/${onb.id}/files`, { kind, child_index, filename: `${kind}.png`, data: png })).status, 200);
  }
  // Bestanden staan niet in de openbare uploadmap
  assert.equal(fs.readdirSync(uploadDir).length, 0);
  assert.equal(fs.readdirSync(process.env.CRM_PRIVATE).length, 8);
  const sub = await call(veld, 'POST', `/api/onboarding/${onb.id}/submit`);
  assert.equal(sub.status, 200);
  assert.equal(sub.json.status, 'ingediend');
  // Na indienen niet meer te wijzigen
  assert.equal((await call(veld, 'PUT', `/api/onboarding/${onb.id}`, { data: {} })).status, 409);
  // Veldmedewerker kan niet zelf beoordelen
  assert.equal((await call(veld, 'POST', `/api/onboarding/${onb.id}/review`, { decision: 'goedkeuren' })).status, 403);
  // Bekijken van een document wordt gelogd
  const fileId = sub.json.files[0].id;
  const fr = await fetch(`${base}/api/onboarding/files/${fileId}`, { headers: { cookie: kantoor.cookie } });
  assert.equal(fr.headers.get('content-type'), 'image/png');
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'document_bekeken'").n, 1);
  // Zonder bevestigingen geen goedkeuring
  assert.equal((await call(kantoor, 'POST', `/api/onboarding/${onb.id}/review`, { decision: 'goedkeuren' })).status, 400);
  const ok = await call(kantoor, 'POST', `/api/onboarding/${onb.id}/review`, { decision: 'goedkeuren', id_checked: true, docs_checked: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'goedgekeurd');
  assert.match(ok.json.login.username, /^familie-cruz/);
  const fam = get(db, 'SELECT * FROM recipients WHERE id = ?', ok.json.family_id);
  assert.equal(fam.kind, 'gezin');
  assert.equal(fam.barangay, 'San Roque');
  assert.equal(get(db, "SELECT status FROM children WHERE family_id = ?", fam.id).status, 'beschikbaar');
  assert.match(get(db, 'SELECT photo_url FROM children WHERE family_id = ?', fam.id).photo_url, /^\/uploads\//);
  // ID en selfie zijn verwijderd, de uitslag is bewaard
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM onboarding_files WHERE kind IN ('id_document','selfie')").n, 0);
  assert.equal(JSON.parse(get(db, 'SELECT id_result FROM onboardings WHERE id = ?', onb.id).id_result).document_last4, '1234');
  // Het gezin kan inloggen
  const fl = await fetch(`${base}/api/recipient/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ok.json.login.username, password: ok.json.login.password }) });
  assert.equal(fl.status, 200);
});

test('Veriff: webhook alleen met geldige handtekening; uitslag komt bij de aanmelding', async (t) => {
  const V = require('../src/idcheck');
  const db = freshDb();
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  V.configure({ apiKey: 'k'.repeat(20), secret: 's'.repeat(20) });
  t.after(() => { server.close(); V.configure({ apiKey: '', secret: '' }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  run(db, "INSERT INTO onboardings (id_method, id_status, id_session) VALUES ('veriff', 'in_behandeling', 'sess-1')");
  const body = JSON.stringify({ status: 'success', verification: { id: 'sess-1', status: 'approved', document: { type: 'PASSPORT', number: 'P1234567' }, person: { firstName: 'Liza', lastName: 'Cruz' } } });
  const bad = await fetch(`${base}/api/webhooks/veriff`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HMAC-Signature': 'ab'.repeat(32) }, body });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/webhooks/veriff`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HMAC-Signature': V.sign(body) }, body });
  assert.equal(good.status, 200);
  const o = get(db, 'SELECT * FROM onboardings WHERE id_session = ?', 'sess-1');
  assert.equal(o.id_status, 'goedgekeurd');
  assert.equal(JSON.parse(o.id_result).document_last4, '4567');
  assert.ok(!o.id_result.includes('P1234567')); // geen volledig paspoortnummer bewaard
});

test('Noodfonds: inzet verlaagt het saldo, zonder mail aan donateurs; terugdraaien zet het terug', async (t) => {
  const { db, donor, fam, kids } = sponsorSetup();
  const sids = SP.startSponsorships(db, donor, kids);
  SP.bookPayment(db, { donorId: donor, sponsorshipIds: sids }); // 3 x € 5 = € 15 in het noodfonds
  run(db, "INSERT INTO users (email, name, role, password_hash) VALUES ('b@rf.org','B','admin',?)", hashPassword('Sterk wachtwoord 1'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'Content-Type': 'application/json', cookie: (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'b@rf.org', password: 'Sterk wachtwoord 1' }) })).headers.get('set-cookie').split(';')[0] };
  assert.equal((await (await fetch(`${base}/api/admin/noodfonds`, { headers: h })).json()).balance_cents, 1500);
  const mails = get(db, 'SELECT COUNT(*) AS n FROM outbox').n;
  const r = await fetch(`${base}/api/admin/noodfonds`, { method: 'POST', headers: h, body: JSON.stringify({ amount_cents: 1000, recipient_id: fam, description: 'Zeil en rijst na de tyfoon' }) });
  assert.equal(r.status, 200);
  const nf = await (await fetch(`${base}/api/admin/noodfonds`, { headers: h })).json();
  assert.equal(nf.balance_cents, 500);
  assert.equal(nf.deployments, 1);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM outbox').n, mails);
  assert.equal((await fetch(`${base}/api/admin/noodfonds`, { method: 'POST', headers: h, body: JSON.stringify({ amount_cents: 1000, description: 'te veel' }) })).status, 409);
  const depId = get(db, "SELECT id FROM expenditures WHERE category_key = 'noodfonds'").id;
  assert.equal((await fetch(`${base}/api/admin/noodfonds/${depId}`, { method: 'DELETE', headers: h })).status, 200);
  assert.equal((await (await fetch(`${base}/api/admin/noodfonds`, { headers: h })).json()).balance_cents, 1500);
});

test('Oude bestemmingen (vóór het sponsormodel) zijn verborgen in beheer, maar blijven bewaard', async (t) => {
  const { db, donor, kids } = sponsorSetup();
  SP.bookPayment(db, { donorId: donor, sponsorshipIds: SP.startSponsorships(db, donor, [kids[0]]) });
  run(db, "INSERT INTO donations (donor_id, category_key, amount_cents, status) VALUES (?, 'schoolmaaltijd', 1500, 'ontvangen')", donor);
  run(db, "INSERT INTO users (email, name, role, password_hash) VALUES ('c@rf.org','C','admin',?)", hashPassword('Sterk wachtwoord 1'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { cookie: (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'c@rf.org', password: 'Sterk wachtwoord 1' }) })).headers.get('set-cookie').split(';')[0] };
  const list = await (await fetch(`${base}/api/admin/donations`, { headers: h })).json();
  assert.deepEqual(list.map((d) => d.category_key), ['sponsoring']);
  const detail = await (await fetch(`${base}/api/admin/donors/${donor}`, { headers: h })).json();
  assert.equal(detail.donations.length, 1);
  const donors = await (await fetch(`${base}/api/admin/donors`, { headers: h })).json();
  assert.equal(donors.find((d) => d.id === donor).total_cents, 5000);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM donations').n, 2); // niets verwijderd
});

test('Face ID (passkeys): alleen voor ingelogde accounts, eenmalige uitdaging, onbekend toestel geweigerd', async (t) => {
  const db = freshDb();
  const donor = addDonor(db, { email: 'f@x.nl' });
  run(db, 'UPDATE donors SET password_hash = ? WHERE id = ?', hashPassword('welkom123'), donor);
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  // Zonder inloggen geen toestel koppelen
  assert.equal((await fetch(`${base}/api/passkeys/donor/options`, { method: 'POST', headers: json, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/passkeys/hacker/options`, { method: 'POST', headers: json, body: '{}' })).status, 404);
  const cookie = (await fetch(`${base}/api/donor/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'f@x.nl', password: 'welkom123' }) })).headers.get('set-cookie').split(';')[0];
  const reg = await (await fetch(`${base}/api/passkeys/donor/options`, { method: 'POST', headers: { ...json, cookie }, body: '{}' })).json();
  assert.ok(reg.challenge_id && reg.options.challenge);
  assert.equal(reg.options.rp.id, '127.0.0.1');
  assert.equal(reg.options.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(await (await fetch(`${base}/api/passkeys/donor`, { headers: { cookie } })).json(), []);
  // Inloggen: uitdaging is eenmalig, onbekend toestel wordt geweigerd
  const lo = await (await fetch(`${base}/api/passkeys/login/options`, { method: 'POST', headers: json, body: '{}' })).json();
  const bad = await fetch(`${base}/api/passkeys/login/verify`, { method: 'POST', headers: json, body: JSON.stringify({ challenge_id: lo.challenge_id, response: { id: 'onbekend' } }) });
  assert.equal(bad.status, 401);
  const again = await fetch(`${base}/api/passkeys/login/verify`, { method: 'POST', headers: json, body: JSON.stringify({ challenge_id: lo.challenge_id, response: { id: 'onbekend' } }) });
  assert.equal(again.status, 400); // al gebruikt
});

test('Sponsorlabels: standaard Particulieren en Bedrijven, eigen labels, ranglijst per label', async (t) => {
  const { db, kids } = sponsorSetup();
  const priv = addDonor(db, { first_name: 'Piet', anonymous: 0 });
  const comp = Number(run(db, "INSERT INTO donors (donor_type, company_name, email, anonymous) VALUES ('bedrijf', 'Bouw BV', 'b@bv.nl', 0)").lastInsertRowid);
  const lbl = (id) => get(db, 'SELECT l.name FROM donors d JOIN sponsor_labels l ON l.id = d.label_id WHERE d.id = ?', id).name;
  assert.equal(lbl(priv), 'Particulieren');
  assert.equal(lbl(comp), 'Bedrijven');
  SP.startSponsorships(db, priv, [kids[0]]);
  SP.startSponsorships(db, comp, [kids[1], kids[2]]);
  const bedrijven = get(db, "SELECT id FROM sponsor_labels WHERE key = 'bedrijf'").id;
  assert.deepEqual(SP.leaderboard(db, { label: bedrijven }).map((r) => r.name), ['Bouw BV']);
  assert.equal(SP.leaderboard(db).length, 2);

  run(db, "INSERT INTO users (email, name, role, password_hash) VALUES ('l@rf.org','L','admin',?)", hashPassword('Sterk wachtwoord 1'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'Content-Type': 'application/json', cookie: (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'l@rf.org', password: 'Sterk wachtwoord 1' }) })).headers.get('set-cookie').split(';')[0] };
  const scholen = await (await fetch(`${base}/api/admin/labels`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Scholen' }) })).json();
  assert.equal((await fetch(`${base}/api/admin/donors/${priv}`, { method: 'PUT', headers: h, body: JSON.stringify({ label_id: scholen.id }) })).status, 200);
  assert.equal(lbl(priv), 'Scholen');
  assert.equal((await fetch(`${base}/api/admin/donors/${priv}`, { method: 'PUT', headers: h, body: JSON.stringify({ label_id: 9999 }) })).status, 400);
  // In gebruik of standaard: niet verwijderen
  assert.equal((await fetch(`${base}/api/admin/labels/${scholen.id}`, { method: 'DELETE', headers: h })).status, 409);
  assert.equal((await fetch(`${base}/api/admin/labels/${bedrijven}`, { method: 'DELETE', headers: h })).status, 409);
  const pub = await (await fetch(`${base}/api/public/leaderboard?label=${scholen.id}`)).json();
  assert.equal(pub.length, 1);
  assert.equal(pub[0].donor_id, undefined);
  const labels = await (await fetch(`${base}/api/public/labels`)).json();
  assert.deepEqual(labels.map((l) => l.name), ['Particulieren', 'Bedrijven', 'Scholen']);
});

test('Aanmelden als sponsor: gegevens → beveiligen → kind sponsoren', async (t) => {
  const { db, kids } = sponsorSetup();
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  // Kinderen kiezen kan zonder in te loggen (zonder achternaam of gezin)
  const pub = await (await fetch(`${base}/api/public/children`)).json();
  assert.equal(pub.length, 3);
  assert.equal(pub[0].last_name, undefined);
  assert.equal(pub[0].family_id, undefined);
  // Zonder privacy-akkoord geen account
  assert.equal((await fetch(`${base}/api/donor/signup`, { method: 'POST', headers: json, body: JSON.stringify({ first_name: 'Eva', email: 'eva@x.nl' }) })).status, 400);
  const body = { first_name: 'Eva', last_name: 'Kok', email: 'Eva@x.nl', privacy: true, donor_type: 'bedrijf', company_name: 'Kok BV' };
  const r = await fetch(`${base}/api/donor/signup`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  const me = await r.json();
  assert.equal(me.needs_credential, true);
  assert.equal(get(db, 'SELECT l.name FROM donors d JOIN sponsor_labels l ON l.id = d.label_id WHERE d.email = ?', 'eva@x.nl').name, 'Bedrijven');
  const h = { ...json, cookie: r.headers.get('set-cookie').split(';')[0] };
  // Nog niet beveiligd: sponsoren geweigerd
  assert.equal((await fetch(`${base}/api/portal/sponsor`, { method: 'POST', headers: h, body: JSON.stringify({ child_ids: [kids[0]] }) })).status, 400);
  // Halverwege gestopt: opnieuw aanmelden met hetzelfde e-mailadres mag
  assert.equal((await fetch(`${base}/api/donor/signup`, { method: 'POST', headers: json, body: JSON.stringify(body) })).status, 200);
  // Wachtwoord instellen (één keer), daarna sponsoren
  assert.equal((await fetch(`${base}/api/portal/set-password`, { method: 'POST', headers: h, body: JSON.stringify({ password: 'kort' }) })).status, 400);
  const sp = await (await fetch(`${base}/api/portal/set-password`, { method: 'POST', headers: h, body: JSON.stringify({ password: 'een goed wachtwoord' }) })).json();
  assert.equal(sp.needs_credential, false);
  assert.equal((await fetch(`${base}/api/portal/set-password`, { method: 'POST', headers: h, body: JSON.stringify({ password: 'nog een wachtwoord' }) })).status, 409);
  assert.equal((await fetch(`${base}/api/portal/sponsor`, { method: 'POST', headers: h, body: JSON.stringify({ child_ids: [kids[0]] }) })).status, 200);
  // Bestaand account: niet opnieuw aanmelden, maar inloggen
  const again = await fetch(`${base}/api/donor/signup`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /Log in/);
  // Inloggen met het nieuwe wachtwoord werkt
  assert.equal((await fetch(`${base}/api/donor/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'eva@x.nl', password: 'een goed wachtwoord' }) })).status, 200);
});

test('Mollie: geweigerde automatische incasso wordt een taak en is later opnieuw te starten', async (t) => {
  const payments = {}; let subOk = false; let n = 0;
  const mollie = fakeProvider((c) => {
    if (c.method === 'POST' && c.url === '/customers') return [201, { id: 'cst_x' }];
    if (c.method === 'POST' && c.url === '/payments') { const id = `tr_x${++n}`; payments[id] = { id, status: 'open', amount: c.body.amount, customerId: c.body.customerId, webhookUrl: c.body.webhookUrl, _links: { checkout: { href: 'https://m/x' } } }; return [201, payments[id]]; }
    if (c.method === 'GET' && c.url.startsWith('/payments/')) return [200, payments[c.url.split('/')[2]]];
    if (c.method === 'POST' && /\/subscriptions$/.test(c.url)) return subOk ? [201, { id: 'sub_x' }] : [422, { detail: 'The customer has no valid mandate' }];
    if (c.method === 'GET' && /\/mandates$/.test(c.url)) return [200, { _embedded: { mandates: [{ id: 'mdt_1', status: 'valid' }] } }];
    if (c.method === 'GET' && c.url.startsWith('/methods')) return [200, { _embedded: { methods: c.url.includes('recurring') ? [{ description: 'SEPA-incasso' }] : [{ description: 'iDEAL' }] } }];
    return [404, {}];
  });
  process.env.MOLLIE_API_BASE = mollie.url();
  const P = require('../src/payments');
  const { db, donor, kids } = sponsorSetup();
  run(db, 'UPDATE donors SET password_hash = ?, email = ? WHERE id = ?', hashPassword('welkom123'), 'm@x.nl', donor);
  run(db, "INSERT INTO users (email, name, role, password_hash) VALUES ('k@rf.org','K','medewerker',?)", hashPassword('Sterk wachtwoord 1'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  P.configure({ apiKey: 'test_' + 'a'.repeat(30) });
  t.after(() => { server.close(); mollie.srv.close(); P.configure({ apiKey: '' }); delete process.env.MOLLIE_API_BASE; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const login = async (url, body) => (await fetch(`${base}${url}`, { method: 'POST', headers: json, body: JSON.stringify(body) })).headers.get('set-cookie').split(';')[0];
  const dc = await login('/api/donor/login', { email: 'm@x.nl', password: 'welkom123' });
  const res = await (await fetch(`${base}/api/portal/sponsor`, { method: 'POST', headers: { ...json, cookie: dc }, body: JSON.stringify({ child_ids: [kids[0]] }) })).json();
  payments.tr_x1.status = 'paid';
  await fetch(`${base}/api/webhooks/mollie`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'id=tr_x1' });
  assert.equal(get(db, 'SELECT status FROM donations WHERE id = ?', res.id).status, 'ontvangen');
  const task = get(db, "SELECT * FROM tasks WHERE title LIKE 'Automatische incasso niet gestart%'");
  assert.ok(task, 'taak voor kantoor');
  assert.match(task.description, /no valid mandate/);
  // Kantoor start de incasso opnieuw (machtiging is inmiddels geldig)
  subOk = true;
  const sc = await login('/api/staff/login', { email: 'k@rf.org', password: 'Sterk wachtwoord 1' });
  const sid = get(db, 'SELECT id FROM sponsorships WHERE donor_id = ?', donor).id;
  const r = await fetch(`${base}/api/admin/sponsorships/${sid}/subscription`, { method: 'POST', headers: { ...json, cookie: sc }, body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(get(db, 'SELECT subscription_id FROM sponsorships WHERE id = ?', sid).subscription_id, 'sub_x');
  assert.equal((await fetch(`${base}/api/admin/sponsorships/${sid}/subscription`, { method: 'POST', headers: { ...json, cookie: sc }, body: '{}' })).status, 409);
});

test('HTTP: standaardtaal (masterswitch) staat op elke pagina, alleen beheerders kunnen hem wijzigen', async (t) => {
  const db = freshDb();
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'a@rf.org', 'Admin', 'admin', hashPassword('admin123'));
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'm@rf.org', 'Mila', 'medewerker', hashPassword('medewerker123'));
  const server = createServer({ db, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')) }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  const login = async (email, password) => (await fetch(`${base}/api/staff/login`, { method: 'POST', headers: json, body: JSON.stringify({ email, password }) }))
    .headers.get('set-cookie').split(';')[0];
  const pages = ['/', '/login', '/aanmelden', '/portal', '/admin', '/ontvanger', '/leaderboard', '/privacy'];
  for (const p of pages) {
    const html = await (await fetch(base + p)).text();
    assert.match(html, /<script src="\/js\/i18n\.js\?v=\w+" data-default="nl"><\/script>/, p);
  }
  const mila = await login('m@rf.org', 'medewerker123');
  assert.equal((await fetch(`${base}/api/admin/settings/language`, { method: 'PUT', headers: { ...json, cookie: mila }, body: JSON.stringify({ default: 'en' }) })).status, 403);
  const admin = await login('a@rf.org', 'admin123');
  assert.equal((await fetch(`${base}/api/admin/settings/language`, { method: 'PUT', headers: { ...json, cookie: admin }, body: JSON.stringify({ default: 'fr' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/admin/settings/language`, { method: 'PUT', headers: { ...json, cookie: admin }, body: JSON.stringify({ default: 'en' }) })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/admin/settings/language`, { headers: { cookie: admin } })).json(), { default: 'en' });
  const html = await (await fetch(base + '/portal')).text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /data-default="en"/);
  assert.ok(get(db, "SELECT 1 AS x FROM audit_log WHERE action = 'standaardtaal_gewijzigd'"));
});

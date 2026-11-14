'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { openDb, get, all, run } = require('../src/db');
const S = require('../src/services');
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

test('leaderboard toont anonieme donateurs als "Anonieme donateur"', () => {
  const db = freshDb();
  const a = addDonor(db, { first_name: 'Sanne', last_name: 'de Vries', anonymous: 0 });
  const b = addDonor(db, { first_name: 'Geheim', last_name: 'Persoon', anonymous: 1 });
  S.createDonation(db, { donor_id: a, category_key: 'noodfonds', amount_cents: 1000 });
  S.createDonation(db, { donor_id: b, category_key: 'noodfonds', amount_cents: 5000 });
  const lb = S.leaderboard(db);
  assert.equal(lb[0].name, 'Anonieme donateur');
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
  S.createDonation(db, { donor_id: donor, category_key: 'schoolmaaltijd', amount_cents: 1000 });

  const server = createServer({ db, uploadDir }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const lb = await (await fetch(`${base}/api/public/leaderboard`)).json();
  assert.equal(lb.length, 1);
  assert.equal(lb[0].donor_id, undefined);
  assert.equal(lb[0].name, 'Anonieme donateur');

  assert.equal((await fetch(`${base}/api/admin/donors`)).status, 401);
  assert.equal((await fetch(`${base}/api/portal/overview`)).status, 401);

  const login = await fetch(`${base}/api/donor/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'g@x.nl', password: 'welkom123' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const overview = await (await fetch(`${base}/api/portal/overview`, { headers: { cookie } })).json();
  assert.equal(overview.totals.donated_cents, 1000);
  assert.equal(overview.totals.waiting_cents, 1000);
  // Donateur-sessie geeft geen toegang tot beheer.
  assert.equal((await fetch(`${base}/api/admin/donors`, { headers: { cookie } })).status, 401);
  // Mutaties zonder JSON content-type worden geweigerd (CSRF).
  assert.equal((await fetch(`${base}/api/portal/donate`, { method: 'POST', headers: { cookie }, body: 'amount_cents=100' })).status, 415);
});

// ------------------------------------------------------------------ chat
function chatSetup(kind = 'kind', moderated = 1) {
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
  assert.equal(supporters[0].name, 'Anonieme donateur 1');
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
  assert.throws(() => S.spend(db, { category_key: 'schoolgeld', units: 1, donor_id: selwyn }), /van deze donateur/);
});

test('donateur kan chatten met gesteunde ontvanger zonder inlog (bericht wacht)', () => {
  const db = freshDb();
  const selwyn = addDonor(db);
  S.createDonation(db, { donor_id: selwyn, category_key: 'schoolgeld', amount_cents: 15000 });
  const rid = Number(run(db, "INSERT INTO recipients (name, kind) VALUES ('Elias', 'kind')").lastInsertRowid);
  S.spend(db, { category_key: 'schoolgeld', units: 1, recipient_id: rid, donor_id: selwyn });
  const m = S.sendChat(db, { recipientId: rid, donorId: selwyn, sender: 'donor', body: 'Hoi Elias!' });
  assert.equal(m.status, 'in_behandeling');
});

test('HTTP: "inloggen als" alleen voor beheerders, volledige toegang en gelogd', async (t) => {
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
  // namens de donateur chatten en doneren mag; audit log laat zien wie het deed
  const post = await fetch(`${base}/api/portal/conversations/${rid}`, { method: 'POST', headers: { ...json, cookie: as }, body: JSON.stringify({ body: 'hoi' }) });
  assert.equal(post.status, 200);
  assert.equal((await fetch(`${base}/api/portal/donate`, { method: 'POST', headers: { ...json, cookie: as }, body: JSON.stringify({ category_key: 'noodfonds', amount_cents: 1000 }) })).status, 200);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ingelogd_als'").n, 1);
  assert.match(get(db, "SELECT actor FROM audit_log WHERE action = 'donatie_aangemaakt' ORDER BY id DESC").actor, /^medewerker:a@rf\.org als donateur:/);

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
  process.env.ANTHROPIC_API_KEY = 'test';
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

test('taal: ontvanger standaard uit land, eigen keuze gaat voor; donateur standaard Nederlands', () => {
  const T = require('../src/translate');
  assert.equal(T.recipientLanguage({ country: 'Haïti', language: '' }), 'ht');
  assert.equal(T.recipientLanguage({ country: 'Honduras', language: '' }), 'es');
  assert.equal(T.recipientLanguage({ country: 'Filipijnen', language: '' }), 'tl');
  assert.equal(T.recipientLanguage({ country: 'Haïti', language: 'fr' }), 'fr');
  assert.equal(T.recipientLanguage({ country: 'Onbekend', language: '' }), 'en');
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
  assert.equal(th.their_language, 'ht');
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

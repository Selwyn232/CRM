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

'use strict';
// Demodata voor Robin Foundation CRM: 20 kinderen in 8 gezinnen en 10 sponsors.
// Gebruik: npm run seed  (wist de bestaande database!)

const path = require('node:path');
const fs = require('node:fs');
const { openDb, run, get, all } = require('./db');
const { hashPassword } = require('./auth');
const S = require('./services');

// Deterministische pseudo-random zodat de demo altijd hetzelfde is.
let seedValue = 42;
const rnd = () => { seedValue = (seedValue * 16807) % 2147483647; return (seedValue - 1) / 2147483646; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const isoDate = (d) => d.toISOString().slice(0, 10);
const isoMonth = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Demofoto's van Filipijnse kinderen (3 jongens, 3 meisjes), per geslacht afwisselend gebruikt.
const demoPhoto = (gender, i) => `/img/kinderen/${gender === 'jongen' ? 'jongen' : 'meisje'}-${(i % 3) + 1}.jpg`;

// 10 sponsors: [voornaam, achternaam, e-mail, plaats, anoniem, weergavenaam, type, bedrijfsnaam]
const SPONSORS = [
  ['Sanne', 'de Vries', 'sanne@example.nl', 'Utrecht', 0, 'Sanne'],
  ['Mohammed', 'El Amrani', 'mohammed@example.nl', 'Rotterdam', 0, ''],
  ['Lotte', 'Jansen', 'lotte@example.nl', 'Amsterdam', 1, ''],
  ['Pieter', 'Bakker', 'pieter@example.nl', 'Den Haag', 0, 'Familie Bakker'],
  ['Emma', 'Visser', 'emma@example.nl', 'Groningen', 0, ''],
  ['Daan', 'Smit', 'daan@example.nl', 'Eindhoven', 1, ''],
  ['Fatima', 'Yilmaz', 'fatima@example.nl', 'Tilburg', 0, ''],
  ['Thomas', 'Mulder', 'thomas@example.nl', 'Almere', 0, ''],
  ['Noor', 'Bos', 'noor@example.nl', 'Leiden', 0, ''],
  ['Contact', 'Persoon', 'info@groenhuis.example.nl', 'Utrecht', 0, '', 'bedrijf', 'Groenhuis Bouw B.V.'],
];

// 8 gezinnen, 20 kinderen.
// [naam, plaats, provincie, barangay, ouder (naam + relatie), verhaal, kinderen: [voornaam, achternaam, geboren, geslacht, school, klas, verhaal]]
const FAMILIES = [
  ['Familie Santos', 'Tacloban', 'Leyte', 'San Jose', ['Liza Santos', 'moeder'], 'Vader Rodel is visser, moeder Liza verkoopt groente op de markt. Hun huis werd in 2013 door tyfoon Haiyan verwoest en is zelf weer opgebouwd.', [
    ['Maria', 'Santos', '2016-03-14', 'meisje', 'San Jose Elementary School', 'Grade 4', 'Maria houdt van tekenen en wil later lerares worden. Ze helpt thuis met de zorg voor haar kleine broertje.'],
    ['Jose', 'Santos', '2018-09-02', 'jongen', 'San Jose Elementary School', 'Grade 2', 'Jose is dol op basketbal en rekent graag. Hij loopt elke ochtend met zijn zus naar school.'],
  ]],
  ['Familie Reyes', 'Guiuan', 'Eastern Samar', 'Cogon', ['Analyn Reyes', 'moeder'], 'Moeder Analyn zorgt alleen voor drie kinderen sinds haar man op zee verongelukte. Ze maakt manden van palmbladeren.', [
    ['Ana', 'Reyes', '2015-06-21', 'meisje', 'Guiuan Central School', 'Grade 5', 'Ana is de beste lezer van haar klas. Zonder hulp zou ze van school moeten om geld te verdienen.'],
    ['Paolo', 'Reyes', '2017-01-30', 'jongen', 'Guiuan Central School', 'Grade 3', 'Paolo wil piloot worden. Hij kwam vaak zonder ontbijt naar school.'],
    ['Liezel', 'Reyes', '2019-11-11', 'meisje', 'Guiuan Central School', 'Grade 1', 'Liezel gaat dit jaar voor het eerst naar school en zingt de hele dag.'],
  ]],
  ['Familie Dela Cruz', 'Borongan', 'Eastern Samar', 'Alang-Alang', ['Ramon Dela Cruz', 'vader'], 'Een groot gezin dat leeft van een klein stukje rijstland. Na de overstroming van vorig jaar ging de oogst verloren.', [
    ['Mark', 'Dela Cruz', '2014-08-05', 'jongen', 'Borongan Elementary School', 'Grade 6', 'Mark is goed in wetenschap en repareert alles wat kapot is.'],
    ['Joy', 'Dela Cruz', '2016-12-24', 'meisje', 'Borongan Elementary School', 'Grade 3', 'Joy is geboren op kerstavond en lacht altijd. Ze wil verpleegster worden.'],
    ['Ben', 'Dela Cruz', '2018-04-02', 'jongen', 'Borongan Elementary School', 'Grade 2', 'Ben is de jongste en wil alles doen wat zijn grote broer Mark doet.'],
  ]],
  ['Familie Bautista', 'Ormoc', 'Leyte', 'Linao', ['Grace Bautista', 'moeder'], 'Vader werkt als bouwvakker als er werk is. Moeder Grace kookt voor buren om iets bij te verdienen.', [
    ['Angel', 'Bautista', '2017-04-18', 'meisje', 'Linao Elementary School', 'Grade 3', 'Angel houdt van dansen en is altijd als eerste op school.'],
    ['Rico', 'Bautista', '2015-10-09', 'jongen', 'Linao Elementary School', 'Grade 5', 'Rico speelt gitaar op een zelfgemaakte gitaar en wil muzikant worden.'],
  ]],
  ['Familie Garcia', 'Catbalogan', 'Samar', 'Mercedes', ['Lourdes Garcia', 'oma'], 'Oma Lourdes zorgt voor haar kleinkinderen. Hun ouders werken in Manilla en sturen zelden geld.', [
    ['Kristine', 'Garcia', '2016-07-07', 'meisje', 'Mercedes Elementary School', 'Grade 4', 'Kristine leest haar oma elke avond voor uit haar schoolboek.'],
    ['Nico', 'Garcia', '2018-02-15', 'jongen', 'Mercedes Elementary School', 'Grade 2', 'Nico verzamelt schelpen op het strand en kent alle vissoorten.'],
    ['Jasmin', 'Garcia', '2019-09-09', 'meisje', 'Mercedes Elementary School', 'Grade 1', 'Jasmin woont sinds kort bij oma en vindt de schoolmaaltijd het leukste van de dag.'],
  ]],
  ['Familie Mendoza', 'Palo', 'Leyte', 'Candahug', ['Rosalie Mendoza', 'moeder'], 'Moeder Rosalie is naaister. Het gezin woont in een huis van bamboe dat bij elke storm schade oploopt.', [
    ['Bea', 'Mendoza', '2015-03-03', 'meisje', 'Candahug Elementary School', 'Grade 5', 'Bea wil dokter worden zodat ze haar dorp kan helpen.'],
    ['Carlo', 'Mendoza', '2017-08-28', 'jongen', 'Candahug Elementary School', 'Grade 3', 'Carlo is stil maar heel slim. Zijn favoriete vak is tekenen.'],
    ['Mika', 'Mendoza', '2019-05-19', 'meisje', 'Candahug Elementary School', 'Grade 1', 'Mika is het jongste kind en volgt haar zus overal.'],
  ]],
  ['Familie Villanueva', 'Baybay', 'Leyte', 'Gabas', ['Edwin Villanueva', 'vader'], 'Vader Edwin is tricycle-chauffeur. Moeder is ziek en kan niet werken; de kinderen helpen thuis mee.', [
    ['Joshua', 'Villanueva', '2016-01-20', 'jongen', 'Gabas Elementary School', 'Grade 4', 'Joshua is dol op voetbal en wil later politieagent worden.'],
    ['Princess', 'Villanueva', '2018-06-06', 'meisje', 'Gabas Elementary School', 'Grade 2', 'Princess tekent prinsessen en draakjes en deelt haar lunch met vriendinnen.'],
  ]],
  ['Familie Aquino', 'Calbayog', 'Samar', 'Tinambacan', ['Marites Aquino', 'moeder'], 'Moeder Marites werkt op een kokosplantage. Het gezin heeft geen stromend water; de kinderen halen water bij de put.', [
    ['Angelo', 'Aquino', '2015-12-12', 'jongen', 'Tinambacan Elementary School', 'Grade 5', 'Angelo is de oudste en zorgt dat zijn zusje op tijd op school is.'],
    ['Daisy', 'Aquino', '2017-03-27', 'meisje', 'Tinambacan Elementary School', 'Grade 3', 'Daisy houdt van bloemen en wil later een eigen winkeltje.'],
  ]],
];

// Welke sponsor sponsort welke kinderen: [sponsor-index, [kind-indexen], maanden geleden gestart]
const PLAN = [
  [0, [0, 1], 11], [1, [2], 9], [2, [5, 6], 14], [3, [7, 8, 9], 12], [4, [10], 6],
  [5, [12], 8], [6, [16], 4], [7, [13], 3], [8, [18], 2], [9, [3, 4], 10],
];

const UPDATES = [
  ['foto', 'Eerste schooldag', 'Een foto van de eerste schooldag, met de nieuwe schooltas en het uniform dat van jouw bijdrage is gekocht.', '/img/foto-lunch.svg'],
  ['brief', 'Een brief voor jou', 'Mahal kong sponsor,\n\nSalamat po! Dankzij jou krijg ik elke dag eten op school. Ik heb een tekening voor je gemaakt van mijn familie.\n\nMet liefde', '/img/brief.svg'],
  ['foto', 'Lunch op school', 'Rijst met groente en vis: zo ziet een schoolmaaltijd eruit. Iedere schooldag een volle buik.', '/img/foto-lunch.svg'],
  ['video', 'Een filmpje om je te bedanken', 'Een kort filmpje vanaf het schoolplein.', '/media/demo-bedankt.mp4'],
  ['tekst', 'Rapport van dit kwartaal', 'De juf schrijft: goede vooruitgang in lezen en rekenen, altijd aanwezig en vrolijk in de klas.', ''],
];

// Chats: [gezin-index, berichten: [afzender, tekst, wanneer]]
const CHATS = [
  [0, [
    ['donor', 'Hallo! Wat leuk om de foto van Maria en Jose te zien. Hoe gaat het op school?', '-20 days'],
    ['recipient', 'Magandang araw po! Mabuti po ang lagay ng mga bata. Masaya si Maria sa paaralan at gustong-gusto niya ang tanghalian. — Liza, nanay ni Maria at Jose', '-19 days'],
    ['donor', 'Wat fijn om te horen. Wat is het lievelingseten van Jose?', '-17 days'],
    ['recipient', 'Kanin at isda po! Maraming salamat po sa inyong tulong. Ipinagdarasal namin kayo. — Liza', '-16 days'],
  ]],
  [3, [
    ['donor', 'Dag! Ik heb gehoord dat Rico gitaar speelt. Heeft hij al een liedje geleerd?', '-12 days'],
    ['recipient', 'Opo! Natuto na siya ng tatlong kanta. Gusto niyang kantahin para sa inyo balang araw. — Grace, nanay ni Rico at Angel', '-11 days'],
  ]],
  [1, [
    ['donor', 'Hoi! Hoe gaat het met Ana? Ik zag dat ze graag leest.', '-6 days'],
    ['recipient', 'Mabuti po. Tapos na niyang basahin ang bagong libro mula sa paaralan. Salamat po! — Analyn, nanay ni Ana', '-5 days'],
  ]],
];

// Alles behalve medewerkers, instellingen (zoals API-sleutels) en Face ID van medewerkers verwijderen.
function clearData(db) {
  db.exec(`DELETE FROM onboarding_files; DELETE FROM onboardings; DELETE FROM child_updates; DELETE FROM sponsor_months;
    DELETE FROM sponsorships; DELETE FROM children; DELETE FROM chat_translations; DELETE FROM chat_messages; DELETE FROM donor_messages;
    DELETE FROM impact_messages; DELETE FROM allocations; DELETE FROM expenditures; DELETE FROM cells; DELETE FROM donations;
    DELETE FROM interactions; DELETE FROM tasks; DELETE FROM campaigns; DELETE FROM recipients; DELETE FROM outbox; DELETE FROM donors;
    DELETE FROM passkeys WHERE kind <> 'staff'; DELETE FROM sessions WHERE kind <> 'staff'; DELETE FROM webauthn_challenges;`);
}

// Demo-inhoud: sponsors, gezinnen, kinderen, betalingen, updates, noodfonds, chats, taken.
function seedContent(db) {
  seedValue = 42;
  const SP = require('./sponsoring');
  const staff = all(db, 'SELECT id FROM users WHERE active = 1 ORDER BY id').map((u) => u.id);
  const adminId = staff[0] || null;
  const portalHash = hashPassword('welkom123');
  const now = new Date();

  const donorIds = SPONSORS.map(([fn, ln, email, city, anon, display, type = 'particulier', company = ''], i) => Number(run(db,
    `INSERT INTO donors (donor_type, first_name, last_name, company_name, email, phone, street, postal_code, city, status, source,
      anonymous, display_name, newsletter, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?, 'actief', ?, ?,?,?,?,?)`,
    type, fn, ln, company, email, `06-${between(10000000, 99999999)}`, `${pick(['Lindelaan', 'Kerkstraat', 'Molenweg', 'Dorpsstraat'])} ${between(1, 120)}`,
    `${between(1000, 9999)} ${String.fromCharCode(65 + between(0, 25))}${String.fromCharCode(65 + between(0, 25))}`, city,
    pick(['website', 'evenement', 'via via', 'social media', 'kerk']), anon, display, i % 3 ? 1 : 0, portalHash,
    isoDate(new Date(now.getFullYear(), now.getMonth() - 15, between(1, 28)))).lastInsertRowid));

  const familyIds = []; const childIds = [];
  FAMILIES.forEach(([name, city, province, barangay, [parent, relation], story, kids]) => {
    const username = name.replace(/^Familie /, '').toLowerCase().replace(/[^a-z]+/g, '');
    const fid = Number(run(db, `INSERT INTO recipients (name, kind, location, province, barangay, country, story, photo_url, consent, chat_enabled,
        chat_moderated, language, managed_by, username, password_hash)
      VALUES (?, 'gezin', ?, ?, ?, 'Filipijnen', ?, '/img/gezin.svg', 1, 1, 1, 'tl', ?, ?, ?)`,
    name, city, province, barangay, story, `${parent} (${relation})`, username, portalHash).lastInsertRowid);
    familyIds.push(fid);
    kids.forEach(([fn, ln, birth, gender, school, grade, kstory]) => {
      childIds.push(Number(run(db, `INSERT INTO children (family_id, first_name, last_name, birth_date, gender, school, grade, story, photo_url, status, available_since)
        VALUES (?,?,?,?,?,?,?,?,?, 'beschikbaar', datetime('now', ?))`, fid, fn, ln, birth, gender, school, grade, kstory,
      demoPhoto(gender, childIds.length), `-${between(20, 200)} days`).lastInsertRowid));
    });
  });

  // Sponsorschappen met betaalde maanden en maandupdates
  for (const [si, kidIdx, monthsAgo] of PLAN) {
    const donorId = donorIds[si];
    const kids = kidIdx.map((k) => childIds[k]);
    const sids = SP.startSponsorships(db, donorId, kids, { actor: 'seed' });
    const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 5);
    run(db, `UPDATE sponsorships SET started_at = ? WHERE id IN (${sids.map(() => '?').join(',')})`, `${isoDate(start)} 10:00:00`, ...sids);
    for (let m = monthsAgo; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 5);
      const res = SP.bookPayment(db, { donorId, sponsorshipIds: sids, month: isoMonth(d), method: m === monthsAgo ? 'ideal' : 'incasso',
        reference: `RF-SP-${isoMonth(d)}-${donorId}`, actor: 'seed' });
      run(db, 'UPDATE donations SET received_at = ? WHERE id = ?', isoDate(d), res.donation_id);
      run(db, 'UPDATE cells SET created_at = ? WHERE donation_id = ?', `${isoDate(d)} 12:00:00`, res.donation_id);
      run(db, 'UPDATE sponsor_months SET created_at = ? WHERE donation_id = ?', `${isoDate(d)} 12:00:00`, res.donation_id);
      if (m > 0 || rnd() < 0.4) {
        for (const kid of kids) {
          const [type, title, body, media] = UPDATES[(m + kid) % UPDATES.length];
          run(db, `INSERT INTO child_updates (child_id, donor_id, month, type, title, body, media_url, created_by, read_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, kid, donorId, isoMonth(d), type, title, body, media, adminId,
          m > 1 ? `${isoDate(d)} 20:00:00` : null, `${isoDate(new Date(d.getFullYear(), d.getMonth(), 20))} 15:00:00`);
        }
      }
    }
  }
  // Eén sponsor met een gemiste betaling
  const missed = get(db, "SELECT id FROM sponsorships WHERE donor_id = ? LIMIT 1", donorIds[7]);
  if (missed) run(db, "UPDATE sponsorships SET status = 'betaling_gemist', missed_months = 1 WHERE id = ?", missed.id);

  // Noodfonds: twee keer noodhulp ingezet
  for (const [ago, fam, desc] of [
    [5, 2, 'Tyfoon: rijst, schoon drinkwater en zeil voor 40 gezinnen in Borongan.'],
    [2, 5, 'Overstroming: nieuwe bamboe wanden en golfplaten voor het huis van de familie Mendoza.'],
  ]) {
    const avail = get(db, "SELECT COALESCE(SUM(remaining_cents),0) AS s FROM cells WHERE category_key = 'noodfonds'").s;
    const amt = Math.floor((avail * 0.4) / 100) * 100;
    if (amt < 1000) continue;
    S.spend(db, { category_key: 'noodfonds', amount_cents: amt, recipient_id: familyIds[fam], description: desc, notify: false,
      spent_at: isoDate(new Date(now.getFullYear(), now.getMonth() - ago, 18)) }, 'seed', adminId);
  }

  // Chats tussen sponsor en ouders
  for (const [fam, msgs] of CHATS) {
    const sp = get(db, 'SELECT s.donor_id FROM sponsorships s JOIN children c ON c.id = s.child_id WHERE c.family_id = ? LIMIT 1', familyIds[fam]);
    if (!sp) continue;
    for (const [sender, body, when] of msgs) {
      run(db, `INSERT INTO chat_messages (recipient_id, donor_id, sender, body, status, reviewed_by, reviewed_at, read_at, created_at)
        VALUES (?,?,?,?, 'goedgekeurd', ?, datetime('now', ?), datetime('now', ?), datetime('now', ?))`, familyIds[fam], sp.donor_id, sender, body, adminId, when, when, when);
    }
  }
  const first = get(db, 'SELECT s.donor_id FROM sponsorships s JOIN children c ON c.id = s.child_id WHERE c.family_id = ? LIMIT 1', familyIds[0]);
  if (first) {
    run(db, `INSERT INTO chat_messages (recipient_id, donor_id, sender, body, status, flag_reason, created_at)
      VALUES (?,?, 'donor', 'Zullen we via WhatsApp verder praten? Mijn nummer is 06-12345678', 'in_behandeling', 'telefoonnummer, social media', datetime('now','-2 hours'))`,
    familyIds[0], first.donor_id);
  }

  // Contactmomenten en taken
  const subjects = ['Bedankbelletje', 'Vraag over het jaaroverzicht', 'Wil graag een tweede kind sponsoren', 'Adreswijziging doorgegeven'];
  for (let i = 0; i < 12; i++) {
    run(db, `INSERT INTO interactions (donor_id, type, subject, body, user_id, occurred_at) VALUES (?,?,?,?,?, datetime('now', ?))`,
      pick(donorIds), pick(['telefoon', 'email', 'notitie']), pick(subjects), 'Prettig contact gehad.', adminId, `-${between(1, 200)} days`);
  }
  for (const [donorId, title, days, prio] of [
    [donorIds[0], 'Sanne bedanken voor bijna 1 jaar sponsoring', 2, 'hoog'],
    [donorIds[9], 'Groenhuis Bouw: voorstel om meer kinderen te sponsoren', 5, 'normaal'],
    [donorIds[7], 'Thomas bellen over de mislukte betaling', 1, 'hoog'],
    [null, 'Maandupdates Leyte verzamelen', 7, 'normaal'],
  ]) {
    run(db, `INSERT INTO tasks (donor_id, title, due_date, priority, assigned_to) VALUES (?,?, date('now', ?), ?, ?)`, donorId, title, `${days} days`, prio, adminId);
  }

  return {
    sponsors: get(db, 'SELECT COUNT(*) AS n FROM donors').n,
    children: get(db, 'SELECT COUNT(*) AS n FROM children').n,
    sponsored: get(db, "SELECT COUNT(*) AS n FROM children WHERE status = 'gesponsord'").n,
    families: get(db, 'SELECT COUNT(*) AS n FROM recipients').n,
  };
}

// Volledig nieuwe demodatabase (npm run seed): ook medewerkers.
function seed(db) {
  clearData(db);
  db.exec('DELETE FROM sessions; DELETE FROM passkeys; DELETE FROM audit_log; DELETE FROM users;');
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'robin', 'Robin Admin', 'admin', hashPassword('robin'));
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'medewerker@robinfoundation.org', 'Mila Medewerker', 'medewerker', hashPassword('medewerker123'));
  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'veld', 'Joy Veldwerker', 'veldmedewerker', hashPassword('veld'));
  return seedContent(db);
}

// Bestaande database opnieuw vullen met demodata; medewerkers en instellingen blijven.
function resetDemo(db) {
  clearData(db);
  return seedContent(db);
}

if (require.main === module) {
  const file = process.env.CRM_DB || path.join(__dirname, '..', 'data', 'crm.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const db = openDb(file);
  const stats = seed(db);
  console.log('Demodata geladen:', stats);
  console.log('Beheer:  robin / robin   (of medewerker@robinfoundation.org / medewerker123) · veldmedewerker: veld / veld');
  console.log('Sponsor: sanne@example.nl / welkom123 (alle sponsors: welkom123)');
  console.log('Ouders:  santos, reyes, delacruz, bautista, garcia, mendoza, villanueva, aquino / welkom123');
}

module.exports = { seed, resetDemo, demoPhoto };

'use strict';
// Demodata voor Robin Foundation CRM.  Gebruik: npm run seed  (wist de bestaande database!)

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

const DONORS = [
  ['Sanne', 'de Vries', 'sanne@example.nl', 'Utrecht', 0, 'Sanne'],
  ['Mohammed', 'El Amrani', 'mohammed@example.nl', 'Rotterdam', 0, ''],
  ['Lotte', 'Jansen', 'lotte@example.nl', 'Amsterdam', 1, ''],
  ['Pieter', 'Bakker', 'pieter@example.nl', 'Den Haag', 0, 'Familie Bakker'],
  ['Emma', 'Visser', 'emma@example.nl', 'Groningen', 0, ''],
  ['Daan', 'Smit', 'daan@example.nl', 'Eindhoven', 1, ''],
  ['Fatima', 'Yilmaz', 'fatima@example.nl', 'Tilburg', 0, ''],
  ['Thomas', 'Mulder', 'thomas@example.nl', 'Almere', 0, ''],
  ['Julia', 'de Boer', 'julia@example.nl', 'Breda', 1, ''],
  ['Ruben', 'Meijer', 'ruben@example.nl', 'Nijmegen', 0, ''],
  ['Anouk', 'van Dijk', 'anouk@example.nl', 'Haarlem', 0, 'Anouk vD'],
  ['Kees', 'Hendriks', 'kees@example.nl', 'Arnhem', 1, ''],
  ['Noor', 'Bos', 'noor@example.nl', 'Leiden', 0, ''],
  ['Willem', 'Peters', 'willem@example.nl', 'Zwolle', 0, ''],
  ['Ilse', 'Vos', 'ilse@example.nl', 'Maastricht', 1, ''],
  ['Sven', 'Dekker', 'sven@example.nl', 'Delft', 0, ''],
  ['Yara', 'Koster', 'yara@example.nl', 'Amersfoort', 0, ''],
  ['Bram', 'Willems', 'bram@example.nl', 'Apeldoorn', 1, ''],
];
const COMPANIES = [
  ['Groenhuis Bouw B.V.', 'info@groenhuis.example', 'Utrecht', 0],
  ['Stichting Zonnestraal', 'contact@zonnestraal.example', 'Amsterdam', 1],
  ['Bakkerij Het Korenaar', 'bakker@korenaar.example', 'Gouda', 0],
];
// Gezinnen op de Filipijnen: [naam, plaats, provincie, barangay, verhaal, kinderen: [voornaam, achternaam, geboortedatum, geslacht, school, klas, verhaal]]
const FAMILIES = [
  ['Familie Santos', 'Tacloban', 'Leyte', 'San Jose', 'Vader Rodel is visser, moeder Liza verkoopt groente op de markt. Hun huis werd in 2013 door tyfoon Haiyan verwoest en is zelf weer opgebouwd.', [
    ['Maria', 'Santos', '2016-03-14', 'meisje', 'San Jose Elementary School', 'Grade 4', 'Maria houdt van tekenen en wil later lerares worden. Ze helpt thuis met de zorg voor haar kleine broertje.'],
    ['Jose', 'Santos', '2018-09-02', 'jongen', 'San Jose Elementary School', 'Grade 2', 'Jose is dol op basketbal en rekent graag. Hij loopt elke ochtend met zijn zus naar school.'],
  ]],
  ['Familie Reyes', 'Guiuan', 'Eastern Samar', 'Cogon', 'Moeder Analyn zorgt alleen voor drie kinderen sinds haar man op zee verongelukte. Ze maakt manden van palmbladeren.', [
    ['Ana', 'Reyes', '2015-06-21', 'meisje', 'Guiuan Central School', 'Grade 5', 'Ana is de beste lezer van haar klas. Zonder hulp zou ze van school moeten om geld te verdienen.'],
    ['Paolo', 'Reyes', '2017-01-30', 'jongen', 'Guiuan Central School', 'Grade 3', 'Paolo wil piloot worden. Hij kwam vaak zonder ontbijt naar school.'],
    ['Liezel', 'Reyes', '2019-11-11', 'meisje', 'Guiuan Central School', 'Grade 1', 'Liezel gaat dit jaar voor het eerst naar school en zingt de hele dag.'],
  ]],
  ['Familie Dela Cruz', 'Borongan', 'Eastern Samar', 'Alang-Alang', 'Een groot gezin dat leeft van een klein stukje rijstland. Na de overstroming van vorig jaar ging de oogst verloren.', [
    ['Mark', 'Dela Cruz', '2014-08-05', 'jongen', 'Borongan Elementary School', 'Grade 6', 'Mark is goed in wetenschap en repareert alles wat kapot is.'],
    ['Joy', 'Dela Cruz', '2016-12-24', 'meisje', 'Borongan Elementary School', 'Grade 3', 'Joy is geboren op kerstavond en lacht altijd. Ze wil verpleegster worden.'],
  ]],
  ['Familie Bautista', 'Ormoc', 'Leyte', 'Linao', 'Vader Ramon werkt als bouwvakker als er werk is. Moeder Grace kookt voor buren om iets bij te verdienen.', [
    ['Angel', 'Bautista', '2017-04-18', 'meisje', 'Linao Elementary School', 'Grade 3', 'Angel houdt van dansen en is altijd als eerste op school.'],
    ['Rico', 'Bautista', '2015-10-09', 'jongen', 'Linao Elementary School', 'Grade 5', 'Rico speelt gitaar op een zelfgemaakte gitaar en wil muzikant worden.'],
  ]],
  ['Familie Garcia', 'Catbalogan', 'Samar', 'Mercedes', 'Oma Lourdes zorgt voor haar twee kleinkinderen. Hun ouders werken in Manilla en sturen zelden geld.', [
    ['Kristine', 'Garcia', '2016-07-07', 'meisje', 'Mercedes Elementary School', 'Grade 4', 'Kristine leest haar oma elke avond voor uit haar schoolboek.'],
    ['Nico', 'Garcia', '2018-02-15', 'jongen', 'Mercedes Elementary School', 'Grade 2', 'Nico verzamelt schelpen op het strand en kent alle vissoorten.'],
  ]],
  ['Familie Mendoza', 'Palo', 'Leyte', 'Candahug', 'Moeder Rosalie is naaister. Het gezin woont in een huis van bamboe dat bij elke storm schade oploopt.', [
    ['Bea', 'Mendoza', '2015-03-03', 'meisje', 'Candahug Elementary School', 'Grade 5', 'Bea wil dokter worden zodat ze haar dorp kan helpen.'],
    ['Carlo', 'Mendoza', '2017-08-28', 'jongen', 'Candahug Elementary School', 'Grade 3', 'Carlo is stil maar heel slim. Zijn favoriete vak is tekenen.'],
    ['Mika', 'Mendoza', '2019-05-19', 'meisje', 'Candahug Elementary School', 'Grade 1', 'Mika is het jongste kind en volgt haar zus overal.'],
  ]],
];

const UPDATES = [
  ['foto', 'Eerste schooldag', 'Een foto van de eerste schooldag, met de nieuwe schooltas en het uniform dat van jouw bijdrage is gekocht.', '/img/foto-lunch.svg'],
  ['brief', 'Een brief voor jou', 'Mahal kong sponsor,\n\nSalamat po! Dankzij jou krijg ik elke dag eten op school. Ik heb een tekening voor je gemaakt van mijn familie.\n\nMet liefde', '/img/brief.svg'],
  ['foto', 'Lunch op school', 'Rijst met groente en vis: zo ziet een schoolmaaltijd eruit. Iedere schooldag een volle buik.', '/img/foto-lunch.svg'],
  ['video', 'Een filmpje om je te bedanken', 'Een kort filmpje vanaf het schoolplein.', '/media/demo-bedankt.mp4'],
  ['tekst', 'Rapport van dit kwartaal', 'De juf schrijft: goede vooruitgang in lezen en rekenen, altijd aanwezig en vrolijk in de klas.', ''],
];

const isoMonth = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Sponsormodel: gezinnen, kinderen, sponsorschappen met betaalde maanden, updates, noodfonds en chats.
function seedSponsoring(db, { donorIds, adminId, portalHash }) {
  const SP = require('./sponsoring');
  const familyIds = []; const childIds = [];
  FAMILIES.forEach(([name, city, province, barangay, story, kids], fi) => {
    const fid = Number(run(db, `INSERT INTO recipients (name, kind, location, province, barangay, country, story, photo_url, consent, chat_enabled, language)
      VALUES (?, 'gezin', ?, ?, ?, 'Filipijnen', ?, '/img/gezin.svg', 1, 1, 'tl')`, name, city, province, barangay, story).lastInsertRowid);
    familyIds.push(fid);
    kids.forEach(([fn, ln, birth, gender, school, grade, kstory], ki) => {
      childIds.push(Number(run(db, `INSERT INTO children (family_id, first_name, last_name, birth_date, gender, school, grade, story, photo_url, status, available_since)
        VALUES (?,?,?,?,?,?,?,?,?, 'beschikbaar', datetime('now', ?))`, fid, fn, ln, birth, gender, school, grade, kstory,
      `/img/kind${((fi + ki) % 3) + 1}.svg`, `-${between(20, 200)} days`).lastInsertRowid));
    });
  });
  // Eén aanmelding die nog beoordeeld moet worden.
  run(db, `INSERT INTO children (family_id, first_name, last_name, birth_date, gender, school, grade, story, status)
    VALUES (?, 'Jasmin', 'Garcia', '2019-09-09', 'meisje', 'Mercedes Elementary School', 'Grade 1', 'Nichtje van Kristine en Nico, net bij oma komen wonen.', 'te_beoordelen')`, familyIds[4]);

  // Sponsors: [donor-index, aantal kinderen, maanden geleden gestart]
  const plan = [[0, 2, 11], [1, 1, 9], [3, 2, 14], [4, 1, 6], [7, 1, 8], [9, 1, 3], [18, 2, 12]];
  let next = 0;
  const now = new Date();
  for (const [di, count, monthsAgo] of plan) {
    const donorId = donorIds[di];
    if (!donorId) continue;
    const kids = childIds.slice(next, next + count);
    next += count;
    if (kids.length < count) break;
    const sids = SP.startSponsorships(db, donorId, kids, { actor: 'seed' });
    const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 5);
    run(db, `UPDATE sponsorships SET started_at = ? WHERE id IN (${sids.map(() => '?').join(',')})`, `${isoDate(start)} 10:00:00`, ...sids);
    for (let m = monthsAgo; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 5);
      const res = SP.bookPayment(db, { donorId, sponsorshipIds: sids, month: isoMonth(d), method: m === monthsAgo ? 'ideal' : 'incasso',
        reference: `RF-SP-${isoMonth(d)}-${donorId}`, actor: 'seed' });
      run(db, 'UPDATE donations SET received_at = ? WHERE id = ?', isoDate(d), res.donation_id);
      run(db, "UPDATE cells SET created_at = ? WHERE donation_id = ?", `${isoDate(d)} 12:00:00`, res.donation_id);
      run(db, 'UPDATE sponsor_months SET created_at = ? WHERE donation_id = ?', `${isoDate(d)} 12:00:00`, res.donation_id);
      // Maandupdate per kind (de huidige maand nog niet voor iedereen)
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
  const missed = get(db, "SELECT id FROM sponsorships WHERE donor_id = ? AND status = 'actief' LIMIT 1", donorIds[9] || 0);
  if (missed) run(db, "UPDATE sponsorships SET status = 'betaling_gemist', missed_months = 1 WHERE id = ?", missed.id);

  // Noodfonds: twee bestedingen na een storm, met bericht aan de sponsors van wie het geld kwam.
  for (const [ago, fam, desc, title, body, media] of [
    [5, 2, 'Tyfoon: rijst, schoon drinkwater en zeil voor 40 gezinnen in Borongan.', 'Noodhulp na de tyfoon in Borongan', 'Dankzij het Robin Noodfonds kregen 40 gezinnen binnen twee dagen rijst, drinkwater en zeil om hun dak te dichten. Ook de familie Dela Cruz kreeg hulp.', '/img/foto-dak.svg'],
    [2, 5, 'Overstroming: nieuwe bamboe wanden en golfplaten voor het huis van de familie Mendoza.', 'Het huis van de familie Mendoza is weer droog', 'Na de overstroming zijn de wanden en het dak van het huis van de familie Mendoza vernieuwd met geld uit het noodfonds.', '/img/foto-dak.svg'],
  ]) {
    const avail = get(db, "SELECT COALESCE(SUM(remaining_cents),0) AS s FROM cells WHERE category_key = 'noodfonds'").s;
    const amt = Math.floor((avail * 0.4) / 100) * 100;
    if (amt < 1000) continue;
    const d = new Date(now.getFullYear(), now.getMonth() - ago, 18);
    const res = S.spend(db, { category_key: 'noodfonds', amount_cents: amt, recipient_id: familyIds[fam], spent_at: isoDate(d), description: desc }, 'seed', adminId);
    S.addImpactMessage(db, res.id, { type: 'foto', title, body, media_url: media, recipient_id: familyIds[fam] }, 'seed');
  }

  // Inlog voor twee gezinnen + voorbeeldchats in het Tagalog
  run(db, "UPDATE recipients SET username = 'santos', password_hash = ?, managed_by = 'Veldmedewerker Leyte' WHERE id = ?", portalHash, familyIds[0]);
  run(db, "UPDATE recipients SET username = 'reyes', password_hash = ?, managed_by = 'Veldmedewerker Samar' WHERE id = ?", portalHash, familyIds[1]);
  const convo = [
    ['donor', 'Hallo familie Santos! Wat leuk om de foto van Maria en Jose te zien. Hoe gaat het op school?', '-20 days'],
    ['recipient', 'Magandang araw po! Mabuti po ang lagay ng mga bata. Masaya si Maria sa paaralan at gustong-gusto niya ang tanghalian.', '-19 days'],
    ['donor', 'Wat fijn om te horen. Wat is het lievelingseten van Jose?', '-17 days'],
    ['recipient', 'Kanin at isda po! Maraming salamat po sa inyong tulong. Ipinagdarasal namin kayo.', '-16 days'],
  ];
  const santos = get(db, 'SELECT donor_id FROM sponsorships s JOIN children c ON c.id = s.child_id WHERE c.family_id = ? LIMIT 1', familyIds[0]);
  if (santos) {
    for (const [sender, body, when] of convo) {
      run(db, `INSERT INTO chat_messages (recipient_id, donor_id, sender, body, status, reviewed_by, reviewed_at, read_at, created_at)
        VALUES (?,?,?,?, 'goedgekeurd', ?, datetime('now', ?), datetime('now', ?), datetime('now', ?))`, familyIds[0], santos.donor_id, sender, body, adminId, when, when, when);
    }
    run(db, `INSERT INTO chat_messages (recipient_id, donor_id, sender, body, status, flag_reason, created_at)
      VALUES (?,?, 'donor', 'Zullen we via WhatsApp verder praten? Mijn nummer is 06-12345678', 'in_behandeling', 'telefoonnummer, social media', datetime('now','-2 hours'))`,
    familyIds[0], santos.donor_id);
  }
  return { families: familyIds.length, children: childIds.length };
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

function seed(db) {
  db.exec(`DELETE FROM child_updates; DELETE FROM sponsor_months; DELETE FROM sponsorships; DELETE FROM children; DELETE FROM chat_messages; DELETE FROM donor_messages; DELETE FROM impact_messages; DELETE FROM allocations; DELETE FROM expenditures;
    DELETE FROM cells; DELETE FROM donations; DELETE FROM interactions; DELETE FROM tasks; DELETE FROM campaigns;
    DELETE FROM recipients; DELETE FROM outbox; DELETE FROM sessions; DELETE FROM audit_log; DELETE FROM donors; DELETE FROM users;`);

  const adminId = Number(run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)',
    'robin', 'Robin Admin', 'admin', hashPassword('robin')).lastInsertRowid);
  const staffId = Number(run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)',
    'medewerker@robinfoundation.org', 'Mila Medewerker', 'medewerker', hashPassword('medewerker123')).lastInsertRowid);

  run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', 'veld', 'Joy Veldwerker', 'veldmedewerker', hashPassword('veld'));
  const portalHash = hashPassword('welkom123');
  const donorIds = [];
  const tagsPool = ['maandgever', 'major donor', 'nieuwsbrief', 'evenement 2025', 'ambassadeur', 'kerkgemeente', 'collega'];
  DONORS.forEach(([fn, ln, email, city, anon, display], i) => {
    const r = run(db, `INSERT INTO donors (donor_type, first_name, last_name, email, phone, street, postal_code, city, status, source,
      tags, anonymous, display_name, newsletter, password_hash, created_at)
      VALUES ('particulier',?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?)`,
      fn, ln, email, `06-${between(10000000, 99999999)}`, `${pick(['Lindelaan', 'Kerkstraat', 'Molenweg', 'Dorpsstraat', 'Stationsplein'])} ${between(1, 120)}`,
      `${between(1000, 9999)} ${String.fromCharCode(65 + between(0, 25))}${String.fromCharCode(65 + between(0, 25))}`, city,
      i === 16 ? 'inactief' : 'actief', pick(['website', 'evenement', 'via via', 'social media', 'kerk', 'bedrijfsactie']),
      rnd() > 0.5 ? pick(tagsPool) : '', anon, display, rnd() > 0.3 ? 1 : 0, i < 12 ? portalHash : null,
      isoDate(new Date(Date.now() - between(430, 700) * 864e5)));
    donorIds.push(Number(r.lastInsertRowid));
  });
  COMPANIES.forEach(([name, email, city, anon]) => {
    const r = run(db, `INSERT INTO donors (donor_type, company_name, first_name, last_name, email, city, status, source, tags, anonymous, created_at)
      VALUES (?,?,?,?,?,?,'actief','zakelijk netwerk','major donor',?, date('now','-400 days'))`,
      name.startsWith('Stichting') ? 'stichting' : 'bedrijf', name, 'Contact', 'Persoon', email, city, anon);
    donorIds.push(Number(r.lastInsertRowid));
  });
  // Een prospect zonder donaties.
  run(db, `INSERT INTO donors (first_name, last_name, email, city, status, source, notes) VALUES
    ('Hanna','Lambers','hanna@example.nl','Ede','prospect','evenement','Interesse getoond op de kerstmarkt; wil info over het sponsoren van een kind.')`);

  seedSponsoring(db, { donorIds, adminId, portalHash });

  // Interacties & taken
  const types = ['telefoon', 'email', 'afspraak', 'notitie', 'evenement'];
  const subjects = ['Bedankbelletje', 'Vraag over jaaroverzicht', 'Kennismaking op kantoor', 'Wil graag maandelijks gaan geven',
    'Bezocht benefietdiner', 'Adreswijziging doorgegeven', 'Wil graag een tweede kind sponsoren'];
  for (let i = 0; i < 30; i++) {
    run(db, `INSERT INTO interactions (donor_id, type, subject, body, user_id, occurred_at) VALUES (?,?,?,?,?, datetime('now', ?))`,
      pick(donorIds), pick(types), pick(subjects), 'Prettig contact gehad. Afspraken vastgelegd.', pick([adminId, staffId]),
      `-${between(1, 300)} days`);
  }
  const taskRows = [
    [donorIds[0], 'Sanne bedanken voor 1 jaar maandelijkse steun', 2, 'hoog'],
    [donorIds[18], 'Groenhuis Bouw: voorstel bedrijfssponsoring sturen', 5, 'hoog'],
    [donorIds[3], 'Familie Bakker uitnodigen voor projectbezoek', 12, 'normaal'],
    [null, 'Maandupdates Leyte inscannen en plaatsen', 1, 'hoog'],
    [donorIds[16], 'Yara benaderen: inactief sinds vorig jaar', -3, 'normaal'],
    [null, 'Jaaroverzichten versturen', 40, 'laag'],
  ];
  for (const [donorId, title, days, prio] of taskRows) {
    run(db, `INSERT INTO tasks (donor_id, title, due_date, priority, assigned_to) VALUES (?,?, date('now', ?), ?, ?)`,
      donorId, title, `${days} days`, prio, pick([adminId, staffId]));
  }
  run(db, `INSERT INTO tasks (donor_id, title, due_date, priority, status, assigned_to, completed_at)
    VALUES (?, 'Welkomstpakket versturen', date('now','-10 days'), 'normaal', 'afgerond', ?, datetime('now','-11 days'))`, donorIds[4], staffId);

  return {
    donors: get(db, 'SELECT COUNT(*) AS n FROM donors').n,
    donations: get(db, 'SELECT COUNT(*) AS n FROM donations').n,
    children: get(db, 'SELECT COUNT(*) AS n FROM children').n,
    sponsorships: get(db, 'SELECT COUNT(*) AS n FROM sponsorships').n,
  };
}

if (require.main === module) {
  const file = process.env.CRM_DB || path.join(__dirname, '..', 'data', 'crm.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const db = openDb(file);
  const stats = seed(db);
  console.log('Demodata geladen:', stats);
  console.log('Beheer:  robin / robin   (of medewerker@robinfoundation.org / medewerker123) · veldmedewerker: veld / veld');
  console.log('Portaal: sanne@example.nl / welkom123');
  console.log('Gezinnen: santos / welkom123 · reyes / welkom123');
}

module.exports = { seed, seedSponsoring };

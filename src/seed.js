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
const RECIPIENTS = [
  ['Amara', 'kind', 9, 'Escuela Esperanza', 'Gonaïves', 'Haïti', 'Amara wil later dokter worden. Dankzij de schoolmaaltijden kan zij zich beter concentreren in de klas.', '/img/kind1.svg', 1],
  ['Joseph', 'kind', 11, 'Escuela Esperanza', 'Gonaïves', 'Haïti', 'Joseph loopt elke dag 5 km naar school. Zijn favoriete vak is rekenen.', '/img/kind2.svg', 1],
  ['Lucia', 'kind', 7, 'Colegio San Martín', 'Tegucigalpa', 'Honduras', 'Lucia gaat dit jaar voor het eerst naar school.', '/img/kind3.svg', 1],
  ['Mateo', 'kind', 12, 'Colegio San Martín', 'Tegucigalpa', 'Honduras', 'Mateo helpt na school zijn moeder op de markt.', '/img/kind2.svg', 0],
  ['Familie Pierre', 'gezin', null, '', 'Les Cayes', 'Haïti', 'Het huis van de familie Pierre werd zwaar beschadigd door orkaan Melissa.', '/img/gezin.svg', 1],
  ['Escuela Esperanza', 'school', null, '', 'Gonaïves', 'Haïti', 'Basisschool met 240 leerlingen. Robin Foundation verzorgt hier dagelijks de lunch.', '/img/school.svg', 1],
  ['Gemeenschap Roatán-Oost', 'gemeenschap', null, '', 'Roatán', 'Honduras', 'Kustgemeenschap die na de storm zonder drinkwater kwam te zitten.', '/img/gezin.svg', 1],
  ['Grace', 'kind', 8, 'Escuela Esperanza', 'Gonaïves', 'Haïti', 'Grace houdt van tekenen en zingen.', '/img/kind3.svg', 1],
  ['Kliniek Santa Rosa', 'organisatie', null, '', 'Santa Rosa de Copán', 'Honduras', 'Kleine kliniek die de gezondheidspakketten verdeelt.', '/img/school.svg', 1],
];

const LETTERS = {
  schoolmaaltijd: [
    ['brief', 'Een brief van Amara', 'Lieve donateur,\n\nIk ben Amara en ik zit in groep 5. Elke middag krijg ik nu rijst met bonen op school. Mijn buik doet geen pijn meer en ik kan goed opletten. Ik heb een tekening voor je gemaakt van onze school.\n\nDankjewel!\nAmara'],
    ['foto', 'Lunchtijd op Escuela Esperanza', 'Vandaag kregen 240 kinderen een warme maaltijd. Op de foto zie je de kinderen in de rij voor de lunch.'],
    ['video', 'Joseph bedankt je met een filmpje', 'Joseph vertelt in dit filmpje wat hij het lekkerst vindt op school (spoiler: de bananen!).'],
  ],
  schoolgeld: [
    ['brief', 'Lucia mag naar school!', 'Hallo,\n\nMijn naam is Lucia. Ik ben 7 jaar. Dit jaar mag ik voor het eerst naar school omdat jij het schoolgeld hebt betaald. Ik heb een nieuw schrift en ik kan al mijn naam schrijven!\n\nGroetjes, Lucia'],
    ['brief', 'Rapport van Joseph', 'Beste donateur, Joseph heeft het schooljaar afgerond met een 8 voor rekenen. Hij schrijft: "Bedankt dat ik naar school mag. Later word ik ingenieur."'],
  ],
  noodfonds: [
    ['foto', 'Nieuw dak voor de familie Pierre', 'Met het noodfonds hebben we golfplaten, spijkers en een bouwploeg gefinancierd. De familie Pierre woont weer droog.'],
    ['tekst', 'Drinkwater voor Roatán-Oost', 'Binnen 48 uur na de storm stonden er waterfilters en jerrycans klaar voor 60 gezinnen.'],
  ],
  gezondheidspakket: [
    ['foto', 'Pakketten uitgedeeld in Santa Rosa', 'De kliniek heeft de gezondheidspakketten (zeep, tandpasta, ORS, muskietennet, verband) uitgedeeld aan gezinnen.'],
    ['brief', 'Bedankt van zuster Rosa', 'Beste gever, dankzij de pakketten hebben we deze maand veel minder kinderen met diarree gezien. Hartelijk dank!'],
  ],
};

function isoDate(d) { return d.toISOString().slice(0, 10); }

function seed(db) {
  db.exec(`DELETE FROM donor_messages; DELETE FROM impact_messages; DELETE FROM allocations; DELETE FROM expenditures;
    DELETE FROM cells; DELETE FROM donations; DELETE FROM interactions; DELETE FROM tasks; DELETE FROM campaigns;
    DELETE FROM recipients; DELETE FROM outbox; DELETE FROM sessions; DELETE FROM audit_log; DELETE FROM donors; DELETE FROM users;`);

  const adminId = Number(run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)',
    'admin@robinfoundation.org', 'Robin Admin', 'admin', hashPassword('admin123')).lastInsertRowid);
  const staffId = Number(run(db, 'INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)',
    'medewerker@robinfoundation.org', 'Mila Medewerker', 'medewerker', hashPassword('medewerker123')).lastInsertRowid);

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
    ('Hanna','Lambers','hanna@example.nl','Ede','prospect','evenement','Interesse getoond op de kerstmarkt; wil info over schoolgeld.')`);

  const recipientIds = RECIPIENTS.map((r) => Number(run(db,
    'INSERT INTO recipients (name, kind, age, school, location, country, story, photo_url, consent) VALUES (?,?,?,?,?,?,?,?,?)',
    ...r).lastInsertRowid));
  const recipientFor = {
    schoolmaaltijd: [0, 1, 5, 7], schoolgeld: [0, 1, 2, 3, 7], noodfonds: [4, 6], gezondheidspakket: [8],
  };

  const camp1 = Number(run(db, `INSERT INTO campaigns (name, description, category_key, goal_cents, start_date, end_date)
    VALUES ('Orkaan Melissa noodhulp', 'Spoedactie na orkaan Melissa in het Caribisch gebied.', 'noodfonds', 2500000, date('now','-60 days'), date('now','+30 days'))`).lastInsertRowid);
  const camp2 = Number(run(db, `INSERT INTO campaigns (name, description, category_key, goal_cents, start_date, end_date)
    VALUES ('Terug naar school 2026', 'Schoolgeld voor 100 kinderen in het nieuwe schooljaar.', 'schoolgeld', 1500000, date('now','-120 days'), date('now','+60 days'))`).lastInsertRowid);

  const cats = all(db, 'SELECT * FROM categories ORDER BY sort_order');
  const amounts = { schoolmaaltijd: [1000, 1500, 2500, 5000], schoolgeld: [5000, 7500, 15000, 30000], noodfonds: [2000, 5000, 10000, 25000], gezondheidspakket: [2500, 5000, 7500] };
  const methods = ['ideal', 'ideal', 'ideal', 'incasso', 'overboeking', 'creditcard', 'contant'];
  const msgIdx = {};

  // 14 maanden geschiedenis, chronologisch: eerst donaties, dan bestedingen.
  for (let m = 13; m >= 0; m--) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setMonth(monthStart.getMonth() - m);
    const daysInMonth = m === 0 ? Math.max(1, new Date().getDate() - 1) : 28;

    const count = between(6, 12) + (m < 3 ? 4 : 0);
    for (let i = 0; i < count; i++) {
      const donorIdx = rnd() < 0.35 ? between(0, 5) : between(0, donorIds.length - 1);
      const cat = pick(cats);
      const date = new Date(monthStart);
      date.setDate(between(1, daysInMonth));
      let amount = pick(amounts[cat.key]);
      if (donorIdx >= DONORS.length) amount *= 4; // bedrijven geven meer
      const received = isoDate(date);
      const status = m === 0 && rnd() < 0.15 ? 'in_afwachting' : 'ontvangen';
      let campaign = null;
      if (cat.key === 'noodfonds' && m <= 2) campaign = camp1;
      if (cat.key === 'schoolgeld' && m <= 4) campaign = camp2;
      const d = S.createDonation(db, {
        donor_id: donorIds[donorIdx], category_key: cat.key, amount_cents: amount, method: pick(methods),
        frequency: donorIdx < 4 ? 'maandelijks' : pick(['eenmalig', 'eenmalig', 'eenmalig', 'jaarlijks']),
        status, received_at: received, campaign_id: campaign, reference: `RF-${received.replace(/-/g, '')}-${i}`,
      }, 'seed');
      run(db, 'UPDATE cells SET created_at = ? WHERE donation_id = ?', `${received} 12:00:00`, d.id);
    }

    if (m === 0) continue; // de huidige maand laat geld in de cellen staan
    const spendDate = new Date(monthStart);
    spendDate.setDate(27);
    for (const cat of cats) {
      if (rnd() < 0.25) continue;
      const avail = get(db, 'SELECT COALESCE(SUM(remaining_cents),0) AS s FROM cells WHERE category_key = ?', cat.key).s;
      let input;
      if (cat.unit_cost_cents) {
        const maxUnits = Math.floor((avail * 0.7) / cat.unit_cost_cents);
        if (maxUnits < 1) continue;
        input = { units: cat.key === 'schoolgeld' ? Math.min(maxUnits, between(1, 3)) : Math.min(maxUnits, between(40, 400)) };
      } else {
        const amt = Math.floor(avail * 0.6 / 100) * 100;
        if (amt < 1000) continue;
        input = { amount_cents: amt };
      }
      const recipientId = recipientIds[pick(recipientFor[cat.key])];
      const res = S.spend(db, {
        ...input, category_key: cat.key, recipient_id: recipientId, spent_at: isoDate(spendDate),
        description: {
          schoolmaaltijd: 'Schoolmaaltijden (rijst, bonen, groente) voor de maand.',
          schoolgeld: 'Toelatingsgeld voor het schooljaar inclusief schoolmateriaal.',
          noodfonds: 'Noodhulp: bouwmaterialen, waterfilters en voedselpakketten.',
          gezondheidspakket: 'Inkoop en distributie gezondheidspakketten via de kliniek.',
        }[cat.key],
      }, 'seed', rnd() < 0.5 ? adminId : staffId);
      // Meestal komt er ook een brief/foto/filmpje bij; soms nog niet (zichtbaar als "wacht op bericht").
      if (m > 1 || rnd() < 0.4) {
        const list = LETTERS[cat.key];
        msgIdx[cat.key] = ((msgIdx[cat.key] ?? -1) + 1) % list.length;
        const [type, title, body] = list[msgIdx[cat.key]];
        const media = type === 'foto' ? { schoolmaaltijd: '/img/foto-lunch.svg', noodfonds: '/img/foto-dak.svg' }[cat.key] || '/img/school.svg'
          : type === 'brief' ? '/img/brief.svg' : type === 'video' ? '/media/demo-bedankt.mp4' : '';
        S.addImpactMessage(db, res.id, { type, title, body, media_url: media, recipient_id: recipientId }, 'seed');
      }
    }
  }

  // Een deel van de berichten is al gelezen.
  run(db, `UPDATE donor_messages SET read_at = datetime(delivered_at, '+2 days') WHERE id % 3 <> 0`);
  // Bezorgdatum gelijk aan bestedingsdatum voor een realistische tijdlijn.
  run(db, `UPDATE donor_messages SET delivered_at = (SELECT e.spent_at || ' 15:00:00' FROM impact_messages im
    JOIN expenditures e ON e.id = im.expenditure_id WHERE im.id = donor_messages.impact_message_id)`);
  run(db, `UPDATE impact_messages SET created_at = (SELECT spent_at || ' 15:00:00' FROM expenditures WHERE id = impact_messages.expenditure_id)`);

  // Interacties & taken
  const types = ['telefoon', 'email', 'afspraak', 'notitie', 'evenement'];
  const subjects = ['Bedankbelletje', 'Vraag over jaaroverzicht', 'Kennismaking op kantoor', 'Wil graag maandelijks gaan geven',
    'Bezocht benefietdiner', 'Adreswijziging doorgegeven', 'Interesse in schoolgeld-sponsoring'];
  for (let i = 0; i < 30; i++) {
    run(db, `INSERT INTO interactions (donor_id, type, subject, body, user_id, occurred_at) VALUES (?,?,?,?,?, datetime('now', ?))`,
      pick(donorIds), pick(types), pick(subjects), 'Prettig contact gehad. Afspraken vastgelegd.', pick([adminId, staffId]),
      `-${between(1, 300)} days`);
  }
  const taskRows = [
    [donorIds[0], 'Sanne bedanken voor 1 jaar maandelijkse steun', 2, 'hoog'],
    [donorIds[18], 'Groenhuis Bouw: voorstel bedrijfssponsoring sturen', 5, 'hoog'],
    [donorIds[3], 'Familie Bakker uitnodigen voor projectbezoek', 12, 'normaal'],
    [null, 'Brieven Escuela Esperanza inscannen en koppelen', 1, 'hoog'],
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
    expenditures: get(db, 'SELECT COUNT(*) AS n FROM expenditures').n,
    messages: get(db, 'SELECT COUNT(*) AS n FROM impact_messages').n,
  };
}

if (require.main === module) {
  const file = process.env.CRM_DB || path.join(__dirname, '..', 'data', 'crm.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const db = openDb(file);
  const stats = seed(db);
  console.log('Demodata geladen:', stats);
  console.log('Beheer:  admin@robinfoundation.org / admin123   (of medewerker@robinfoundation.org / medewerker123)');
  console.log('Portaal: sanne@example.nl / welkom123');
}

module.exports = { seed };

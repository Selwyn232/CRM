'use strict';
// Database-laag: SQLite via de ingebouwde node:sqlite module (geen externe dependencies).
// Alle geldbedragen worden opgeslagen in eurocenten (integers) om afrondingsfouten te voorkomen.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'medewerker' CHECK (role IN ('admin','medewerker')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_type TEXT NOT NULL DEFAULT 'particulier' CHECK (donor_type IN ('particulier','bedrijf','stichting')),
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'Nederland',
  status TEXT NOT NULL DEFAULT 'actief' CHECK (status IN ('prospect','actief','inactief')),
  source TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  anonymous INTEGER NOT NULL DEFAULT 1,       -- standaard anoniem (AVG): naam alleen tonen na toestemming
  display_name TEXT NOT NULL DEFAULT '',
  newsletter INTEGER NOT NULL DEFAULT 1,
  preferred_channel TEXT NOT NULL DEFAULT 'email',
  password_hash TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- De vier bestemmingen waaraan gedoneerd kan worden.
CREATE TABLE IF NOT EXISTS categories (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  unit_label TEXT NOT NULL DEFAULT '',        -- bv. 'maaltijd', 'schooljaar', 'pakket'
  unit_label_plural TEXT NOT NULL DEFAULT '',
  unit_cost_cents INTEGER,                     -- NULL = vrij bedrag (noodfonds)
  icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#2f855a',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_key TEXT REFERENCES categories(key),
  goal_cents INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  category_key TEXT NOT NULL REFERENCES categories(key),
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL DEFAULT 'ideal',
  frequency TEXT NOT NULL DEFAULT 'eenmalig' CHECK (frequency IN ('eenmalig','maandelijks','kwartaal','jaarlijks')),
  status TEXT NOT NULL DEFAULT 'ontvangen' CHECK (status IN ('ontvangen','in_afwachting','geannuleerd')),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Elke ontvangen donatie krijgt een eigen "cel": een apart potje waarin het geld
-- bewaard blijft totdat het daadwerkelijk wordt uitgegeven.
CREATE TABLE IF NOT EXISTS cells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL UNIQUE REFERENCES donations(id) ON DELETE CASCADE,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  category_key TEXT NOT NULL REFERENCES categories(key),
  amount_cents INTEGER NOT NULL,
  remaining_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'wachtend' CHECK (status IN ('wachtend','deels_besteed','besteed','vervallen')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  spent_at TEXT
);

CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'kind' CHECK (kind IN ('kind','gezin','school','gemeenschap','organisatie')),
  age INTEGER,
  school TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  story TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0,          -- toestemming om foto/verhaal te delen met donateurs
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Een besteding = het moment waarop geld uit één of meer cellen wordt uitgegeven.
CREATE TABLE IF NOT EXISTS expenditures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_key TEXT NOT NULL REFERENCES categories(key),
  recipient_id INTEGER REFERENCES recipients(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  units INTEGER,
  description TEXT NOT NULL DEFAULT '',
  spent_at TEXT NOT NULL DEFAULT (date('now')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Koppeling cel -> besteding: welk deel van welke cel is waaraan uitgegeven.
CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expenditure_id INTEGER NOT NULL REFERENCES expenditures(id) ON DELETE CASCADE,
  cell_id INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Brief, filmpje, foto of tekst van de ontvanger.
CREATE TABLE IF NOT EXISTS impact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expenditure_id INTEGER NOT NULL REFERENCES expenditures(id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES recipients(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'brief' CHECK (type IN ('brief','video','foto','tekst')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  media_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inbox van de donateur.
CREATE TABLE IF NOT EXISTS donor_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  impact_message_id INTEGER NOT NULL REFERENCES impact_messages(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  UNIQUE (donor_id, impact_message_id)
);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'notitie' CHECK (type IN ('notitie','telefoon','email','afspraak','brief','evenement')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER REFERENCES donors(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'normaal' CHECK (priority IN ('laag','normaal','hoog')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','afgerond')),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- E-mail log: elke (gesimuleerde) e-mail die het systeem verstuurt.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER REFERENCES donors(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'algemeen',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('staff','donor','recipient')),
  subject_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations(donor_id);
CREATE INDEX IF NOT EXISTS idx_cells_cat_status ON cells(category_key, status);
CREATE INDEX IF NOT EXISTS idx_cells_donor ON cells(donor_id);
CREATE INDEX IF NOT EXISTS idx_alloc_exp ON allocations(expenditure_id);
CREATE INDEX IF NOT EXISTS idx_alloc_donor ON allocations(donor_id);
CREATE INDEX IF NOT EXISTS idx_dm_donor ON donor_messages(donor_id);
CREATE INDEX IF NOT EXISTS idx_interactions_donor ON interactions(donor_id);

-- Chat tussen ontvanger en donateur. Berichten kunnen eerst door een medewerker gemodereerd worden.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('donor','recipient')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'goedgekeurd' CHECK (status IN ('in_behandeling','goedgekeurd','afgewezen')),
  flag_reason TEXT NOT NULL DEFAULT '',
  reject_reason TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(recipient_id, donor_id);
CREATE INDEX IF NOT EXISTS idx_chat_status ON chat_messages(status);
`;

const DEFAULT_CATEGORIES = [
  {
    key: 'schoolmaaltijd', name: 'Schoolmaaltijd', sort_order: 1, icon: '🍲', color: '#dd6b20',
    description: 'Een voedzame maaltijd op school voor een kind.',
    unit_label: 'maaltijd', unit_label_plural: 'maaltijden', unit_cost_cents: 50,
  },
  {
    key: 'schoolgeld', name: 'Schoolgeld', sort_order: 2, icon: '🎒', color: '#3182ce',
    description: 'Het toelatingsgeld zodat een kind een heel jaar naar school kan.',
    unit_label: 'schooljaar', unit_label_plural: 'schooljaren', unit_cost_cents: 15000,
  },
  {
    key: 'noodfonds', name: 'Noodfonds stormen & orkanen', sort_order: 3, icon: '🌀', color: '#805ad5',
    description: 'Directe noodhulp na stormen en orkanen.',
    unit_label: '', unit_label_plural: '', unit_cost_cents: null,
  },
  {
    key: 'gezondheidspakket', name: 'Gezondheidspakket', sort_order: 4, icon: '🩺', color: '#38a169',
    description: 'Een pakket met hygiëne- en basismedische middelen.',
    unit_label: 'pakket', unit_label_plural: 'pakketten', unit_cost_cents: 2500,
  },
];

function openDb(file) {
  const target = file || process.env.CRM_DB || path.join(__dirname, '..', 'data', 'crm.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec(SCHEMA);
  migrate(db);
  const insertCat = db.prepare(`INSERT OR IGNORE INTO categories
    (key, name, description, unit_label, unit_label_plural, unit_cost_cents, icon, color, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const c of DEFAULT_CATEGORIES) {
    insertCat.run(c.key, c.name, c.description, c.unit_label, c.unit_label_plural,
      c.unit_cost_cents, c.icon, c.color, c.sort_order);
  }
  return db;
}

// Kolommen/constraints toevoegen aan bestaande databases.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(recipients)').all().map((c) => c.name);
  const add = (col, def) => { if (!cols.includes(col)) db.exec(`ALTER TABLE recipients ADD COLUMN ${col} ${def}`); };
  add('username', 'TEXT');                                    // inlognaam ontvanger
  add('password_hash', 'TEXT');
  add('managed_by', "TEXT NOT NULL DEFAULT ''");              // begeleider (bij kinderen verplicht)
  add('chat_enabled', 'INTEGER NOT NULL DEFAULT 1');
  add('chat_moderated', 'INTEGER NOT NULL DEFAULT 1');        // berichten eerst laten goedkeuren
  add('last_login_at', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_recipients_username ON recipients(username COLLATE NOCASE)');

  const sessionCols = () => db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  // Oude sessions-tabel kende geen ontvanger-sessies: opnieuw aanmaken (sessies zijn wegwerpdata).
  const s = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (s && !s.sql.includes("'recipient'")) {
    db.exec(`DROP TABLE sessions; CREATE TABLE sessions (token TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('staff','donor','recipient')), subject_id INTEGER NOT NULL, expires_at TEXT NOT NULL);`);
  }
  if (!sessionCols().includes('impersonator_id')) db.exec('ALTER TABLE sessions ADD COLUMN impersonator_id INTEGER');
}

// Voert fn uit binnen een transactie; rollback bij een fout.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// node:sqlite geeft objecten zonder prototype terug; normaliseer naar gewone objecten.
const plain = (row) => (row ? { ...row } : row);
const all = (db, sql, ...params) => db.prepare(sql).all(...params).map(plain);
const get = (db, sql, ...params) => plain(db.prepare(sql).get(...params));
const run = (db, sql, ...params) => db.prepare(sql).run(...params);

module.exports = { openDb, tx, all, get, run, DEFAULT_CATEGORIES };

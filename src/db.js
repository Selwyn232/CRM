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
  role TEXT NOT NULL DEFAULT 'medewerker' CHECK (role IN ('admin','medewerker','veldmedewerker')),
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
  consent INTEGER NOT NULL DEFAULT 0,          -- toestemming om foto/verhaal te delen met sponsoren
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

-- Inbox van de sponsor.
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

-- ======================= Sponsormodel =======================
-- Kinderen (gezinnen zijn rijen in recipients met kind = 'gezin').
CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER REFERENCES recipients(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  birth_date TEXT,
  gender TEXT NOT NULL DEFAULT '',
  school TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  story TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'beschikbaar'
    CHECK (status IN ('concept','te_beoordelen','beschikbaar','gesponsord','inactief','afgekeurd')),
  reserved_until TEXT,
  reserved_by INTEGER,
  available_since TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_children_status ON children(status);

CREATE TABLE IF NOT EXISTS sponsorships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'actief' CHECK (status IN ('actief','betaling_gemist','beeindigd')),
  monthly_cents INTEGER NOT NULL,
  missed_months INTEGER NOT NULL DEFAULT 0,
  subscription_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  end_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_spons_donor ON sponsorships(donor_id);
CREATE INDEX IF NOT EXISTS idx_spons_child ON sponsorships(child_id);
CREATE INDEX IF NOT EXISTS idx_spons_sub ON sponsorships(subscription_id);

-- Per sponsorschap per maand: wat er van die maand is betaald (verdeling bevroren op dat moment).
CREATE TABLE IF NOT EXISTS sponsor_months (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sponsorship_id INTEGER NOT NULL REFERENCES sponsorships(id) ON DELETE CASCADE,
  donor_id INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  donation_id INTEGER REFERENCES donations(id) ON DELETE SET NULL,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  lines TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sponsorship_id, month)
);
CREATE INDEX IF NOT EXISTS idx_sm_child ON sponsor_months(child_id, month);

-- Maandelijkse update (foto, brief, filmpje) per kind, bezorgd bij de sponsor van dat moment.
CREATE TABLE IF NOT EXISTS child_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  donor_id INTEGER REFERENCES donors(id) ON DELETE SET NULL,
  month TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'foto' CHECK (type IN ('brief','video','foto','tekst')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  media_url TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cu_child ON child_updates(child_id, month);
CREATE INDEX IF NOT EXISTS idx_cu_donor ON child_updates(donor_id);

-- ======================= Onboarding (veldmedewerker meldt een gezin met kinderen aan) =======================
CREATE TABLE IF NOT EXISTS onboardings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'concept'
    CHECK (status IN ('concept','ingediend','aanvulling_nodig','goedgekeurd','afgekeurd')),
  data TEXT NOT NULL DEFAULT '{}',                 -- gezin, ouder/voogd, kinderen, toestemming (JSON)
  family_id INTEGER REFERENCES recipients(id) ON DELETE SET NULL,   -- na goedkeuring
  id_method TEXT NOT NULL DEFAULT 'handmatig' CHECK (id_method IN ('veriff','handmatig')),
  id_status TEXT NOT NULL DEFAULT 'open' CHECK (id_status IN ('open','in_behandeling','goedgekeurd','afgewezen','opnieuw')),
  id_session TEXT,
  id_url TEXT NOT NULL DEFAULT '',
  id_result TEXT NOT NULL DEFAULT '',              -- samenvatting van de controle (JSON)
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_onb_status ON onboardings(status);
CREATE INDEX IF NOT EXISTS idx_onb_session ON onboardings(id_session);

-- Documenten en foto's van een aanmelding. Staan in een PRIVÉ map, alleen via de API te openen (met audit).
CREATE TABLE IF NOT EXISTS onboarding_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onboarding_id INTEGER NOT NULL REFERENCES onboardings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                              -- id_document, selfie, foto_gezin, adres, toestemming, handtekening, foto_kind, geboorteakte, inschrijving
  child_index INTEGER,                             -- bij kind-documenten: welk kind (0, 1, …)
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_onbf ON onboarding_files(onboarding_id);

-- ======================= Passkeys (Face ID / vingerafdruk) =======================
-- Alleen de publieke sleutel staat hier; het gezicht of de vingerafdruk verlaat het toestel nooit.
CREATE TABLE IF NOT EXISTS passkeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('staff','donor','recipient')),
  subject_id INTEGER NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,          -- base64url
  public_key TEXT NOT NULL,                    -- base64url (COSE)
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkeys_subject ON passkeys(kind, subject_id);

-- Eenmalige uitdagingen voor registreren/inloggen (5 minuten geldig).
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','login')),
  kind TEXT,
  subject_id INTEGER,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Chat tussen ontvanger en sponsor. Berichten kunnen eerst door een medewerker gemodereerd worden.
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

-- Vertaalcache: elk bericht wordt per taal maar één keer vertaald.
CREATE TABLE IF NOT EXISTS chat_translations (
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  source_lang TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, lang)
);
`;

const DEFAULT_CATEGORIES = [
  {
    key: 'sponsoring', name: 'Sponsoring kind', sort_order: 0, icon: '🧒', color: '#5b5bd6',
    description: 'Maandelijkse sponsoring van een kind: maaltijden, school, verzorging en noodfonds.',
    unit_label: 'kind', unit_label_plural: 'kinderen', unit_cost_cents: 5000,
  },
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
  // Sponsormodel: alleen sponsoring en het noodfonds zijn nog te kiezen; de oude bestemmingen blijven voor de historie.
  db.exec(`UPDATE categories SET active = 0 WHERE key IN ('schoolmaaltijd','schoolgeld','gezondheidspakket');
    UPDATE categories SET name = 'Robin Noodfonds', description = 'Gezamenlijke pot voor noodsituaties zoals orkanen en overstromingen.' WHERE key = 'noodfonds' AND name = 'Noodfonds stormen & orkanen';`);
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
  add('language', "TEXT NOT NULL DEFAULT ''");                // leest/schrijft in; leeg = afleiden uit land
  const donorCols = db.prepare('PRAGMA table_info(donors)').all().map((c) => c.name);
  if (!donorCols.includes('language')) db.exec("ALTER TABLE donors ADD COLUMN language TEXT NOT NULL DEFAULT 'nl'");
  if (!donorCols.includes('mollie_customer_id')) db.exec('ALTER TABLE donors ADD COLUMN mollie_customer_id TEXT');
  const addCol = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('users', 'nav_prefs', "TEXT NOT NULL DEFAULT ''");          // eigen menuvolgorde (JSON)
  for (const c of ['street', 'barangay', 'province', 'phone']) addCol('recipients', c, "TEXT NOT NULL DEFAULT ''");
  addCol('donations', 'meta', "TEXT NOT NULL DEFAULT ''");             // bv. gekozen kinderen bij een checkout
  addCol('outbox', 'status', "TEXT NOT NULL DEFAULT 'gelogd'");      // gelogd | verzonden | mislukt
  addCol('outbox', 'error', "TEXT NOT NULL DEFAULT ''");
  addCol('outbox', 'provider_id', "TEXT NOT NULL DEFAULT ''");
  addCol('donations', 'external_id', 'TEXT');                         // Mollie-betaling (tr_…)
  addCol('donations', 'subscription_id', 'TEXT');                     // Mollie-abonnement (sub_…)
  db.exec('CREATE INDEX IF NOT EXISTS idx_donations_external ON donations(external_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_recipients_username ON recipients(username COLLATE NOCASE)');

  const sessionCols = () => db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  // Oude sessions-tabel kende geen ontvanger-sessies: opnieuw aanmaken (sessies zijn wegwerpdata).
  const s = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (s && !s.sql.includes("'recipient'")) {
    db.exec(`DROP TABLE sessions; CREATE TABLE sessions (token TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('staff','donor','recipient')), subject_id INTEGER NOT NULL, expires_at TEXT NOT NULL);`);
  }
  // Rol 'veldmedewerker' toevoegen: de CHECK op users.role vraagt om het opnieuw opbouwen van de tabel.
  const u = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (u && !u.sql.includes('veldmedewerker')) {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).join(', ');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'medewerker' CHECK (role IN ('admin','medewerker','veldmedewerker')),
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        nav_prefs TEXT NOT NULL DEFAULT ''
      )`);
      db.exec(`INSERT INTO users_new (${cols}) SELECT ${cols} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  if (!sessionCols().includes('impersonator_id')) db.exec('ALTER TABLE sessions ADD COLUMN impersonator_id INTEGER');
}

// Voert fn uit binnen een transactie; rollback bij een fout.
function tx(db, fn) {
  // Genest (een transactie binnen een transactie): gewoon meedoen met de buitenste.
  if (db.__txDepth) { db.__txDepth++; try { return fn(); } finally { db.__txDepth--; } }
  db.exec('BEGIN IMMEDIATE');
  db.__txDepth = 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.__txDepth = 0;
  }
}

// node:sqlite geeft objecten zonder prototype terug; normaliseer naar gewone objecten.
const plain = (row) => (row ? { ...row } : row);
const all = (db, sql, ...params) => db.prepare(sql).all(...params).map(plain);
const get = (db, sql, ...params) => plain(db.prepare(sql).get(...params));
const run = (db, sql, ...params) => db.prepare(sql).run(...params);

module.exports = { openDb, tx, all, get, run, DEFAULT_CATEGORIES };

'use strict';
// Onboarding van gezinnen en kinderen door een veldmedewerker, met identiteitscontrole van de ouder/voogd,
// documenten en toestemming. Een tweede medewerker beoordeelt; pas na goedkeuring worden gezin en kinderen
// aangemaakt en zijn de kinderen zichtbaar voor sponsoren.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tx, all, get, run } = require('./db');
const S = require('./services');
const auth = require('./auth');
const { AppError } = S;

const str = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
const parse = (j, d) => { try { return JSON.parse(j); } catch { return d; } };

const FILE_KINDS = {
  id_document: { label: 'Foto van paspoort of ID van de ouder/voogd', family: true },
  selfie: { label: 'Selfie van de ouder/voogd', family: true },
  foto_gezin: { label: 'Foto van het gezin', family: true },
  adres: { label: 'Bewijs van adres (Barangay certificate)', family: true },
  toestemming: { label: 'Toestemmingsverklaring (scan)', family: true },
  handtekening: { label: 'Handtekening ouder/voogd', family: true },
  foto_kind: { label: 'Foto van het kind', family: false },
  geboorteakte: { label: 'Geboorteakte (PSA)', family: false },
  inschrijving: { label: 'Inschrijfbewijs school', family: false },
};
const EXT_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf' };
const MAX_FILE = 15 * 1024 * 1024;
const ID_TYPES = ['paspoort', 'philsys', 'rijbewijs', 'umid', 'postal_id', 'voter_id', 'anders'];
const CONSENT_TEXT = 'Ik geef Robin Foundation toestemming om de gegevens van mij en mijn kinderen te verwerken voor het sponsorprogramma. '
  + 'Ik weet dat de sponsor de voornaam, leeftijd, school, provincie, het verhaal en (als ik dat hieronder aanvink) foto’s van mijn kind te zien krijgt, '
  + 'en dat de sponsor met ons gezin kan chatten via Robin Foundation. Adres, achternaam en documenten worden nooit met sponsoren gedeeld. '
  + 'Ik kan deze toestemming altijd intrekken.';

// Alleen bekende velden overnemen.
function cleanData(input = {}) {
  const f = input.family || {}; const g = input.guardian || {}; const c = input.consent || {};
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  return {
    family: {
      name: str(f.name, 120), street: str(f.street, 200), barangay: str(f.barangay, 120), city: str(f.city, 120),
      province: str(f.province, 120), phone: str(f.phone, 40), story: str(f.story, 5000), members: str(f.members, 500),
      income: str(f.income, 300),
    },
    guardian: {
      first_name: str(g.first_name, 80), last_name: str(g.last_name, 80), relation: str(g.relation, 60), birth_date: date(g.birth_date),
      id_type: ID_TYPES.includes(g.id_type) ? g.id_type : '', id_last4: str(g.id_last4, 4).replace(/[^0-9a-z]/gi, ''),
      phone: str(g.phone, 40),
    },
    children: (Array.isArray(input.children) ? input.children : []).slice(0, 10).map((k) => ({
      first_name: str(k.first_name, 80), last_name: str(k.last_name, 80), birth_date: date(k.birth_date),
      gender: ['jongen', 'meisje'].includes(k.gender) ? k.gender : '', school: str(k.school, 200), grade: str(k.grade, 60),
      story: str(k.story, 5000),
    })),
    consent: {
      agreed: !!c.agreed, share_photos: !!c.share_photos, signed_by: str(c.signed_by, 120),
      signed_at: c.agreed ? (str(c.signed_at, 30) || new Date().toISOString()) : '',
    },
  };
}

// Wat moet er nog gebeuren voordat de aanmelding kan worden ingediend?
function checklist(onb, files) {
  const d = parse(onb.data, cleanData());
  const has = (kind, idx = null) => files.some((f) => f.kind === kind && (idx === null || f.child_index === idx));
  const items = [];
  const add = (key, label, ok, step) => items.push({ key, label, ok: !!ok, step });
  add('family', 'Gezin: naam, barangay, plaats en provincie', d.family.name && d.family.barangay && d.family.city && d.family.province, 'gezin');
  add('family_story', 'Verhaal van het gezin', d.family.story.length >= 40, 'gezin');
  add('guardian', 'Ouder/voogd: naam, relatie en geboortedatum', d.guardian.first_name && d.guardian.last_name && d.guardian.relation && d.guardian.birth_date, 'ouder');
  if (onb.id_method === 'veriff') {
    add('id', 'Identiteit gecontroleerd door Veriff', onb.id_status === 'goedgekeurd', 'ouder');
  } else {
    add('id', 'Foto van paspoort of ID én selfie', has('id_document') && has('selfie') && d.guardian.id_type, 'ouder');
  }
  add('children', 'Minimaal één kind', d.children.length > 0, 'kinderen');
  d.children.forEach((k, i) => {
    const n = k.first_name || `Kind ${i + 1}`;
    add(`child${i}`, `${n}: naam, geboortedatum, school en verhaal`, k.first_name && k.last_name && k.birth_date && k.school && k.story.length >= 40, 'kinderen');
    add(`child${i}_docs`, `${n}: foto, geboorteakte (PSA) en inschrijfbewijs school`, has('foto_kind', i) && has('geboorteakte', i) && has('inschrijving', i), 'kinderen');
  });
  add('docs', 'Foto van het gezin en bewijs van adres (Barangay)', has('foto_gezin') && has('adres'), 'documenten');
  add('consent', 'Toestemming ondertekend door de ouder/voogd', d.consent.agreed && d.consent.signed_by && (has('handtekening') || has('toestemming')), 'toestemming');
  return items;
}

function makeService({ db, uploadDir, privateDir }) {
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const filesOf = (id) => all(db, 'SELECT id, kind, child_index, mime, size, created_at FROM onboarding_files WHERE onboarding_id = ? ORDER BY id', id);
  const removeFile = (f) => { try { fs.unlinkSync(path.join(privateDir, f.file)); } catch { /* al weg */ } run(db, 'DELETE FROM onboarding_files WHERE id = ?', f.id); };

  function view(onb) {
    const files = filesOf(onb.id);
    const creator = onb.created_by ? get(db, 'SELECT name FROM users WHERE id = ?', onb.created_by) : null;
    const reviewer = onb.reviewed_by ? get(db, 'SELECT name FROM users WHERE id = ?', onb.reviewed_by) : null;
    const { id_session, ...rest } = onb;
    return { ...rest, data: parse(onb.data, cleanData()), id_result: parse(onb.id_result, null), files, checklist: checklist(onb, files),
      created_by_name: creator ? creator.name : '', reviewed_by_name: reviewer ? reviewer.name : '', consent_text: CONSENT_TEXT };
  }

  const load = (id) => {
    const onb = get(db, 'SELECT * FROM onboardings WHERE id = ?', id);
    if (!onb) throw new AppError(404, 'Aanmelding niet gevonden');
    return onb;
  };
  const isReviewer = (user) => user.role === 'admin' || user.role === 'medewerker';
  // Veldmedewerkers zien alleen hun eigen aanmeldingen.
  function access(id, user) {
    const onb = load(id);
    if (!isReviewer(user) && onb.created_by !== user.id) throw new AppError(404, 'Aanmelding niet gevonden');
    return onb;
  }
  function editable(id, user) {
    const onb = access(id, user);
    if (!['concept', 'aanvulling_nodig'].includes(onb.status)) throw new AppError(409, 'Deze aanmelding is ingediend en kan niet meer worden gewijzigd');
    return onb;
  }

  function list(user, status) {
    const where = []; const args = [];
    if (!isReviewer(user)) { where.push('o.created_by = ?'); args.push(user.id); }
    if (status) { where.push('o.status = ?'); args.push(status); }
    return all(db, `SELECT o.*, u.name AS created_by_name, (SELECT COUNT(*) FROM onboarding_files f WHERE f.onboarding_id = o.id) AS file_count
      FROM onboardings o LEFT JOIN users u ON u.id = o.created_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE o.status WHEN 'ingediend' THEN 0 WHEN 'aanvulling_nodig' THEN 1 WHEN 'concept' THEN 2 ELSE 3 END, o.updated_at DESC LIMIT 500`, ...args)
      .map((o) => {
        const d = parse(o.data, cleanData());
        const files = filesOf(o.id);
        const cl = checklist(o, files);
        return { id: o.id, status: o.status, id_method: o.id_method, id_status: o.id_status, family_name: d.family.name, city: d.family.city,
          province: d.family.province, children: d.children.map((k) => k.first_name).filter(Boolean), created_by_name: o.created_by_name,
          created_at: o.created_at, updated_at: o.updated_at, submitted_at: o.submitted_at, review_note: o.review_note,
          done: cl.filter((x) => x.ok).length, total: cl.length, family_id: o.family_id };
      });
  }

  function create(user, input) {
    const r = run(db, 'INSERT INTO onboardings (data, created_by, id_method) VALUES (?,?,?)', JSON.stringify(cleanData(input || {})), user.id,
      require('./idcheck').isEnabled() ? 'veriff' : 'handmatig');
    S.audit(db, `medewerker:${user.email}`, 'onboarding_gestart', 'onboarding', Number(r.lastInsertRowid));
    return view(load(Number(r.lastInsertRowid)));
  }

  function save(id, user, input) {
    const onb = editable(id, user);
    const data = cleanData(input.data || input);
    const method = ['veriff', 'handmatig'].includes(input.id_method) && onb.id_status !== 'goedgekeurd' ? input.id_method : onb.id_method;
    if (method === 'veriff' && !require('./idcheck').isEnabled()) throw new AppError(400, 'Veriff is nog niet gekoppeld; kies handmatige controle');
    run(db, "UPDATE onboardings SET data = ?, id_method = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(data), method, id);
    return view(load(id));
  }

  function addFile(id, user, { kind, child_index, filename, data }) {
    editable(id, user);
    if (!FILE_KINDS[kind]) throw new AppError(400, 'Onbekend soort document');
    const idx = FILE_KINDS[kind].family ? null : Number(child_index);
    if (idx !== null && (!Number.isInteger(idx) || idx < 0 || idx > 9)) throw new AppError(400, 'Ongeldig kind');
    const ext = path.extname(String(filename || '')).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime) throw new AppError(400, 'Alleen foto’s (jpg, png, webp, heic) of pdf');
    const buf = Buffer.from(String(data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw new AppError(400, 'Leeg bestand');
    if (buf.length > MAX_FILE) throw new AppError(413, 'Bestand is te groot (max. 15 MB)');
    const name = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(privateDir, name), buf, { mode: 0o600 });
    // Eén bestand per soort (per kind): het oude vervangen.
    for (const old of all(db, 'SELECT * FROM onboarding_files WHERE onboarding_id = ? AND kind = ? AND child_index IS ?', id, kind, idx)) removeFile(old);
    const r = run(db, 'INSERT INTO onboarding_files (onboarding_id, kind, child_index, file, mime, size, uploaded_by) VALUES (?,?,?,?,?,?,?)',
      id, kind, idx, name, mime, buf.length, user.id);
    run(db, "UPDATE onboardings SET updated_at = datetime('now') WHERE id = ?", id);
    S.audit(db, `medewerker:${user.email}`, 'onboarding_document', 'onboarding', id, kind);
    return get(db, 'SELECT id, kind, child_index, mime, size, created_at FROM onboarding_files WHERE id = ?', Number(r.lastInsertRowid));
  }

  function deleteFile(id, fileId, user) {
    editable(id, user);
    const f = get(db, 'SELECT * FROM onboarding_files WHERE id = ? AND onboarding_id = ?', fileId, id);
    if (!f) throw new AppError(404, 'Bestand niet gevonden');
    removeFile(f);
  }

  // Ruwe inhoud van een privébestand, voor ingelogde medewerkers. Elke keer bekijken wordt gelogd.
  function readFile(fileId, user) {
    const f = get(db, 'SELECT * FROM onboarding_files WHERE id = ?', fileId);
    if (!f) throw new AppError(404, 'Bestand niet gevonden');
    access(f.onboarding_id, user);
    let body;
    try { body = fs.readFileSync(path.join(privateDir, f.file)); } catch { throw new AppError(404, 'Bestand niet gevonden'); }
    // Eigen upload terugzien hoeft niet gelogd; iedere andere inzage wel.
    if (f.uploaded_by !== user.id) S.audit(db, `medewerker:${user.email}`, 'document_bekeken', 'onboarding_file', f.id, `${f.kind} (aanmelding ${f.onboarding_id})`);
    return { __raw: true, body, headers: { 'Content-Type': f.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${f.kind}${path.extname(f.file)}"` } };
  }

  async function startVeriff(id, user, callback) {
    const onb = editable(id, user);
    const V = require('./idcheck');
    if (!V.isEnabled()) throw new AppError(400, 'Veriff is nog niet gekoppeld (Instellingen → Integraties)');
    const d = parse(onb.data, cleanData());
    if (!d.guardian.first_name || !d.guardian.last_name) throw new AppError(400, 'Vul eerst de naam van de ouder/voogd in');
    let s;
    try { s = await V.createSession({ firstName: d.guardian.first_name, lastName: d.guardian.last_name, vendorData: `onboarding-${id}`, callback }); }
    catch (err) { throw new AppError(502, `Veriff: ${err.message}`); }
    run(db, "UPDATE onboardings SET id_method = 'veriff', id_status = 'in_behandeling', id_session = ?, id_url = ?, updated_at = datetime('now') WHERE id = ?", s.id, s.url, id);
    S.audit(db, `medewerker:${user.email}`, 'idcontrole_gestart', 'onboarding', id);
    return { url: s.url };
  }

  function veriffDecision(payload) {
    const v = payload && payload.verification;
    if (!v || !v.id) return false;
    const onb = get(db, 'SELECT * FROM onboardings WHERE id_session = ?', v.id);
    if (!onb) return false;
    const { status, summary } = require('./idcheck').mapDecision(v);
    run(db, "UPDATE onboardings SET id_status = ?, id_result = ?, updated_at = datetime('now') WHERE id = ?", status, JSON.stringify(summary), onb.id);
    S.audit(db, 'veriff', 'idcontrole_uitslag', 'onboarding', onb.id, status);
    return true;
  }

  function submit(id, user) {
    const onb = editable(id, user);
    const open = checklist(onb, filesOf(id)).filter((x) => !x.ok);
    if (open.length) throw new AppError(400, `Nog niet compleet: ${open.map((x) => x.label).join('; ')}`);
    run(db, "UPDATE onboardings SET status = 'ingediend', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id);
    const d = parse(onb.data, cleanData());
    run(db, "INSERT INTO tasks (title, description, priority) VALUES (?, ?, 'normaal')", `Aanmelding beoordelen: ${d.family.name}`,
      `Aanmelding #${id} van ${user.name} (${d.children.length} ${d.children.length === 1 ? 'kind' : 'kinderen'}). Zie Onboarding.`);
    S.audit(db, `medewerker:${user.email}`, 'onboarding_ingediend', 'onboarding', id);
    return view(load(id));
  }

  function copyPublic(f) {
    if (!f || !f.mime.startsWith('image/') || f.mime === 'image/heic') return '';
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(f.file)}`;
    fs.copyFileSync(path.join(privateDir, f.file), path.join(uploadDir, name));
    return `/uploads/${name}`;
  }

  function uniqueUsername(familyName) {
    const base = `familie-${String(familyName).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^(familie|family|pamilya)\s+/, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'gezin'}`;
    let u = base; let n = 1;
    while (get(db, 'SELECT id FROM recipients WHERE username = ?', u)) u = `${base}-${++n}`;
    return u;
  }

  function review(id, user, { decision, note = '', id_checked, docs_checked, create_login = true }) {
    if (!isReviewer(user)) throw new AppError(403, 'Alleen medewerkers kunnen beoordelen');
    const onb = load(id);
    if (onb.status !== 'ingediend') throw new AppError(409, 'Deze aanmelding wacht niet op beoordeling');
    if (onb.created_by === user.id) throw new AppError(403, 'Vier-ogenprincipe: een andere medewerker moet jouw aanmelding beoordelen');
    const actor = `medewerker:${user.email}`;
    const reason = str(note, 1000);
    if (decision === 'aanvulling' || decision === 'afkeuren') {
      if (!reason) throw new AppError(400, 'Geef een toelichting voor de veldmedewerker');
      run(db, `UPDATE onboardings SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        decision === 'aanvulling' ? 'aanvulling_nodig' : 'afgekeurd', reason, user.id, id);
      if (decision === 'afkeuren') {
        // Afgekeurd: identiteitsdocumenten direct verwijderen (niet langer bewaren dan nodig).
        for (const f of all(db, "SELECT * FROM onboarding_files WHERE onboarding_id = ? AND kind IN ('id_document','selfie')", id)) removeFile(f);
      }
      S.audit(db, actor, decision === 'aanvulling' ? 'onboarding_aanvulling' : 'onboarding_afgekeurd', 'onboarding', id, reason);
      return { ...view(load(id)) };
    }
    if (decision !== 'goedkeuren') throw new AppError(400, 'Onbekende beslissing');
    if (!docs_checked) throw new AppError(400, 'Bevestig dat je de documenten hebt gecontroleerd');
    if (onb.id_method === 'handmatig' && !id_checked) throw new AppError(400, 'Bevestig dat je het ID en de selfie hebt vergeleken');
    if (onb.id_method === 'veriff' && onb.id_status !== 'goedgekeurd') throw new AppError(400, 'De identiteitscontrole van Veriff is niet goedgekeurd');
    const files = all(db, 'SELECT * FROM onboarding_files WHERE onboarding_id = ?', id);
    const d = parse(onb.data, cleanData());
    let login = null;
    const result = tx(db, () => {
      const fam = d.family; const g = d.guardian;
      const famId = Number(run(db, `INSERT INTO recipients (name, kind, location, province, barangay, street, phone, country, story, photo_url, consent,
          chat_enabled, chat_moderated, language, managed_by) VALUES (?, 'gezin', ?, ?, ?, ?, ?, 'Filipijnen', ?, ?, ?, 1, 1, 'tl', ?)`,
      fam.name, fam.city, fam.province, fam.barangay, fam.street, fam.phone || g.phone, fam.story,
      d.consent.share_photos ? copyPublic(files.find((f) => f.kind === 'foto_gezin')) : '', d.consent.share_photos ? 1 : 0,
      `${g.first_name} ${g.last_name} (${g.relation})`).lastInsertRowid);
      const childIds = d.children.map((k, i) => Number(run(db, `INSERT INTO children (family_id, first_name, last_name, birth_date, gender, school, grade, story, photo_url, status)
        VALUES (?,?,?,?,?,?,?,?,?, 'beschikbaar')`, famId, k.first_name, k.last_name, k.birth_date, k.gender, k.school, k.grade, k.story,
      d.consent.share_photos ? copyPublic(files.find((f) => f.kind === 'foto_kind' && f.child_index === i)) : '').lastInsertRowid));
      if (create_login) {
        const password = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10);
        login = { username: uniqueUsername(fam.name), password };
        run(db, 'UPDATE recipients SET username = ?, password_hash = ? WHERE id = ?', login.username, auth.hashPassword(password), famId);
      }
      run(db, `UPDATE onboardings SET status = 'goedgekeurd', family_id = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'),
        updated_at = datetime('now') WHERE id = ?`, famId, reason, user.id, id);
      return { famId, childIds };
    });
    // Identiteitsdocumenten zijn na de controle niet meer nodig: verwijderen (dataminimalisatie). De uitslag blijft bewaard.
    const idFiles = files.filter((f) => f.kind === 'id_document' || f.kind === 'selfie');
    for (const f of idFiles) removeFile(f);
    if (onb.id_method === 'handmatig') {
      run(db, 'UPDATE onboardings SET id_result = ? WHERE id = ?', JSON.stringify({ provider: 'handmatig', decision: 'approved',
        checked_by: user.name, document_type: d.guardian.id_type, document_last4: d.guardian.id_last4, decided_at: new Date().toISOString(),
        id_files_removed: idFiles.length }), id);
    }
    S.audit(db, actor, 'onboarding_goedgekeurd', 'onboarding', id, { family: result.famId, children: result.childIds.length });
    return { ...view(load(id)), login, family_id: result.famId, child_ids: result.childIds };
  }

  function remove(id, user) {
    const onb = access(id, user);
    if (onb.status !== 'concept' && user.role !== 'admin') throw new AppError(409, 'Alleen een concept kan worden verwijderd');
    for (const f of all(db, 'SELECT * FROM onboarding_files WHERE onboarding_id = ?', id)) removeFile(f);
    run(db, 'DELETE FROM onboardings WHERE id = ?', id);
    S.audit(db, `medewerker:${user.email}`, 'onboarding_verwijderd', 'onboarding', id);
  }

  return { list, create, save, addFile, deleteFile, readFile, startVeriff, veriffDecision, submit, review, remove, get: (id, user) => view(access(id, user)) };
}

module.exports = { makeService, cleanData, checklist, FILE_KINDS, ID_TYPES, CONSENT_TEXT };

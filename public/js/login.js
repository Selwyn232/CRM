// Eén inlogpagina voor sponsoren, ontvangers (ouders), medewerkers en veldwerkers.
'use strict';

const $ = (s) => document.querySelector(s);
const KIND = { donateur: 'donor', ontvanger: 'recipient', medewerker: 'staff', veldwerker: 'staff' };
const ROLES = {
  donateur: {
    login: '/api/donor/login', me: '/api/donor/me', home: '/portal',
    idLabel: 'E-mailadres', idType: 'email', idField: 'email',
    demo: 'Demo: <b>sanne@example.nl</b> / <b>welkom123</b>',
  },
  ontvanger: {
    login: '/api/recipient/login', me: '/api/recipient/me', home: '/ontvanger',
    idLabel: 'Gebruikersnaam', idType: 'text', idField: 'username',
    demo: 'Demo: <b>santos</b> / <b>welkom123</b>',
  },
  medewerker: {
    login: '/api/staff/login', me: '/api/staff/me', home: '/admin',
    idLabel: 'E-mail of gebruikersnaam', idType: 'text', idField: 'email',
    demo: 'Demo: <b>robin</b> / <b>robin</b>',
  },
  veldwerker: {
    login: '/api/staff/login', me: '/api/staff/me', home: '/admin',
    idLabel: 'Gebruikersnaam', idType: 'text', idField: 'email',
    demo: 'Demo: <b>veld</b> / <b>veld</b>',
  },
};

const params = new URLSearchParams(location.search);
// Alleen interne paden als terug-adres (geen open redirect).
const back = (() => {
  const t = params.get('terug') || '';
  return /^\/(portal|ontvanger|admin)(\/|#|$)/.test(t) ? t : '';
})();

let role = 'donateur';
const store = { get: () => { try { return localStorage.getItem('rf_role'); } catch { return null; } },
  set: (v) => { try { localStorage.setItem('rf_role', v); } catch { /* geen opslag */ } } };

function setRole(r) {
  role = ROLES[r] ? r : 'donateur';
  const cfg = ROLES[role];
  document.querySelectorAll('.role-picker button').forEach((b) => {
    const on = b.dataset.role === role;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
  $('#f-id-label').textContent = cfg.idLabel;
  $('#f-id').type = cfg.idType;
  $('#demo').innerHTML = cfg.demo;
  $('#demo').hidden = !demoMode;
  document.querySelectorAll('.login-extra').forEach((p) => p.classList.toggle('hidden', p.dataset.for !== role));
  showRegister(false);
  $('#login-form .form-error').hidden = true;
  checkAlready();
}

// Al ingelogd in deze rol? Toon een snelkoppeling (niet automatisch doorsturen, dan kun je van rol wisselen).
let checkSeq = 0;
async function checkAlready() {
  const seq = ++checkSeq;
  const box = $('#already');
  box.classList.add('hidden');
  try {
    const me = await RF.api(ROLES[role].me);
    if (seq !== checkSeq) return;
    const name = me.full_name || me.name || me.email || '';
    box.innerHTML = `Je bent al ingelogd${name ? ` als <b>${RF.esc(name)}</b>` : ''}. <a href="${ROLES[role].home}">Ga verder →</a>`;
    box.classList.remove('hidden');
  } catch { /* niet ingelogd */ }
}

function showRegister(on) {
  $('#login-form').classList.toggle('hidden', on);
  $('#register-form').classList.toggle('hidden', !on);
}

const goHome = () => location.replace(back && back.startsWith(ROLES[role].home) ? back : ROLES[role].home);

document.querySelector('.role-picker').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-role]');
  if (!b) return;
  setRole(b.dataset.role);
  $('#f-id').focus();
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = form.querySelector('.form-error');
  const btn = form.querySelector('button');
  err.hidden = true;
  btn.disabled = true;
  try {
    const cfg = ROLES[role];
    await RF.api(cfg.login, { method: 'POST', body: { [cfg.idField]: form.elements.id.value.trim(), password: form.elements.password.value } });
    store.set(role);
    if (await offerFaceId()) return; // eerst Face ID aanbieden, daarna door
    goHome();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ Face ID
const P = RF.passkeys;
const faceLabel = P.label();
// Na inloggen met wachtwoord: op een toestel met Face ID/vingerafdruk één keer aanbieden om dat in te stellen.
async function offerFaceId() {
  try {
    if (!P.supported() || !await P.platform()) return false;
    let declined = false;
    try { declined = localStorage.getItem(`rf_faceid_later_${role}`) === '1'; } catch { /* geen opslag */ }
    if (declined) return false;
    const existing = await RF.api(`/api/passkeys/${KIND[role]}`);
    if (existing.length) return false;
  } catch { return false; }
  $('#login-form').classList.add('hidden');
  ['#faceid-login', '#faceid-or', '#faceid-error', '#demo', '#already'].forEach((sel) => { const el = $(sel); if (el) el.hidden = true; el && el.classList.add('hidden'); });
  document.querySelector('.role-picker').classList.add('hidden');
  document.querySelector('.login-q').classList.add('hidden');
  const box = $('#faceid-offer');
  box.innerHTML = `<div class="faceid-icon">${RF.icon('scan-face')}</div>
    <h2>Voortaan inloggen met ${RF.esc(faceLabel)}?</h2>
    <p class="muted small">Sneller en veiliger: geen wachtwoord meer typen. Je gezicht of vingerafdruk blijft op je toestel.</p>
    <button type="button" class="btn btn-primary btn-lg btn-block" id="faceid-yes">${RF.icon('scan-face')}<span>${RF.esc(faceLabel)} instellen</span></button>
    <button type="button" class="btn btn-quiet btn-block" id="faceid-no" style="margin-top:8px">Niet nu</button>
    <p class="form-error" hidden style="margin-top:10px"></p>`;
  box.classList.remove('hidden');
  $('#faceid-no').onclick = () => { try { localStorage.setItem(`rf_faceid_later_${role}`, '1'); } catch { /* geen opslag */ } goHome(); };
  $('#faceid-yes').onclick = async () => {
    const b = $('#faceid-yes'); b.disabled = true;
    try { await P.register(KIND[role]); RF.toast(`${faceLabel} is ingesteld`); setTimeout(goHome, 600); }
    catch (ex) { const e = box.querySelector('.form-error'); e.textContent = ex.message; e.hidden = false; b.disabled = false; }
  };
  return true;
}

if (P.supported()) {
  const fb = $('#faceid-login');
  fb.innerHTML = `${RF.icon('scan-face')}<span>Inloggen met ${RF.esc(faceLabel)}</span>`;
  fb.classList.remove('hidden');
  $('#faceid-or').classList.remove('hidden');
  fb.onclick = async () => {
    const err = $('#faceid-error'); err.hidden = true; fb.disabled = true;
    try {
      const r = await P.login();
      const r2 = Object.keys(KIND).find((k) => KIND[k] === r.kind && (r.kind !== 'staff' || k === (role === 'veldwerker' ? 'veldwerker' : 'medewerker')));
      if (r2) store.set(r2);
      location.replace(back && back.startsWith(r.home) ? back : r.home);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; fb.disabled = false; }
  };
}

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = form.querySelector('.form-error');
  err.hidden = true;
  try {
    await RF.api('/api/donor/register', { method: 'POST', body: RF.formData(form) });
    store.set('donateur');
    location.replace('/portal');
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

if ($('#to-register')) $('#to-register').onclick = (e) => { e.preventDefault(); showRegister(true); };
$('#to-login').onclick = (e) => { e.preventDefault(); showRegister(false); };

document.querySelectorAll('[data-ic]').forEach((el) => { el.innerHTML = RF.icon(el.dataset.ic); });

// Melding als je automatisch bent uitgelogd.
try {
  if (sessionStorage.getItem('rf_session_expired')) {
    sessionStorage.removeItem('rf_session_expired');
    const n = document.createElement('div');
    n.className = 'already';
    n.style.background = 'var(--warn-soft)'; n.style.color = 'var(--warn)';
    n.textContent = 'Je bent uitgelogd (bijvoorbeeld na een update van de app). Log opnieuw in; je komt daarna terug waar je was.';
    document.querySelector('#already').before(n);
  }
} catch { /* geen opslag */ }

// Demo-inloggegevens alleen tonen zolang er demodata in de CRM staat.
let demoMode = false;
RF.api('/api/public/config').then((c) => { demoMode = !!c.demo; $('#demo').hidden = !demoMode; }).catch(() => {});

// Startrol: ?rol=… > laatst gebruikte rol > sponsor
setRole(params.get('rol') || store.get() || 'donateur');
if (params.get('registreren') === '1' && role === 'donateur') showRegister(true);


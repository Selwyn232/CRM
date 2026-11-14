// Eén inlogpagina voor donateurs, ontvangers en medewerkers.
'use strict';

const $ = (s) => document.querySelector(s);
const ROLES = {
  donateur: {
    login: '/api/donor/login', me: '/api/donor/me', home: '/portal',
    idLabel: 'E-mailadres', idType: 'email', idField: 'email',
    demo: 'Demo: <b>sanne@example.nl</b> / <b>welkom123</b>',
  },
  ontvanger: {
    login: '/api/recipient/login', me: '/api/recipient/me', home: '/ontvanger',
    idLabel: 'Gebruikersnaam', idType: 'text', idField: 'username',
    demo: 'Demo: <b>grace</b> (kind) of <b>esperanza</b> (school) / <b>welkom123</b>',
  },
  medewerker: {
    login: '/api/staff/login', me: '/api/staff/me', home: '/admin',
    idLabel: 'E-mailadres', idType: 'email', idField: 'email',
    demo: 'Demo: <b>admin@robinfoundation.org</b> / <b>admin123</b>',
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
    goHome();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
  }
});

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

$('#to-register').onclick = (e) => { e.preventDefault(); showRegister(true); };
$('#to-login').onclick = (e) => { e.preventDefault(); showRegister(false); };

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

// Startrol: ?rol=… > laatst gebruikte rol > donateur
setRole(params.get('rol') || store.get() || 'donateur');
if (params.get('registreren') === '1' && role === 'donateur') showRegister(true);


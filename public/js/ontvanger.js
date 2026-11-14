// Ontvangersportaal: chatten met de donateurs die jou hebben gesteund.
'use strict';

const { api, esc, date, dateTime, toast, modal } = RF;
const $ = (s, r = document) => r.querySelector(s);
let me = null;

async function boot() {
  try { me = await api('/api/recipient/me'); showApp(); } catch { showAuth(); }
}

function showAuth() {
  location.replace('/login?rol=ontvanger');
}

function showApp() {
  $('#app').classList.remove('hidden');
  RF.impersonationBanner(me, '/api/recipient/logout');
  $('#who').textContent = me.name + (me.managed_by ? ` · begeleid door ${me.managed_by}` : '');
  $('#logout').onclick = async () => { await api('/api/recipient/logout', { method: 'POST', body: {} }); location.replace('/login?rol=ontvanger'); };
  $('#pw-btn').onclick = () => modal({
    title: 'Wachtwoord wijzigen',
    body: `<div class="field"><label>Huidig wachtwoord</label><input type="password" name="current" required></div>
      <div class="field"><label>Nieuw wachtwoord (min. 8 tekens)</label><input type="password" name="password" minlength="8" required></div>`,
    onSubmit: async (f) => { await api('/api/recipient/password', { method: 'POST', body: f }); toast('Wachtwoord gewijzigd'); },
  });
  render();
}

async function render(openId) {
  const view = $('#view');
  if (!me.chat_enabled) {
    view.innerHTML = '<div class="card"><p>Chatten staat voor jouw account (nog) uit. Vraag Robin Foundation om het aan te zetten.</p></div>';
    return;
  }
  const people = await api('/api/recipient/supporters');
  const selected = openId ? Number(openId) : null;
  view.innerHTML = `
    <section class="hero">
      <h1>Hoi ${esc(me.name)}! 👋</h1>
      <p>Hier zie je de mensen die jou hebben geholpen. Stuur ze een berichtje om te vertellen hoe het met je gaat!</p>
    </section>
    <div class="chat-layout ${selected ? 'has-open' : ''}">
      <div class="card chat-list">
        <h3 style="margin:6px 10px 8px">Mijn helpers (${people.length})</h3>
        ${people.map((p) => `<button data-id="${p.id}" class="${p.id === selected ? 'active' : ''}">
          <div class="avatar">${p.anonymous ? '🕶️' : esc(p.name.slice(0, 1).toUpperCase())}</div>
          <div style="min-width:0"><div class="who">${esc(p.name)}</div>
          <div class="last">${esc(p.last_message || `Hielp met: ${p.categories}`)}</div></div>
          ${p.unread ? `<span class="pill">${p.unread}</span>` : ''}</button>`).join('')
          || '<p class="muted" style="padding:10px">Er zijn nog geen helpers aan jou gekoppeld.</p>'}
      </div>
      <div class="card" id="thread">${selected ? '' : '<p class="muted">Kies iemand om mee te chatten.</p>'}</div>
    </div>`;
  view.querySelectorAll('.chat-list button[data-id]').forEach((b) => b.addEventListener('click', () => render(b.dataset.id)));
  if (!selected) return;
  const p = people.find((x) => x.id === selected);
  if (!p) return;
  const thread = $('#thread');
  thread.innerHTML = `<div class="card-head"><div><h2 style="margin:0">${esc(p.name)}</h2>
      <div class="small muted">Helpt je sinds ${date(p.since)} met: ${esc(p.categories)}</div></div>
      <button class="btn btn-ghost btn-sm" id="back">← Terug</button></div><div id="box"></div>`;
  $('#back').onclick = () => render();
  await RF.chatBox($('#box'), {
    otherName: p.name,
    notice: me.chat_moderated
      ? '🛡️ Een begeleider van Robin Foundation leest berichten eerst even mee. Deel nooit je adres, telefoonnummer of social media.'
      : '🛡️ Deel geen adres, telefoonnummer of social media. Zulke berichten worden eerst gecontroleerd.',
    load: () => api(`/api/recipient/supporters/${p.id}`),
    setLanguage: async (language) => { await api('/api/recipient/language', { method: 'PUT', body: { language } }); me.language = language; },
    send: (body) => api(`/api/recipient/supporters/${p.id}`, { method: 'POST', body: { body } }),
  });
}

boot();

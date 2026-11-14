// Beheeromgeving Robin Foundation CRM
'use strict';

const { api, esc, euro, euro0, num, date, dateTime, today, toCents, centsToInput, label, badge, toast, modal, confirmDialog } = RF;
const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

const state = { user: null, categories: [], users: [], campaigns: [], recipients: [] };

// ======================================================================= boot
async function boot() {
  try {
    state.user = await api('/api/staff/me');
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  location.replace(`/login?rol=medewerker&terug=${encodeURIComponent(location.pathname + location.hash)}`);
}

// Navigatie: één bron voor sidebar, command palette en paginatitels.
const NAV = [
  { items: [{ route: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' }] },
  { group: 'Sponsoring', items: [
    { route: 'kinderen', label: 'Kinderen', icon: 'smile' },
    { route: 'sponsorschappen', label: 'Sponsorschappen', icon: 'heart-handshake' },
    { route: 'updates', label: 'Maandupdates', icon: 'image' },
    { route: 'ontvangers', label: 'Gezinnen', icon: 'house' },
    { route: 'chat', label: 'Chatmoderatie', icon: 'messages-square', count: 'chat', attn: true },
  ] },
  { group: 'Donateurs', items: [
    { route: 'donateurs', label: 'Donateurs', icon: 'users' },
    { route: 'donaties', label: 'Betalingen', icon: 'banknote' },
    { route: 'leaderboard', label: 'Leaderboard', icon: 'trophy' },
  ] },
  { group: 'Noodfonds', items: [
    { route: 'cellen', label: 'Noodfonds', icon: 'cloud-lightning', count: 'cells' },
    { route: 'bestedingen', label: 'Bestedingen', icon: 'hand-coins' },
  ] },
  { group: 'Werk', items: [
    { route: 'taken', label: 'Taken', icon: 'list-checks', count: 'tasks' },
    { route: 'rapportages', label: 'Rapportages', icon: 'chart-column' },
    { route: 'emails', label: 'E-mail log', icon: 'mail' },
    { route: 'instellingen', label: 'Instellingen', icon: 'settings' },
  ] },
];
const NAV_ITEMS = NAV.flatMap((g) => g.items);

// Eigen menuvolgorde toepassen. Onbekende routes vallen weg; nieuwe pagina's komen in hun standaardgroep.
function navGroups() {
  const prefs = state.user && state.user.nav;
  const byRoute = Object.fromEntries(NAV_ITEMS.map((it) => [it.route, it]));
  if (!Array.isArray(prefs)) return NAV.map((g) => ({ group: g.group || '', items: g.items }));
  const used = new Set();
  const groups = prefs.map((g) => ({ group: g.group || '', items: g.items.filter((r) => byRoute[r] && !used.has(r) && used.add(r)).map((r) => byRoute[r]) }));
  for (const g of NAV) {
    for (const it of g.items) {
      if (used.has(it.route)) continue;
      let target = groups.find((x) => x.group === (g.group || ''));
      if (!target) { target = { group: g.group || '', items: [] }; groups.push(target); }
      target.items.push(it);
    }
  }
  return groups;
}

let navEditing = false;
function renderNav() {
  const groups = navGroups();
  const current = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
  $('#nav').classList.toggle('editing', navEditing);
  $('#nav').innerHTML = `${navEditing ? `<div class="nav-edit-bar"><span>${RF.icon('arrow-down-up', 'icon-sm')} Sleep om te ordenen</span>
      <button type="button" class="btn btn-quiet btn-sm" id="nav-reset">Standaard</button><button type="button" class="btn btn-primary btn-sm" id="nav-done">Klaar</button></div>` : ''}
    ${groups.map((g, gi) => `<div class="nav-section" data-group="${esc(g.group)}">
      ${g.group ? `<div class="nav-group">${esc(g.group)}</div>` : ''}
      ${g.items.map((it) => `<a href="#/${it.route}" data-route="${it.route}" class="${it.route === current ? 'active' : ''}" ${navEditing ? 'draggable="false"' : ''}>
        ${navEditing ? `<span class="grip" aria-hidden="true">${RF.icon('ellipsis')}</span>` : ''}${RF.icon(it.icon)}<span>${esc(it.label)}</span>
        ${navEditing ? `<span class="nav-move"><button type="button" class="icon-btn" data-move="-1" aria-label="${esc(it.label)} omhoog">${RF.icon('chevron-down', 'icon-sm')}</button><button type="button" class="icon-btn" data-move="1" aria-label="${esc(it.label)} omlaag">${RF.icon('chevron-down', 'icon-sm')}</button></span>`
          : it.count ? `<span class="count ${it.attn ? 'attn' : ''}" id="nav-${it.count}"></span>` : ''}</a>`).join('')}
      ${navEditing && !g.items.length ? '<div class="nav-empty">Sleep hier een item heen</div>' : ''}
    </div>`).join('')}`;
  if (navEditing) bindNavEditing(); else refreshNavCounts();
}

function navFromDom() {
  return [...$('#nav').querySelectorAll('.nav-section')].map((sec) => ({
    group: sec.dataset.group, items: [...sec.querySelectorAll('a[data-route]')].map((a) => a.dataset.route),
  }));
}
async function saveNav(nav) {
  try {
    const r = await api('/api/staff/preferences/nav', { method: 'PUT', body: { nav } });
    state.user.nav = r.nav;
  } catch (e) { toast(e.message, 'error'); }
}

function bindNavEditing() {
  const nav = $('#nav');
  $('#nav-done').onclick = () => { navEditing = false; renderNav(); toast('Menu opgeslagen'); };
  $('#nav-reset').onclick = async () => { await saveNav(null); renderNav(); toast('Standaardvolgorde hersteld'); };
  // Klikken in bewerkstand navigeert niet
  nav.querySelectorAll('a[data-route]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
  // Pijltjes (toetsenbord/toegankelijkheid)
  nav.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const items = [...nav.querySelectorAll('a[data-route]')];
    const el = b.closest('a'); const i = items.indexOf(el); const dir = Number(b.dataset.move);
    const other = items[i + dir];
    if (!other) return;
    if (dir < 0) other.before(el); else other.after(el);
    saveNav(navFromDom()).then(() => { const route = el.dataset.route; renderNav(); const f = nav.querySelector(`a[data-route="${route}"] [data-move="${dir}"]`); if (f) f.focus(); });
  }));
  // Slepen met muis en vinger (Pointer Events; werkt ook op de iPad)
  nav.querySelectorAll('a[data-route]').forEach((item) => {
    item.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-move]') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      const startY = e.clientY;
      const rect = item.getBoundingClientRect();
      let dragging = false;
      let ghost = null;
      const begin = () => {
        dragging = true;
        ghost = item.cloneNode(true);
        ghost.classList.add('nav-ghost');
        Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
        document.body.appendChild(ghost);
        item.classList.add('nav-placeholder');
        document.body.classList.add('nav-dragging');
      };
      const move = (ev) => {
        if (!dragging) { if (Math.abs(ev.clientY - startY) < 4) return; begin(); }
        ghost.style.top = `${rect.top + (ev.clientY - startY)}px`;
        // Doel bepalen: het item of de groep onder de vinger/muis
        ghost.style.pointerEvents = 'none';
        const under = document.elementFromPoint(rect.left + rect.width / 2, ev.clientY);
        const target = under && under.closest('#nav a[data-route]');
        if (target && target !== item) {
          const r = target.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) target.before(item); else target.after(item);
        } else if (under) {
          const sec = under.closest('#nav .nav-section');
          if (sec && !sec.contains(item)) {
            const empty = sec.querySelector('.nav-empty'); if (empty) empty.remove();
            sec.appendChild(item);
          }
        }
        // Automatisch scrollen in een lange zijbalk
        const sb = $('#sidebar').getBoundingClientRect();
        if (ev.clientY < sb.top + 40) $('#sidebar').scrollTop -= 8; else if (ev.clientY > sb.bottom - 40) $('#sidebar').scrollTop += 8;
      };
      const end = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        if (!dragging) return;
        ghost.remove();
        item.classList.remove('nav-placeholder');
        document.body.classList.remove('nav-dragging');
        saveNav(navFromDom()).then(renderNav);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });
  });
}

function editNav() {
  navEditing = true;
  if (matchMedia('(max-width: 900px)').matches) { $('#sidebar').classList.add('open'); $('#nav-backdrop').classList.add('open'); }
  renderNav();
}

async function showApp() {
  RF.markLoggedIn();
  $('#app').classList.remove('hidden');
  renderNav();
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $('#cmdk-kbd').textContent = isMac ? '⌘K' : 'Ctrl K';
  $('#cmdk-icon').innerHTML = RF.icon('search');
  $('#menu-toggle').innerHTML = RF.icon('menu', 'icon-lg');
  $('#m-search').innerHTML = RF.icon('search', 'icon-lg');
  $('#me').innerHTML = `${RF.avatar(state.user.name, 'sm')}<span class="who"><b>${esc(state.user.name)}</b><span>${state.user.role === 'admin' ? 'Beheerder' : 'Medewerker'}</span></span>${RF.icon('chevron-down', 'icon-sm')}`;
  $('#me').onclick = (e) => RF.menu(e.currentTarget, [
    { heading: state.user.email },
    { label: 'Publiek leaderboard', icon: 'globe', href: '/leaderboard', external: true },
    { label: 'Donateursportaal', icon: 'heart', href: '/portal', external: true },
    { label: 'Ontvangersportaal', icon: 'heart-handshake', href: '/ontvanger', external: true },
    '-',
    { label: 'Menu aanpassen', icon: 'arrow-down-up', onClick: editNav },
    { label: 'Wachtwoord wijzigen', icon: 'lock', onClick: changeOwnPassword },
    { label: 'Uitloggen', icon: 'log-out', onClick: async () => { await api('/api/staff/logout', { method: 'POST', body: {} }); location.replace('/login?rol=medewerker'); } },
  ], { align: 'start' });
  const setMenu = (open) => { $('#sidebar').classList.toggle('open', open); $('#nav-backdrop').classList.toggle('open', open); };
  $('#menu-toggle').onclick = () => setMenu(!$('#sidebar').classList.contains('open'));
  $('#nav-backdrop').onclick = () => setMenu(false);
  $('#open-cmdk').onclick = openCommandPalette;
  $('#m-search').onclick = openCommandPalette;
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandPalette(); }
  });
  await loadLookups();
  window.addEventListener('hashchange', route);
  if (state.user.weak_password) showWeakPasswordBanner();
  route();
}

async function loadLookups() {
  let tr;
  [state.categories, state.users, state.campaigns, state.recipients, tr] = await Promise.all([
    api('/api/admin/categories'), api('/api/admin/users'), api('/api/admin/campaigns'), api('/api/admin/recipients'),
    api('/api/public/translation'),
  ]);
  state.languages = tr.languages;
  refreshNavCounts();
}

async function refreshNavCounts() {
  try {
    const d = await api('/api/admin/dashboard');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || ''; };
    set('nav-cells', d.totals.open_cells); set('nav-tasks', d.totals.open_tasks); set('nav-chat', d.totals.pending_chats);
  } catch { /* stil */ }
}

const catByKey = (k) => state.categories.find((c) => c.key === k) || { name: k, icon: '' };
const isAdmin = () => state.user && state.user.role === 'admin';

const ROUTES = {
  dashboard: renderDashboard,
  donateurs: (id) => (id ? renderDonor(id) : renderDonors()),
  donaties: renderDonations,
  cellen: renderCells,
  bestedingen: (id) => (id ? renderExpenditure(id) : renderExpenditures()),
  ontvangers: renderRecipients,
  chat: renderChatModeration,
  taken: renderTasks,
  campagnes: renderCampaigns,
  leaderboard: renderLeaderboard,
  rapportages: renderReports,
  emails: renderOutbox,
  instellingen: renderSettings,
};

async function route() {
  const [name, param] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const fn = ROUTES[name] || ROUTES.dashboard;
  document.querySelectorAll('#nav a[data-route]').forEach((a) => {
    const on = a.dataset.route === (ROUTES[name] ? name : 'dashboard');
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const item = NAV_ITEMS.find((i) => i.route === name);
  document.title = `${item ? item.label : 'Dashboard'} · Robin Foundation CRM`;
  $('#sidebar').classList.remove('open');
  $('#nav-backdrop').classList.remove('open');
  view().innerHTML = RF.skeleton();
  try {
    await fn(param);
  } catch (err) {
    if (err.status === 401) return showLogin();
    view().innerHTML = `<div class="card">${RF.emptyState({ icon: 'circle-alert', title: 'Er ging iets mis', text: esc(err.message),
      action: '<button class="btn btn-ghost btn-sm" onclick="route()">Opnieuw proberen</button>' })}</div>`;
  }
  window.scrollTo(0, 0);
}

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ------------------------------------------------------------------ eigen wachtwoord
function changeOwnPassword() {
  modal({
    title: 'Wachtwoord wijzigen', submitLabel: 'Wachtwoord opslaan',
    body: `<div class="field"><label>Huidig wachtwoord</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div class="field"><label>Nieuw wachtwoord</label><input type="password" name="password" required minlength="10" autocomplete="new-password">
        <div class="hint">Minimaal 10 tekens. Een korte zin van een paar woorden is sterk en goed te onthouden.</div></div>`,
    onSubmit: async (f) => {
      await api('/api/staff/password', { method: 'POST', body: f });
      state.user.weak_password = false;
      const b = document.getElementById('weak-banner'); if (b) b.remove();
      toast('Wachtwoord gewijzigd. Andere sessies zijn afgemeld.');
    },
  });
}
function showWeakPasswordBanner() {
  if (document.getElementById('weak-banner')) return;
  const el = document.createElement('div');
  el.id = 'weak-banner';
  el.className = 'callout warn';
  el.style.cssText = 'margin:0 0 18px;align-items:center';
  el.innerHTML = `${RF.icon('shield-alert')}<span style="flex:1">Je gebruikt een demo- of zwak wachtwoord. Iedereen die dat kent kan als beheerder inloggen.</span>
    <button class="btn btn-sm btn-ghost" type="button">Nu wijzigen</button>`;
  el.querySelector('button').onclick = changeOwnPassword;
  document.querySelector('.main').insertBefore(el, document.getElementById('view'));
}

// ------------------------------------------------------------------ command palette (⌘K)
function openCommandPalette() {
  if (document.querySelector('.cmdk-backdrop')) return;
  const wrap = document.createElement('div');
  wrap.className = 'cmdk-backdrop';
  wrap.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true" aria-label="Zoeken">
    <div class="cmdk-input">${RF.icon('search')}<input type="text" placeholder="Zoek een donateur, of typ een pagina of actie…" aria-label="Zoeken" autocomplete="off"><kbd>esc</kbd></div>
    <div class="cmdk-list" role="listbox"></div>
    <div class="cmdk-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigeren</span><span><kbd>↵</kbd> openen</span><span><kbd>esc</kbd> sluiten</span></div></div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector('input');
  const list = wrap.querySelector('.cmdk-list');
  const actions = [
    { label: 'Nieuwe donateur', icon: 'user-plus', run: () => donorForm({}, (d) => go(`#/donateurs/${d.id}`)) },
    { label: 'Donatie registreren', icon: 'plus', run: () => donationForm({}, () => route()) },
    { label: 'Geld besteden', icon: 'hand-coins', run: () => spendForm({}, (r) => go(`#/bestedingen/${r.id}`)) },
    { label: 'Nieuwe taak', icon: 'list-checks', run: () => taskForm({}, () => route()) },
    { label: 'Menu aanpassen', icon: 'arrow-down-up', run: editNav },
  ];
  let items = [];
  let active = 0;
  let donors = [];
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const pages = NAV_ITEMS.filter((p) => !q || p.label.toLowerCase().includes(q))
      .map((p) => ({ group: 'Pagina’s', label: p.label, icon: p.icon, run: () => go(`#/${p.route}`) }));
    const acts = actions.filter((a) => !q || a.label.toLowerCase().includes(q)).map((a) => ({ group: 'Acties', ...a }));
    const people = donors.map((d) => ({ group: 'Donateurs', label: d.full_name, sub: d.email || d.city || '', avatar: d.full_name, run: () => go(`#/donateurs/${d.id}`) }));
    items = [...people, ...acts, ...pages];
    active = Math.min(active, Math.max(0, items.length - 1));
    let last = '';
    list.innerHTML = items.length ? items.map((it, i) => {
      const head = it.group !== last ? `<div class="cmdk-group">${esc(it.group)}</div>` : '';
      last = it.group;
      return `${head}<div class="cmdk-item ${i === active ? 'active' : ''}" role="option" data-i="${i}" aria-selected="${i === active}">
        ${it.avatar ? RF.avatar(it.avatar, 'sm') : RF.icon(it.icon)}<span>${esc(it.label)}</span>${it.sub ? `<span class="hint-right">${esc(it.sub)}</span>` : ''}</div>`;
    }).join('') : `<div class="cmdk-empty">Niets gevonden voor “${esc(input.value)}”</div>`;
    const el = list.querySelector('.cmdk-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const search = RF.debounce(async () => {
    const q = input.value.trim();
    donors = q.length >= 2 ? (await api(`/api/admin/donors?q=${encodeURIComponent(q)}`).catch(() => [])).slice(0, 6) : [];
    draw();
  }, 150);
  const runActive = () => { const it = items[active]; if (it) { close(); it.run(); } };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
  };
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => { active = 0; draw(); search(); });
  list.addEventListener('mousemove', (e) => { const el = e.target.closest('[data-i]'); if (el && Number(el.dataset.i) !== active) { active = Number(el.dataset.i); draw(); } });
  list.addEventListener('click', (e) => { const el = e.target.closest('[data-i]'); if (el) { active = Number(el.dataset.i); runActive(); } });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  draw();
  input.focus();
}

// Paginakop: titel, ondertitel, acties
const pageHead = (title, { sub = '', actions = '', crumbs = '' } = {}) => `<div class="page-head"><div>
  ${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
  ${actions ? `<div class="toolbar">${actions}</div>` : ''}</div>`;
const btn = (id, text, { icon: ic, kind = 'ghost', size = '' } = {}) =>
  `<button class="btn btn-${kind} ${size ? `btn-${size}` : ''}" id="${id}">${ic ? RF.icon(ic) : ''}${text ? `<span>${text}</span>` : ''}</button>`;
const searchInput = (id, placeholder, value = '') => `<span class="input-icon">${RF.icon('search')}<input type="search" id="${id}" placeholder="${esc(placeholder)}" value="${esc(value)}"></span>`;

// ------------------------------------------------------------------ helpers
const opt = (value, text, selected) => `<option value="${esc(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${esc(text)}</option>`;
const catOptions = (sel, withAll = false) => (withAll ? opt('', 'Alle bestemmingen', sel) : '') +
  state.categories.map((c) => opt(c.key, c.name, sel)).join('');
const labelOptions = (group, sel, withAll) => (withAll ? opt('', withAll, sel) : '') +
  Object.entries(RF.LABELS[group]).map(([k, v]) => opt(k, v, sel)).join('');
const userOptions = (sel) => opt('', '— niemand —', sel) + state.users.filter((u) => u.active).map((u) => opt(u.id, u.name, sel)).join('');
const recipientOptions = (sel) => opt('', '— geen specifieke ontvanger —', sel) +
  state.recipients.filter((r) => r.active).map((r) => opt(r.id, `${r.name} (${label('recipient', r.kind)}${r.country ? `, ${r.country}` : ''})`, sel)).join('');
const campaignOptions = (sel) => opt('', '— geen campagne —', sel) + state.campaigns.map((c) => opt(c.id, c.name, sel)).join('');
const langOptions = (sel) => Object.entries(state.languages || {}).map(([k, v]) => opt(k, v, sel)).join('');
const tags = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
const donorLink = (id, name) => `<a href="#/donateurs/${id}">${esc(name)}</a>`;

function table(columns, rows, { empty = 'Geen gegevens', emptyIcon = 'inbox', onRow } = {}) {
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}" ${c.width ? `style="width:${c.width}"` : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((r, i) => `<tr data-i="${i}" class="${onRow ? 'clickable' : ''}">${columns.map((c) =>
      `<td class="${c.num ? 'num' : ''}" data-label="${esc(c.label)}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" class="empty" style="padding:0!important">${RF.emptyState({ icon: emptyIcon, title: empty })}</td></tr>`;
  return `<div class="table-wrap cards"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function bindRows(root, rows, onRow) {
  root.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input')) onRow(rows[Number(tr.dataset.i)]); });
  });
}

// ======================================================================= DASHBOARD
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond'; };
const firstName = (n) => String(n || '').split(' ')[0];
const ago = (days) => (days <= 0 ? 'vandaag' : days === 1 ? '1 dag' : `${days} dagen`);

async function renderDashboard() {
  const d = await api('/api/admin/dashboard');
  const t = d.totals;
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  const byMonth = Object.fromEntries(d.monthly.map((r) => [r.month, r.cents]));
  const spentByMonth = Object.fromEntries(d.monthlySpent.map((r) => [r.month, r.cents]));
  const thisM = byMonth[months[11]] || 0;
  const lastM = byMonth[months[10]] || 0;
  const delta = lastM ? Math.round(((thisM - lastM) / lastM) * 100) : null;
  const spentShare = t.raised_cents ? Math.round((t.spent_cents / t.raised_cents) * 100) : 0;
  const todayLabel = now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

  view().innerHTML = `
    ${pageHead(`${greeting()}, ${esc(firstName(state.user.name))}`, {
      sub: `${todayLabel.charAt(0).toUpperCase() + todayLabel.slice(1)} · zo staat Robin Foundation ervoor`,
      actions: btn('q-donation', 'Donatie', { icon: 'plus' }) + btn('q-spend', 'Geld besteden', { icon: 'hand-coins', kind: 'primary' }),
    })}
    <div class="kpis">
      <div class="kpi"><div class="label">${RF.icon('banknote')}Totaal opgehaald</div><div class="value">${euro0(t.raised_cents)}</div>
        <div class="sub">${euro0(t.raised_ytd_cents)} dit jaar</div></div>
      <div class="kpi"><div class="label">${RF.icon('piggy-bank')}In cellen</div><div class="value">${euro0(t.waiting_cents)}</div>
        <div class="sub">${num(t.open_cells)} open cellen wachten op besteding</div></div>
      <div class="kpi"><div class="label">${RF.icon('hand-coins')}Besteed</div><div class="value">${euro0(t.spent_cents)}</div>
        <div class="sub">${spentShare}% van alle giften</div></div>
      <div class="kpi"><div class="label">${RF.icon('users')}Donateurs</div><div class="value">${num(t.donors)}</div>
        <div class="sub">${t.active_donors} actief · ${t.recurring_donors} terugkerend</div></div>
    </div>

    <div class="grid grid-2-1" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div><h2>Inkomsten en bestedingen</h2>
          <div class="small muted">Laatste 12 maanden · deze maand ${euro0(thisM)}${delta != null ? ` <span style="font-weight:500;color:var(--${delta >= 0 ? 'ok' : 'bad'})">${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}% t.o.v. vorige maand</span>` : ''}</div></div>
          <div class="legend"><span><i style="background:var(--accent)"></i>Ontvangen</span><span><i style="background:var(--accent-muted)"></i>Besteed</span></div></div>
        ${RF.barChart(months.map((m) => RF.monthName(m.slice(5))), [
          { label: 'Ontvangen', values: months.map((m) => byMonth[m] || 0), color: 'var(--accent)' },
          { label: 'Besteed', values: months.map((m) => spentByMonth[m] || 0), color: 'var(--accent-muted)' },
        ], { legend: false })}
      </div>
      <div class="card">
        <div class="card-head"><h2>Aandacht nodig</h2></div>
        <div class="list">
          ${attentionRow('#/cellen', 'piggy-bank', `${num(t.open_cells)} open cellen`, `${euro0(t.waiting_cents)} wacht op besteding`)}
          ${attentionRow('#/bestedingen', 'mail-open', `${t.expenditures_without_message} ${t.expenditures_without_message === 1 ? 'besteding' : 'bestedingen'} zonder bericht`, 'Koppel een brief, foto of filmpje', t.expenditures_without_message)}
          ${attentionRow('#/chat', 'messages-square', `${t.pending_chats} ${t.pending_chats === 1 ? 'chatbericht' : 'chatberichten'}`, 'Wachten op controle', t.pending_chats)}
          ${attentionRow('#/taken', 'list-checks', `${t.open_tasks} open ${t.open_tasks === 1 ? 'taak' : 'taken'}`, t.overdue_tasks ? `${t.overdue_tasks} te laat` : 'Niets te laat', t.overdue_tasks)}
          ${attentionRow('#/donaties', 'clock', `${euro0(t.pending_cents)} in afwachting`, 'Donaties die nog niet binnen zijn', t.pending_cents)}
        </div>
      </div>
    </div>

    <div class="card flush" style="margin-top:16px">
      <div class="card-head"><h2>Saldo per bestemming</h2><a href="#/cellen">Alle cellen ${RF.icon('arrow-right', 'icon-sm')}</a></div>
      ${table([
        { label: 'Bestemming', render: (c) => `<span class="cat-name">${RF.catIcon(c)}<span><b style="font-weight:500">${esc(c.name)}</b><span class="sub">${c.unit_cost_cents ? `${euro(c.unit_cost_cents)} per ${esc(c.unit_label)}` : 'Vrij bedrag'}</span></span></span>` },
        { label: 'Verdeling', width: '28%', render: (c) => `<div style="min-width:120px">${RF.splitBar(c.spent_cents, c.waiting_cents)}</div>` },
        { label: 'Impact', render: (c) => `<span class="muted">${c.unit_cost_cents ? `${num(c.units_spent)} ${esc(c.unit_label_plural)}` : `${euro0(c.spent_cents)} noodhulp`}</span>` },
        { label: 'Besteed', num: true, render: (c) => euro0(c.spent_cents) },
        { label: 'In cel', num: true, render: (c) => `<b style="font-weight:600">${euro0(c.waiting_cents)}</b>` },
      ], d.categories)}
    </div>

    <div class="grid grid-3" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Recente donaties</h2><a href="#/donaties">Alles</a></div>
        <div class="list">${d.recent.slice(0, 6).map((r) => `<a class="list-row" href="#/donateurs/${r.donor_id}">${RF.catIcon(r, 'sm')}
          <div class="grow"><div class="title">${esc(r.donor_name)}</div><div class="meta">${esc(r.category_name)} · ${date(r.received_at)}</div></div>
          <div class="end">${euro(r.amount_cents)}</div></a>`).join('') || RF.emptyState({ icon: 'banknote', title: 'Nog geen donaties' })}</div></div>
      <div class="card"><div class="card-head"><h2>Langst wachtende cellen</h2><a href="#/cellen">Alles</a></div>
        <div class="list">${d.oldestCells.map((r) => `<a class="list-row" href="#/donateurs/${r.donor_id}">${RF.catIcon(r, 'sm')}
          <div class="grow"><div class="title">${esc(r.donor_name)}</div><div class="meta">${esc(r.category_name)} · wacht ${ago(r.age_days)}</div></div>
          <div class="end">${euro(r.remaining_cents)}</div></a>`).join('') || RF.emptyState({ icon: 'check-check', title: 'Alles is besteed' })}</div></div>
      <div class="card"><div class="card-head"><h2>Open taken</h2><a href="#/taken">Alles</a></div>
        <div class="list">${d.tasks.slice(0, 6).map((r) => `<a class="list-row" href="${r.donor_id ? `#/donateurs/${r.donor_id}` : '#/taken'}">
          <span style="color:${r.due_date && r.due_date < today() ? 'var(--bad)' : 'var(--text-4)'}">${RF.icon('circle')}</span>
          <div class="grow"><div class="title">${esc(r.title)}</div><div class="meta">${r.donor_name ? `${esc(r.donor_name)} · ` : ''}${r.due_date ? date(r.due_date) : 'Geen deadline'}</div></div>
          ${r.priority === 'hoog' ? '<span class="badge badge-hoog">Hoog</span>' : ''}</a>`).join('') || RF.emptyState({ icon: 'check-check', title: 'Geen open taken' })}</div></div>
    </div>`;
  $('#q-donation').onclick = () => donationForm({}, () => renderDashboard());
  $('#q-spend').onclick = () => spendForm({}, () => renderDashboard());
}

function attentionRow(href, ic, title, meta, highlight = true) {
  return `<a class="list-row" href="${href}"><span class="cat-ico sm" style="--c:${highlight ? 'var(--accent)' : 'var(--text-4)'}">${RF.icon(ic)}</span>
    <div class="grow"><div class="title">${title}</div><div class="meta">${meta}</div></div><span class="muted">${RF.icon('chevron-right', 'icon-sm')}</span></a>`;
}

function catTile(c) {
  const units = c.unit_cost_cents ? `${num(c.units_spent)} ${c.unit_label_plural} gefinancierd` : `${euro0(c.spent_cents)} noodhulp verleend`;
  return `<div class="card cat-tile"><div class="top">${RF.catIcon(c, 'lg')}<div><div class="name">${esc(c.name)}</div>
      <div class="small muted">${c.unit_cost_cents ? `${euro(c.unit_cost_cents)} per ${esc(c.unit_label)}` : 'Vrij bedrag'}</div></div></div>
    ${RF.splitBar(c.spent_cents, c.waiting_cents)}
    <div class="nums"><span>Besteed ${euro0(c.spent_cents)}</span><span>In cel ${euro0(c.waiting_cents)}</span></div>
    <div class="small muted">${units}</div></div>`;
}

// ======================================================================= DONATEURS
async function renderDonors() {
  const params = new URLSearchParams(sessionStorage.getItem('donorFilters') || '');
  view().innerHTML = `
    ${pageHead('Donateurs', { sub: 'Iedereen die geeft of wil geven', actions:
      `<a class="btn btn-ghost" href="/api/admin/donors/export">${RF.icon('download')}<span>Exporteren</span></a>` + btn('new-donor', 'Nieuwe donateur', { icon: 'plus', kind: 'primary' }) })}
    <div class="card flush">
      <div class="filters">
        ${searchInput('f-q', 'Zoek op naam, e-mail, plaats of telefoon', params.get('q') || '')}
        <select id="f-status">${labelOptions('donor', params.get('status') || '', 'Alle statussen')}</select>
        <select id="f-type">${labelOptions('type', params.get('type') || '', 'Alle typen')}</select>
        <input type="search" id="f-tag" placeholder="Tag" value="${esc(params.get('tag') || '')}" style="min-width:110px">
        <select id="f-sort" style="margin-left:auto">${opt('name', 'Naam A–Z', params.get('sort'))}${opt('total', 'Hoogste totaal', params.get('sort'))}${opt('recent', 'Laatste gift', params.get('sort'))}${opt('created', 'Nieuwste', params.get('sort'))}</select>
      </div>
      <div id="donor-table">${RF.skeleton('rows')}</div>
    </div>`;
  const load = async () => {
    const p = new URLSearchParams({ q: $('#f-q').value, status: $('#f-status').value, type: $('#f-type').value, tag: $('#f-tag').value, sort: $('#f-sort').value });
    sessionStorage.setItem('donorFilters', p.toString());
    const rows = await api(`/api/admin/donors?${p}`);
    const total = rows.reduce((a, r) => a + r.total_cents, 0);
    $('#donor-table').innerHTML = table([
      { label: 'Naam', render: (r) => `<div class="cell-person">${RF.avatar(r.full_name, 'sm')}<div class="grow"><a href="#/donateurs/${r.id}">${esc(r.full_name)}</a>
          <span class="sub">${esc(r.email || label('type', r.donor_type))}</span></div></div>` },
      { label: 'Status', render: (r) => badge('donor', r.status) },
      { label: 'Plaats', render: (r) => `<span class="muted">${esc(r.city) || '—'}</span>` },
      { label: 'Tags', render: (r) => tags(r.tags) || '<span class="muted">—</span>' },
      { label: 'Kenmerken', render: (r) => [
        r.recurring ? `<span class="tag" title="Terugkerende gever">${RF.icon('repeat', 'icon-sm')}&nbsp;Terugkerend</span>` : '',
        r.has_portal ? `<span class="tag" title="Heeft een portaal-account">${RF.icon('key-round', 'icon-sm')}&nbsp;Portaal</span>` : '',
        r.anonymous ? `<span class="tag" title="Anoniem op het leaderboard">${RF.icon('eye-off', 'icon-sm')}&nbsp;Anoniem</span>` : '',
      ].join('') || '<span class="muted">—</span>' },
      { label: 'Laatste gift', render: (r) => `<span class="muted">${date(r.last_donation) || '—'}</span>` },
      { label: 'In cel', num: true, render: (r) => `<span class="muted">${euro(r.waiting_cents)}</span>` },
      { label: 'Totaal', num: true, render: (r) => `<b style="font-weight:600">${euro(r.total_cents)}</b>` },
    ], rows, { empty: 'Geen donateurs gevonden', emptyIcon: 'users', onRow: true }) +
      `<div class="table-meta"><span>${rows.length} ${rows.length === 1 ? 'donateur' : 'donateurs'}</span><span>Samen ${euro(total)} gedoneerd</span></div>`;
    bindRows($('#donor-table'), rows, (r) => go(`#/donateurs/${r.id}`));
  };
  const deb = RF.debounce(load);
  ['#f-q', '#f-tag'].forEach((x) => $(x).addEventListener('input', deb));
  ['#f-status', '#f-type', '#f-sort'].forEach((x) => $(x).addEventListener('change', load));
  $('#new-donor').onclick = () => donorForm({}, (d) => go(`#/donateurs/${d.id}`));
  await load();
}

const section = (title, body) => `<section class="form-section"><h3>${title}</h3>${body}</section>`;

function donorForm(d, done) {
  const isNew = !d.id;
  const f = (name, labelText, value, attrs = '') => `<div class="field"><label for="df-${name}">${labelText}</label><input type="text" id="df-${name}" name="${name}" value="${esc(value || '')}" ${attrs}></div>`;
  modal({
    title: isNew ? 'Nieuwe donateur' : 'Donateur bewerken', wide: true, submitLabel: isNew ? 'Donateur toevoegen' : 'Opslaan',
    body: `
      ${section('Persoon', `
        <div class="field-row">
          ${f('first_name', 'Voornaam', d.first_name, 'autocomplete="off"')}
          ${f('last_name', 'Achternaam', d.last_name, 'autocomplete="off"')}
        </div>
        <div class="field-row">
          <div class="field"><label>Type</label><select name="donor_type">${labelOptions('type', d.donor_type || 'particulier')}</select></div>
          ${f('company_name', 'Organisatie <span class="muted">(optioneel)</span>', d.company_name)}
        </div>`)}
      ${section('Contact', `
        <div class="field-row">
          <div class="field"><label for="df-email">E-mail</label><input type="email" id="df-email" name="email" value="${esc(d.email || '')}"></div>
          ${f('phone', 'Telefoon', d.phone, 'inputmode="tel"')}
        </div>
        <div class="field-row">
          ${f('street', 'Adres', d.street)}
          <div class="field-row" style="grid-template-columns:1fr 1.4fr">${f('postal_code', 'Postcode', d.postal_code)}${f('city', 'Plaats', d.city)}</div>
        </div>
        <div class="field-row">
          ${f('country', 'Land', d.country || 'Nederland')}
          <div class="field"><label>Voorkeurskanaal</label><select name="preferred_channel">${opt('email', 'E-mail', d.preferred_channel)}${opt('post', 'Post', d.preferred_channel)}${opt('telefoon', 'Telefoon', d.preferred_channel)}${opt('whatsapp', 'WhatsApp', d.preferred_channel)}</select></div>
        </div>`)}
      ${section('Relatie', `
        <div class="field-row">
          <div class="field"><label>Status</label><select name="status">${labelOptions('donor', d.status || 'actief')}</select></div>
          ${f('source', 'Bron', d.source, 'placeholder="website, evenement…"')}
        </div>
        ${f('tags', 'Tags <span class="muted">(komma-gescheiden)</span>', d.tags, 'placeholder="maandgever, major donor"')}
        <div class="field"><label>Notities</label><textarea name="notes" placeholder="Afspraken, wensen, achtergrond…">${esc(d.notes || '')}</textarea></div>`)}
      ${section('Privacy en voorkeuren', `
        <label class="check"><input type="checkbox" name="anonymous" ${d.anonymous ?? 1 ? 'checked' : ''}><span>Anoniem op het leaderboard<span class="hint" style="display:block;margin-top:2px">Standaard aan. Zet alleen uit met toestemming van de donateur.</span></span></label>
        <div class="field-row">
          ${f('display_name', 'Weergavenaam op leaderboard', d.display_name, 'placeholder="bv. Familie Jansen"')}
          <div class="field"><label>Taal (chat)</label><select name="language">${langOptions(d.language || 'nl')}</select></div>
        </div>
        <label class="check" style="margin-bottom:0"><input type="checkbox" name="newsletter" ${d.newsletter ?? 1 ? 'checked' : ''}><span>Ontvangt de nieuwsbrief</span></label>`)}`,
    onSubmit: async (data) => {
      const saved = await api(isNew ? '/api/admin/donors' : `/api/admin/donors/${d.id}`, { method: isNew ? 'POST' : 'PUT', body: data });
      toast('Donateur opgeslagen');
      done(saved);
    },
  });
}

async function renderDonor(donorId) {
  const data = await api(`/api/admin/donors/${donorId}`);
  const d = data.donor;
  const totals = data.impact.reduce((a, r) => ({ donated: a.donated + r.donated_cents, waiting: a.waiting + r.waiting_cents, spent: a.spent + r.spent_cents }), { donated: 0, waiting: 0, spent: 0 });
  const year = new Date().getFullYear();

  const messages = new Set(data.journey.flatMap((j) => j.messages.map((m) => m.id))).size;
  const addr = [d.street, `${d.postal_code || ''} ${d.city || ''}`.trim(), d.country].filter(Boolean).join(', ');
  const prop = (ic, k, v) => `<dt>${RF.icon(ic)}${k}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`;
  const openTasks = data.tasks.filter((t) => t.status !== 'afgerond').length;
  view().innerHTML = `
    <div class="crumbs"><a href="#/donateurs">Donateurs</a>${RF.icon('chevron-right', 'icon-sm')}<span>${esc(d.full_name)}</span></div>
    <div class="page-head" style="align-items:center">
      <div class="profile-head">${RF.avatar(d.full_name, 'lg')}
        <div><h1>${esc(d.full_name)}</h1>
          <div class="profile-meta">${badge('donor', d.status)}<span>${esc(label('type', d.donor_type))}</span>
            <span class="dot-sep">Sinds ${date(d.created_at)}</span>
            ${data.rank ? `<span class="dot-sep">#${data.rank} op leaderboard</span>` : ''}
            <span class="dot-sep" style="display:inline-flex;align-items:center;gap:5px">${d.anonymous ? `${RF.icon('eye-off', 'icon-sm')} Anoniem` : `${RF.icon('globe', 'icon-sm')} Publiek als “${esc(d.public_name)}”`}</span>
            ${tags(d.tags)}</div></div></div>
      <div class="toolbar">
        ${btn('edit', 'Bewerken', { icon: 'pencil' })}
        ${btn('spend-donor', 'Geld besteden', { icon: 'hand-coins' })}
        ${btn('add-donation', 'Donatie', { icon: 'plus', kind: 'primary' })}
        <button class="btn btn-ghost" id="more" aria-label="Meer acties" aria-haspopup="menu" style="padding:0 8px">${RF.icon('ellipsis')}</button>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="label">Totaal gedoneerd</div><div class="value">${euro(totals.donated)}</div><div class="sub">${data.donations.length} ${data.donations.length === 1 ? 'gift' : 'giften'}</div></div>
      <div class="kpi"><div class="label">Besteed</div><div class="value">${euro(totals.spent)}</div><div class="sub">${totals.donated ? Math.round((totals.spent / totals.donated) * 100) : 0}% van het totaal</div></div>
      <div class="kpi"><div class="label">Nog in cellen</div><div class="value">${euro(totals.waiting)}</div><div class="sub">Wacht op besteding</div></div>
      <div class="kpi"><div class="label">Berichten ontvangen</div><div class="value">${messages}</div><div class="sub">Brieven, foto's en filmpjes</div></div>
    </div>
    <div class="grid grid-1-2" style="margin-top:16px">
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Gegevens</h2></div>
          <dl class="props">
            ${prop('at-sign', 'E-mail', d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : '')}
            ${prop('phone', 'Telefoon', d.phone ? `<a href="tel:${esc(d.phone)}">${esc(d.phone)}</a>` : '')}
            ${prop('map-pin', 'Adres', esc(addr))}
            ${prop('building-2', 'Organisatie', esc(d.company_name))}
            ${prop('message-circle', 'Voorkeur', esc(d.preferred_channel))}
            ${prop('languages', 'Taal', esc((state.languages || {})[d.language] || d.language))}
            ${prop('mail', 'Nieuwsbrief', d.newsletter ? 'Ja' : 'Nee')}
            ${prop('sparkles', 'Bron', esc(d.source))}
            ${prop('key-round', 'Portaal', d.has_portal ? `Actief${d.last_login_at ? `<span class="sub muted">Laatst ingelogd ${dateTime(d.last_login_at)}</span>` : ''}` : 'Geen account')}
          </dl>
          ${d.notes ? `<hr><div class="small muted" style="margin-bottom:4px">Notities</div><p style="white-space:pre-line;margin:0">${esc(d.notes)}</p>` : ''}
        </div>
        <div class="card"><div class="card-head"><h2>Impact per bestemming</h2></div>
          ${data.impact.filter((r) => r.donated_cents).map((r) => `<div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">${RF.catLabel(r, r.name)}<b class="num" style="font-weight:600">${euro(r.donated_cents)}</b></div>
            ${RF.splitBar(r.spent_cents, r.waiting_cents)}
            <div class="small muted" style="margin-top:6px">${r.units_funded ? `${esc(RF.unitsText(r, r.units_funded))} gefinancierd · ` : ''}${euro(r.waiting_cents)} in cel</div></div>`).join('')
            || '<p class="muted small" style="margin:0">Nog geen donaties.</p>'}
        </div>
        <div class="card"><div class="card-head"><h2>Taken${openTasks ? ` <span class="tab-count" style="font-size:12px;color:var(--text-3)">${openTasks}</span>` : ''}</h2>${btn('add-task', '', { icon: 'plus', size: 'sm' })}</div>
          ${data.tasks.length ? data.tasks.map((t) => `<label class="check" style="margin-bottom:10px">
            <input type="checkbox" data-task="${t.id}" ${t.status === 'afgerond' ? 'checked' : ''}>
            <span><span style="${t.status === 'afgerond' ? 'text-decoration:line-through;color:var(--text-3)' : ''}">${esc(t.title)}</span>
            <span class="small muted" style="display:block">${t.due_date ? `${date(t.due_date)} · ` : ''}${esc(t.assigned_name || '')}</span></span></label>`).join('')
            : '<p class="muted small" style="margin:0">Geen taken.</p>'}
        </div>
      </div>
      <div class="card">
        <div class="tabs" id="tabs" role="tablist">
          <button data-tab="journey" class="active" role="tab">Geldstroom</button>
          <button data-tab="donations" role="tab">Donaties <span class="tab-count">${data.donations.length}</span></button>
          <button data-tab="interactions" role="tab">Contactmomenten <span class="tab-count">${data.interactions.length}</span></button>
          <button data-tab="emails" role="tab">E-mails <span class="tab-count">${data.emails.length}</span></button>
        </div>
        <div id="tab-journey">${journeyHtml(data.journey)}</div>
        <div id="tab-donations" class="hidden">
          ${table([
            { label: 'Datum', render: (r) => `<span class="muted">${date(r.received_at)}</span>` },
            { label: 'Bestemming', render: (r) => `${RF.catLabel(r)}${r.campaign_name ? `<span class="sub">${esc(r.campaign_name)}</span>` : ''}` },
            { label: 'Status', render: (r) => badge('donation', r.status) },
            { label: 'Cel', render: (r) => (r.cell_id ? `${badge('cell', r.cell_status)}<span class="sub">${euro(r.remaining_cents)} over</span>` : '<span class="muted">—</span>') },
            { label: 'Bedrag', num: true, render: (r) => `<b style="font-weight:600">${euro(r.amount_cents)}</b><span class="sub">${esc(label('frequency', r.frequency))}</span>` },
            { label: '', render: (r) => `<button class="icon-btn" data-edit-donation="${r.id}" aria-label="Donatie bewerken" title="Bewerken">${RF.icon('pencil')}</button>` },
          ], data.donations, { empty: 'Nog geen donaties', emptyIcon: 'banknote' })}
        </div>
        <div id="tab-interactions" class="hidden">
          <div style="margin-bottom:14px">${btn('add-interaction', 'Contactmoment vastleggen', { icon: 'plus', size: 'sm' })}</div>
          ${data.interactions.length ? `<ul class="timeline">${data.interactions.map((i) => `<li>
            <div class="when" style="display:flex;align-items:center;gap:6px">${RF.icon(RF.INTERACTION_ICONS[i.type] || 'file-text', 'icon-sm')} ${esc(label('interaction', i.type))} · ${dateTime(i.occurred_at)}${i.user_name ? ` · ${esc(i.user_name)}` : ''}
              <button class="icon-btn" data-del-interaction="${i.id}" title="Verwijderen" aria-label="Verwijderen" style="margin-left:auto;width:24px;height:24px">${RF.icon('trash-2', 'icon-sm')}</button></div>
            <div style="font-weight:500">${esc(i.subject)}</div><div style="white-space:pre-line;color:var(--text-2)">${esc(i.body)}</div></li>`).join('')}</ul>`
            : RF.emptyState({ icon: 'phone', title: 'Nog geen contactmomenten', text: 'Leg telefoontjes, afspraken en notities vast.' })}
        </div>
        <div id="tab-emails" class="hidden">
          ${data.emails.length ? data.emails.map((m) => `<details style="border-top:1px solid var(--border);padding:10px 0">
            <summary><span style="color:var(--text);font-weight:500">${esc(m.subject)}</span><span class="small muted" style="margin-left:auto;white-space:nowrap">${dateTime(m.created_at)}</span></summary>
            <p style="white-space:pre-line;margin:10px 0 0;color:var(--text-2)" class="small">${esc(m.body)}</p></details>`).join('')
            : RF.emptyState({ icon: 'mail', title: 'Nog geen e-mails verstuurd' })}
        </div>
      </div>
    </div>`;

  const tabs = $('#tabs');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    ['journey', 'donations', 'interactions', 'emails'].forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', t !== b.dataset.tab));
  });
  const reload = () => renderDonor(donorId);
  $('#edit').onclick = () => donorForm(d, reload);
  $('#add-donation').onclick = () => donationForm({ donor_id: d.id }, reload);
  $('#spend-donor').onclick = () => {
    const withMoney = data.impact.find((r) => r.waiting_cents > 0);
    if (!withMoney) { toast('Deze donateur heeft geen geld meer in de cellen', 'error'); return; }
    spendForm({ donor_id: d.id, category_key: withMoney.key }, reload);
  };
  $('#add-task').onclick = () => taskForm({ donor_id: d.id }, reload);
  $('#add-interaction').onclick = () => interactionForm(d.id, reload);
  const annual = () => annualModal(`/api/admin/donors/${d.id}/annual`, year);
  const portalAccess = () => modal({
    title: 'Toegang donateursportaal',
    body: `<p>Stel een wachtwoord in voor <b>${esc(d.email || 'deze donateur (geen e-mail!)')}</b>. Laat leeg voor een willekeurig wachtwoord.
      De donateur ontvangt een e-mail (zie E-mail log).</p><div class="field"><label>Wachtwoord (min. 8 tekens)</label><input type="text" name="password" minlength="8"></div>`,
    submitLabel: 'Instellen',
    onSubmit: async (f) => {
      const r = await api(`/api/admin/donors/${d.id}/portal`, { method: 'POST', body: f });
      modal({ title: 'Portaaltoegang ingesteld', body: `<p>Wachtwoord: <code style="font-size:1.1rem">${esc(r.password)}</code></p><p class="small muted">Deel dit veilig met de donateur.</p>` });
      reload();
    },
  });
  view().querySelectorAll('[data-task]').forEach((cb) => cb.addEventListener('change', async () => {
    await api(`/api/admin/tasks/${cb.dataset.task}`, { method: 'PUT', body: { status: cb.checked ? 'afgerond' : 'open' } });
    reload(); refreshNavCounts();
  }));
  view().querySelectorAll('[data-edit-donation]').forEach((b) => b.addEventListener('click', () =>
    donationForm(data.donations.find((x) => x.id === Number(b.dataset.editDonation)), reload)));
  view().querySelectorAll('[data-del-interaction]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Dit contactmoment verwijderen?', 'Verwijderen'))) return;
    await api(`/api/admin/interactions/${b.dataset.delInteraction}`, { method: 'DELETE', body: {} });
    reload();
  }));
  const anonymize = async () => {
      if (!(await confirmDialog('Alle persoonsgegevens van deze donateur worden onherroepelijk verwijderd. Donaties blijven (anoniem) bewaard.', 'Anonimiseren'))) return;
      await api(`/api/admin/donors/${d.id}/anonymize`, { method: 'POST', body: {} });
      toast('Donateur geanonimiseerd'); reload();
    };
  const removeDonor = async () => {
      if (!(await confirmDialog('Donateur en alle donaties definitief verwijderen?', 'Verwijderen'))) return;
      try { await api(`/api/admin/donors/${d.id}`, { method: 'DELETE', body: {} }); toast('Verwijderd'); go('#/donateurs'); }
      catch (e) { toast(e.message, 'error'); }
    };
  $('#more').onclick = (e) => RF.menu(e.currentTarget, [
    { label: d.has_portal ? 'Nieuw portaalwachtwoord' : 'Portaaltoegang geven', icon: 'key-round', onClick: portalAccess },
    { label: 'Jaaroverzicht', icon: 'file-text', onClick: annual },
    ...(isAdmin() ? [{ label: 'Inloggen als donateur', icon: 'eye', onClick: () => loginAs(`/api/admin/donors/${d.id}/impersonate`) },
      '-', { heading: 'Privacy (AVG)' },
      { label: 'Anonimiseren', icon: 'user', onClick: anonymize, danger: true },
      { label: 'Verwijderen', icon: 'trash-2', onClick: removeDonor, danger: true }] : []),
  ]);
}

function journeyHtml(journey) {
  if (!journey.length) return RF.emptyState({ icon: 'piggy-bank', title: 'Nog niets besteed', text: 'Het geld van deze donateur staat veilig in de cellen tot het wordt uitgegeven.' });
  return `<ul class="timeline">${journey.map((j) => `<li>
    <div class="when">${date(j.spent_at)} · gedoneerd ${date(j.donated_at)} · cel #${j.cell_id}</div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b class="num" style="font-weight:600">${euro(j.amount_cents)}</b>
      <span class="muted">${RF.icon('arrow-right', 'icon-sm')}</span>${RF.catLabel(j)}${j.recipient_name ? `<span class="muted">voor</span><b style="font-weight:500">${esc(j.recipient_name)}</b>` : ''}
      <a class="small" href="#/bestedingen/${j.expenditure_id}" style="margin-left:auto">Besteding #${j.expenditure_id}</a></div>
    <div class="small muted" style="margin-top:2px">${esc(j.description)}${j.units ? ` · ${Math.round(j.share * 100)}% van ${esc(RF.unitsText(j, j.units))}` : ''}</div>
    <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${j.messages.length ? j.messages.map((m) => `<span class="tag">${RF.icon(RF.MESSAGE_ICONS[m.type] || 'mail', 'icon-sm')}&nbsp;${esc(m.title)}&nbsp;·&nbsp;${m.read_at ? 'gelezen' : 'ongelezen'}</span>`).join('')
      : '<span class="badge badge-wachtend">Wacht op bericht van ontvanger</span>'}</div>
  </li>`).join('')}</ul>`;
}

function interactionForm(donorId, done) {
  modal({
    title: 'Contactmoment vastleggen',
    body: `<div class="field-row"><div class="field"><label>Type</label><select name="type">${labelOptions('interaction', 'telefoon')}</select></div>
      <div class="field"><label>Datum</label><input type="date" name="occurred_at" value="${today()}"></div></div>
      <div class="field"><label>Onderwerp</label><input type="text" name="subject" required></div>
      <div class="field"><label>Omschrijving</label><textarea name="body"></textarea></div>`,
    onSubmit: async (f) => {
      await api(`/api/admin/donors/${donorId}/interactions`, { method: 'POST', body: { ...f, occurred_at: f.occurred_at ? `${f.occurred_at} 12:00:00` : null } });
      toast('Contactmoment opgeslagen'); done();
    },
  });
}

async function annualModal(url, year) {
  const render = async (y) => {
    const a = await api(`${url}?year=${y}`);
    const years = []; for (let i = new Date().getFullYear(); i >= new Date().getFullYear() - 5; i--) years.push(i);
    return `<div class="no-print toolbar" style="margin-bottom:12px"><select id="annual-year">${years.map((v) => opt(v, v, a.year)).join('')}</select>
        <button type="button" class="btn btn-ghost" onclick="window.print()">${RF.icon('printer')}<span>Afdrukken / PDF</span></button></div>
      <div id="annual-doc">
      <h2>Giftenoverzicht ${esc(a.year)}</h2>
      <p><b>${esc(a.organisation.name)}</b> · ${esc(a.organisation.anbi)} · RSIN ${esc(a.organisation.rsin)}</p>
      <p>${esc(a.donor.full_name)}<br>${esc(a.donor.street)}<br>${esc(a.donor.postal_code)} ${esc(a.donor.city)}</p>
      ${table([
        { label: 'Datum', render: (r) => date(r.received_at) },
        { label: 'Bestemming', key: 'category_name' },
        { label: 'Betaalwijze', render: (r) => esc(label('method', r.method)) },
        { label: 'Bedrag', num: true, render: (r) => euro(r.amount_cents) },
      ], a.donations, { empty: 'Geen giften in dit jaar' })}
      <p style="margin-top:12px;font-size:1.1rem">Totaal ${esc(a.year)}: <b>${euro(a.total_cents)}</b></p>
      <p class="small muted">Waarvan in ${esc(a.year)} besteed aan projecten: ${euro(a.spent_in_year_cents)}. Giften aan een ANBI zijn onder voorwaarden aftrekbaar.</p></div>`;
  };
  const m = modal({ title: 'Jaaroverzicht', body: await render(year), wide: true });
  const bind = () => { const s = $('#annual-year', m.form); if (s) s.onchange = async () => { m.form.querySelector('.modal-body').innerHTML = await render(s.value); bind(); }; };
  bind();
}

// ======================================================================= DONATIES
function donationForm(d, done) {
  const isNew = !d.id;
  modal({
    title: isNew ? 'Donatie registreren' : `Donatie #${d.id} bewerken`, wide: true,
    body: `
      ${isNew && !d.donor_id ? `<div class="field"><label>Donateur</label><input type="search" id="donor-search" placeholder="Zoek donateur…" autocomplete="off">
        <input type="hidden" name="donor_id"><div id="donor-results" class="small"></div></div>` : `<input type="hidden" name="donor_id" value="${esc(d.donor_id)}">`}
      <div class="field-row">
        <div class="field"><label>Bestemming</label><select name="category_key">${catOptions(d.category_key)}</select></div>
        <div class="field"><label>Bedrag (€)</label><input type="text" name="amount" inputmode="decimal" required value="${d.amount_cents ? centsToInput(d.amount_cents) : ''}"></div>
        <div class="field"><label>Datum ontvangen</label><input type="date" name="received_at" value="${esc(d.received_at || today())}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Betaalwijze</label><select name="method">${labelOptions('method', d.method || 'ideal')}</select></div>
        <div class="field"><label>Frequentie</label><select name="frequency">${labelOptions('frequency', d.frequency || 'eenmalig')}</select></div>
        <div class="field"><label>Status</label><select name="status">${labelOptions('donation', d.status || 'ontvangen')}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Campagne</label><select name="campaign_id">${campaignOptions(d.campaign_id)}</select></div>
        <div class="field"><label>Referentie / kenmerk</label><input type="text" name="reference" value="${esc(d.reference || '')}"></div>
      </div>
      <div class="field"><label>Notitie</label><input type="text" name="note" value="${esc(d.note || '')}"></div>
      <p class="hint">Bij status <b>Ontvangen</b> wordt het geld automatisch in een eigen cel gezet tot het wordt besteed, en krijgt de donateur een bedankmail.</p>
      ${!isNew && isAdmin() ? '<button type="button" class="btn btn-danger btn-sm" id="del-donation">Donatie verwijderen</button>' : ''}`,
    onOpen: (form, close) => {
      const search = $('#donor-search', form);
      if (search) {
        search.addEventListener('input', RF.debounce(async () => {
          if (search.value.length < 2) { $('#donor-results', form).innerHTML = ''; return; }
          const rows = await api(`/api/admin/donors?q=${encodeURIComponent(search.value)}`);
          $('#donor-results', form).innerHTML = rows.slice(0, 8).map((r) =>
            `<button type="button" class="btn btn-ghost btn-sm" style="margin:4px 4px 0 0" data-pick="${r.id}" data-name="${esc(r.full_name)}">${esc(r.full_name)} <span class="muted">${esc(r.email || '')}</span></button>`).join('') || '<span class="muted">Niets gevonden</span>';
        }));
        $('#donor-results', form).addEventListener('click', (e) => {
          const b = e.target.closest('[data-pick]');
          if (!b) return;
          form.elements.donor_id.value = b.dataset.pick;
          search.value = b.dataset.name;
          $('#donor-results', form).innerHTML = `<span class="badge badge-goedgekeurd">${esc(b.dataset.name)}</span>`;
        });
      }
      const del = $('#del-donation', form);
      if (del) del.onclick = async () => {
        if (!(await confirmDialog('Deze donatie verwijderen?', 'Verwijderen'))) return;
        try { await api(`/api/admin/donations/${d.id}`, { method: 'DELETE', body: {} }); toast('Verwijderd'); close(); done(); }
        catch (e) { toast(e.message, 'error'); }
      };
    },
    onSubmit: async (f) => {
      if (!f.donor_id) throw new Error('Kies een donateur');
      const body = { ...f, amount_cents: toCents(f.amount), campaign_id: f.campaign_id || null };
      delete body.amount;
      await api(isNew ? '/api/admin/donations' : `/api/admin/donations/${d.id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast(isNew ? 'Donatie geregistreerd en in cel gezet' : 'Donatie bijgewerkt');
      done(); refreshNavCounts();
    },
  });
}

async function renderDonations() {
  view().innerHTML = `
    ${pageHead('Donaties', { sub: 'Alle giften, met de status van hun cel', actions: btn('export', 'Exporteren', { icon: 'download' }) + btn('new', 'Donatie registreren', { icon: 'plus', kind: 'primary' }) })}
    <div class="card flush">
      <div class="filters">
        ${searchInput('f-q', 'Zoek donateur of referentie')}
        <select id="f-cat">${catOptions('', true)}</select>
        <select id="f-status">${labelOptions('donation', '', 'Alle statussen')}</select>
        <select id="f-method">${labelOptions('method', '', 'Alle betaalwijzen')}</select>
        <select id="f-freq">${labelOptions('frequency', '', 'Alle frequenties')}</select>
        <select id="f-camp">${opt('', 'Alle campagnes', '')}${state.campaigns.map((c) => opt(c.id, c.name)).join('')}</select>
        <input type="date" id="f-from" title="Vanaf" aria-label="Vanaf"><input type="date" id="f-to" title="Tot en met" aria-label="Tot en met">
      </div>
      <div id="tbl">${RF.skeleton('rows')}</div>
    </div>`;
  const qs = () => new URLSearchParams({ q: $('#f-q').value, category: $('#f-cat').value, status: $('#f-status').value, method: $('#f-method').value,
    frequency: $('#f-freq').value, campaign: $('#f-camp').value, from: $('#f-from').value, to: $('#f-to').value });
  const load = async () => {
    const rows = await api(`/api/admin/donations?${qs()}`);
    const sum = rows.filter((r) => r.status === 'ontvangen').reduce((x, r) => x + r.amount_cents, 0);
    $('#tbl').innerHTML = table([
      { label: 'Datum', render: (r) => `<span class="muted">${date(r.received_at)}</span>` },
      { label: 'Donateur', render: (r) => `<div class="cell-person">${RF.avatar(r.donor_name, 'sm')}${donorLink(r.donor_id, r.donor_name)}</div>` },
      { label: 'Bestemming', render: (r) => `${RF.catLabel(r)}${r.campaign_name ? `<span class="sub">${esc(r.campaign_name)}</span>` : ''}` },
      { label: 'Betaling', render: (r) => `${esc(label('method', r.method))}<span class="sub">${esc(label('frequency', r.frequency))}</span>` },
      { label: 'Status', render: (r) => badge('donation', r.status) },
      { label: 'Cel', render: (r) => (r.cell_id ? badge('cell', r.cell_status) : '<span class="muted">—</span>') },
      { label: 'Bedrag', num: true, render: (r) => `<b style="font-weight:600">${euro(r.amount_cents)}</b>` },
    ], rows, { empty: 'Geen donaties gevonden', emptyIcon: 'banknote', onRow: true }) +
      `<div class="table-meta"><span>${rows.length} ${rows.length === 1 ? 'donatie' : 'donaties'}</span><span>Ontvangen: <b style="color:var(--text)">${euro(sum)}</b></span></div>`;
    bindRows($('#tbl'), rows, (r) => donationForm(r, load));
  };
  $('#f-q').addEventListener('input', RF.debounce(load));
  view().querySelectorAll('.filters select, .filters input[type=date]').forEach((el) => el.addEventListener('change', load));
  $('#new').onclick = () => donationForm({}, load);
  $('#export').onclick = () => { location.href = `/api/admin/donations?${qs()}&format=csv`; };
  await load();
}

// ======================================================================= CELLEN
async function renderCells() {
  view().innerHTML = `
    ${pageHead('Cellen', { sub: 'Elke donatie staat in een eigen cel tot het geld echt wordt uitgegeven',
      actions: `<span class="small muted" id="sel-info"></span>${btn('trigger', 'Selectie besteden', { icon: 'hand-coins', kind: 'primary' })}` })}
    <div class="kpis" id="cat-summary"></div>
    <div class="card flush" style="margin-top:16px">
      <div class="filters">
        <div class="seg" id="f-cat-seg" role="tablist" aria-label="Bestemming"></div>
        <select id="f-status" style="margin-left:auto">${opt('open', 'Open (saldo over)', 'open')}${opt('', 'Alle cellen', '')}${labelOptions('cell', '')}</select>
        <input type="hidden" id="f-cat" value="">
      </div>
      <div id="tbl">${RF.skeleton('rows')}</div>
    </div>`;
  $('#trigger').disabled = true;
  const selected = new Map();
  $('#cat-summary').innerHTML = state.categories.map((c) => `<div class="kpi">
    <div class="label">${RF.catIcon(c, 'sm')}${esc(c.name)}</div><div class="value">${euro0(c.waiting_cents)}</div>
    <div class="sub">${c.open_cells} open${c.unit_cost_cents ? ` · ruimte voor ${num(Math.floor(c.waiting_cents / c.unit_cost_cents))} ${esc(c.unit_label_plural)}` : ''}</div></div>`).join('');
  const seg = $('#f-cat-seg');
  seg.innerHTML = [`<button class="active" data-k="">Alle</button>`, ...state.categories.map((c) => `<button data-k="${esc(c.key)}">${esc(c.name.split(' ')[0])}</button>`)].join('');
  seg.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    $('#f-cat').value = b.dataset.k; load();
  };

  const updateSel = () => {
    const cells = [...selected.values()];
    const sum = cells.reduce((x, c) => x + c.remaining_cents, 0);
    const cats = new Set(cells.map((c) => c.category_key));
    $('#sel-info').innerHTML = cells.length ? `${cells.length} geselecteerd · <b style="color:var(--text)">${euro(sum)}</b>${cats.size > 1 ? ' · <span style="color:var(--bad)">kies één bestemming</span>' : ''}` : 'Selecteer cellen om te besteden';
    $('#trigger').disabled = !cells.length || cats.size > 1;
  };
  const load = async () => {
    const rows = await api(`/api/admin/cells?category=${$('#f-cat').value}&status=${$('#f-status').value}`);
    selected.clear(); updateSel();
    $('#tbl').innerHTML = table([
      { label: '', width: '36px', render: (r) => (r.remaining_cents > 0 ? `<input type="checkbox" data-cell="${r.id}" aria-label="Selecteer cel ${r.id}">` : '') },
      { label: 'Donateur', render: (r) => `<div class="cell-person">${RF.avatar(r.donor_name, 'sm')}<div class="grow">${donorLink(r.donor_id, r.donor_name)}<span class="sub">Cel #${r.id} · ${date(r.received_at)}</span></div></div>` },
      { label: 'Bestemming', render: (r) => RF.catLabel(r) },
      { label: 'Status', render: (r) => badge('cell', r.status) },
      { label: 'Gebruikt', width: '16%', render: (r) => `<div style="min-width:90px">${RF.splitBar(r.amount_cents - r.remaining_cents, r.remaining_cents)}</div>` },
      { label: 'Wacht', num: true, render: (r) => `<span class="muted">${r.remaining_cents > 0 ? ago(r.age_days) : '—'}</span>` },
      { label: 'Saldo', num: true, render: (r) => `<b style="font-weight:600">${euro(r.remaining_cents)}</b><span class="sub">van ${euro(r.amount_cents)}</span>` },
    ], rows, { empty: 'Geen cellen in deze selectie', emptyIcon: 'piggy-bank' });
    $('#tbl').querySelectorAll('[data-cell]').forEach((cb) => cb.addEventListener('change', () => {
      const cell = rows.find((r) => r.id === Number(cb.dataset.cell));
      if (cb.checked) selected.set(cell.id, cell); else selected.delete(cell.id);
      cb.closest('tr').style.background = cb.checked ? 'var(--accent-soft)' : '';
      updateSel();
    }));
  };
  $('#f-status').onchange = load;
  $('#trigger').onclick = () => {
    const cells = [...selected.values()];
    spendForm({ category_key: cells[0].category_key, cells }, async () => { await loadLookups(); renderCells(); });
  };
  await load();
}

// ======================================================================= BESTEDINGEN
function messageFields(prefix = '') {
  return `
    <div class="field-row">
      <div class="field"><label>Type</label><select name="${prefix}type">${labelOptions('message', 'brief')}</select></div>
      <div class="field" style="grid-column: span 2"><label>Titel</label><input type="text" name="${prefix}title" placeholder="bv. Een brief van Amara"></div>
    </div>
    <div class="field"><label>Tekst / transcriptie van de brief</label><textarea name="${prefix}body"></textarea></div>
    <div class="field"><label>Media (foto, scan van brief, filmpje of PDF)</label>
      <input type="file" data-upload="${prefix}media_url" accept="image/*,video/*,application/pdf">
      <input type="url" name="${prefix}media_url" placeholder="…of plak een URL (bv. https://www.youtube.com/embed/…)" style="margin-top:6px">
      <div class="hint" data-upload-status="${prefix}media_url"></div></div>`;
}
function bindUploads(form) {
  form.querySelectorAll('[data-upload]').forEach((input) => input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const status = form.querySelector(`[data-upload-status="${input.dataset.upload}"]`);
    status.textContent = `Uploaden: ${file.name}…`;
    try {
      const data = await RF.readFileBase64(file);
      const r = await api('/api/admin/uploads', { method: 'POST', body: { filename: file.name, data } });
      form.elements[input.dataset.upload].value = r.url;
      status.textContent = `Geüpload (${Math.round(r.size / 1024)} kB)`;
    } catch (e) { status.textContent = `Uploaden mislukt: ${e.message}`; }
  }));
}

function spendForm(pre, done) {
  const cells = pre.cells || [];
  const fromCells = cells.length > 0;
  const cellSum = cells.reduce((s, c) => s + c.remaining_cents, 0);
  modal({
    title: fromCells ? `${cells.length} cel(len) besteden` : 'Geld besteden', wide: true, submitLabel: 'Besteding vastleggen',
    body: `
      ${fromCells ? `<div class="impact-preview">Geselecteerd: ${cells.length} cellen van ${esc(catByKey(pre.category_key).name)} · totaal ${euro(cellSum)}</div>
        <input type="hidden" name="category_key" value="${esc(pre.category_key)}">`
        : `<div class="field-row">
            <div class="field"><label>Bestemming</label><select name="category_key">${catOptions(pre.category_key)}</select></div>
            <div class="field"><label>Uit cellen van</label><select name="donor_id"><option value="">Oudste cellen eerst (alle donateurs)</option></select>
              <div class="hint">Kies een donateur om precies diens geld aan deze ontvanger te besteden.</div></div></div>`}
      <div class="field-row">
        <div class="field" data-units><label>Aantal <span data-unit-label></span></label><input type="number" name="units" min="1" step="1"></div>
        <div class="field"><label>Bedrag (€)</label><input type="text" name="amount" inputmode="decimal" placeholder="${fromCells ? centsToInput(cellSum) : ''}"></div>
        <div class="field"><label>Datum besteding</label><input type="date" name="spent_at" value="${today()}"></div>
      </div>
      <div class="impact-preview" id="spend-preview"></div>
      <div class="small" id="spend-sources" style="margin:-6px 0 12px"></div>
      <div class="field"><label>Ontvanger</label><select name="recipient_id">${recipientOptions(pre.recipient_id)}</select></div>
      <div class="field"><label>Omschrijving</label><input type="text" name="description" placeholder="bv. 400 schoolmaaltijden voor Escuela Esperanza (week 46)"></div>
      <details style="margin:8px 0 12px" ${pre.withMessage ? 'open' : ''}><summary><b>Bericht van de ontvanger direct meesturen</b> (brief, filmpje, foto…)</summary>
        <div style="margin-top:10px">${messageFields('msg_')}</div></details>
      <p class="hint">${fromCells ? 'Het bedrag wordt uit precies deze cellen gehaald (in volgorde van selectie).' : 'Het geld wordt uit de oudste cellen van deze bestemming gehaald (first in, first out).'}
        Elke betrokken donateur krijgt automatisch een e-mail, ziet de besteding in zijn portaal en kan daarna chatten met de ontvanger.</p>`,
    onOpen: (form) => {
      bindUploads(form);
      let openCells = cells;
      const loadCells = async () => {
        if (fromCells) return;
        const cat = form.elements.category_key.value;
        openCells = await api(`/api/admin/cells?category=${encodeURIComponent(cat)}&status=open`);
        const sel = form.elements.donor_id;
        const prev = sel.value || (pre.donor_id ? String(pre.donor_id) : '');
        const donors = new Map();
        for (const c of openCells) {
          const d = donors.get(c.donor_id) || { name: c.donor_name, cents: 0 };
          d.cents += c.remaining_cents;
          donors.set(c.donor_id, d);
        }
        sel.innerHTML = '<option value="">Oudste cellen eerst (alle donateurs)</option>' +
          [...donors.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))
            .map(([id, d]) => `<option value="${id}" ${String(id) === prev ? 'selected' : ''}>${esc(d.name)} — ${euro(d.cents)} in cel</option>`).join('');
        update();
      };
      const update = () => {
        const cat = catByKey(form.elements.category_key.value);
        const unitField = form.querySelector('[data-units]');
        unitField.classList.toggle('hidden', !cat.unit_cost_cents);
        form.querySelector('[data-unit-label]').textContent = cat.unit_label_plural || '';
        const units = Number(form.elements.units.value);
        let amount = form.elements.amount.value ? toCents(form.elements.amount.value) : null;
        if (!amount && units && cat.unit_cost_cents) amount = units * cat.unit_cost_cents;
        if (!amount && fromCells) amount = cellSum;
        const donorId = !fromCells && form.elements.donor_id.value ? Number(form.elements.donor_id.value) : null;
        const pool = donorId ? openCells.filter((c) => c.donor_id === donorId) : openCells;
        const avail = pool.reduce((s, c) => s + c.remaining_cents, 0);
        // Voorbeeld: welke donateurs worden aangesproken (zelfde volgorde als de server)
        const per = new Map();
        let left = amount || 0;
        for (const c of pool) {
          if (left <= 0) break;
          const take = Math.min(c.remaining_cents, left);
          per.set(c.donor_name, (per.get(c.donor_name) || 0) + take);
          left -= take;
        }
        $('#spend-sources', form).innerHTML = per.size
          ? `Geld komt uit de cellen van: ${[...per.entries()].map(([n, v]) => `<b>${esc(n)}</b> (${euro(v)})`).join(', ')}` : '';
        $('#spend-preview', form).innerHTML = amount
          ? `${euro(amount)} wordt besteed ${cat.unit_cost_cents ? `(≈ ${num(Math.floor(amount / cat.unit_cost_cents))} ${esc(cat.unit_label_plural)})` : ''} · beschikbaar ${euro(avail)}
             ${amount > avail ? '<br><span style="color:var(--bad)">Onvoldoende saldo!</span>' : ''}`
          : `Beschikbaar in cellen: ${euro(avail)}${cat.unit_cost_cents ? ` (≈ ${num(Math.floor(avail / cat.unit_cost_cents))} ${esc(cat.unit_label_plural)})` : ''}`;
      };
      form.addEventListener('input', update);
      form.addEventListener('change', (e) => { if (e.target.name === 'category_key') loadCells(); else update(); });
      update();
      loadCells();
    },
    onSubmit: async (f) => {
      const body = {
        category_key: f.category_key, units: f.units || null, amount_cents: f.amount ? toCents(f.amount) : null,
        spent_at: f.spent_at, recipient_id: f.recipient_id || null, description: f.description,
        cell_ids: cells.map((c) => c.id), donor_id: f.donor_id || null,
      };
      if (f.msg_title) body.message = { type: f.msg_type, title: f.msg_title, body: f.msg_body, media_url: f.msg_media_url };
      const r = await api('/api/admin/expenditures', { method: 'POST', body });
      toast(`Besteding vastgelegd: ${euro(r.amount_cents)} uit cellen van ${r.donors} donateur(s)`);
      await loadLookups();
      done(r);
    },
  });
}

async function renderExpenditures() {
  view().innerHTML = `
    ${pageHead('Bestedingen', { sub: 'Wanneer geld uit de cellen wordt uitgegeven, en aan wie', actions: btn('new', 'Geld besteden', { icon: 'hand-coins', kind: 'primary' }) })}
    <div class="card flush">
      <div class="filters"><select id="f-cat">${catOptions('', true)}</select></div>
      <div id="tbl">${RF.skeleton('rows')}</div>
    </div>`;
  const load = async () => {
    const rows = await api(`/api/admin/expenditures?category=${$('#f-cat').value}`);
    const sum = rows.reduce((x, r) => x + r.amount_cents, 0);
    $('#tbl').innerHTML = table([
      { label: 'Besteding', render: (r) => `<span class="cat-name">${RF.catIcon(r)}<span><b style="font-weight:500">${esc(r.recipient_name || r.category_name)}</b><span class="sub">${esc(r.category_name)} · ${date(r.spent_at)}</span></span></span>` },
      { label: 'Omschrijving', render: (r) => `<span class="muted" style="display:block;max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.description) || '—'}</span>` },
      { label: 'Aantal', num: true, render: (r) => (r.units ? `${num(r.units)} ${esc(r.units === 1 ? r.unit_label : r.unit_label_plural)}` : '<span class="muted">—</span>') },
      { label: 'Donateurs', num: true, render: (r) => `<span class="muted">${r.donor_count}</span>` },
      { label: 'Bericht', render: (r) => (r.message_count ? `<span class="badge badge-goedgekeurd">${r.message_count} verstuurd</span>` : '<span class="badge badge-wachtend">Ontbreekt</span>') },
      { label: 'Bedrag', num: true, render: (r) => `<b style="font-weight:600">${euro(r.amount_cents)}</b>` },
    ], rows, { empty: 'Nog geen bestedingen', emptyIcon: 'hand-coins', onRow: true }) +
      `<div class="table-meta"><span>${rows.length} ${rows.length === 1 ? 'besteding' : 'bestedingen'}</span><span>Totaal: <b style="color:var(--text)">${euro(sum)}</b></span></div>`;
    bindRows($('#tbl'), rows, (r) => go(`#/bestedingen/${r.id}`));
  };
  $('#f-cat').onchange = load;
  $('#new').onclick = () => spendForm({}, (r) => go(`#/bestedingen/${r.id}`));
  await load();
}

async function renderExpenditure(expId) {
  const e = await api(`/api/admin/expenditures/${expId}`);
  const donors = new Set(e.allocations.map((x) => x.donor_id)).size;
  view().innerHTML = `
    <div class="crumbs"><a href="#/bestedingen">Bestedingen</a>${RF.icon('chevron-right', 'icon-sm')}<span>#${e.id}</span></div>
    <div class="page-head" style="align-items:center"><div class="profile-head">${RF.catIcon(e, 'lg')}
        <div><h1>${esc(e.recipient_name || e.category_name)}</h1>
        <div class="profile-meta"><span>${esc(e.category_name)}</span><span class="dot-sep">${date(e.spent_at)}</span><span class="dot-sep">Besteding #${e.id}</span></div></div></div>
      <div class="toolbar">${isAdmin() ? btn('reverse', 'Terugdraaien', { icon: 'undo-2', kind: 'danger' }) : ''}
        ${btn('add-msg', 'Bericht koppelen', { icon: 'mail-open', kind: 'primary' })}</div></div>
    <div class="kpis cols-3">
      <div class="kpi"><div class="label">Bedrag</div><div class="value">${euro(e.amount_cents)}</div><div class="sub">${e.units ? `${num(e.units)} ${esc(e.unit_label_plural)}` : 'Vrij bedrag'}</div></div>
      <div class="kpi"><div class="label">Gefinancierd door</div><div class="value">${donors} ${donors === 1 ? 'donateur' : 'donateurs'}</div><div class="sub">uit ${e.allocations.length} ${e.allocations.length === 1 ? 'cel' : 'cellen'}</div></div>
      <div class="kpi"><div class="label">Berichten</div><div class="value">${e.messages.length}</div><div class="sub">${e.messages.length ? 'verstuurd naar donateurs' : 'Nog geen bericht van de ontvanger'}</div></div>
    </div>
    ${e.description ? `<div class="callout neutral" style="margin-top:16px">${RF.icon('info')}<span>${esc(e.description)}</span></div>` : ''}
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card flush"><div class="card-head"><h2>Herkomst van het geld</h2></div>
        ${table([
          { label: 'Donateur', render: (x) => `<div class="cell-person">${RF.avatar(x.donor_name, 'sm')}<div class="grow">${donorLink(x.donor_id, x.donor_name)}<span class="sub">Cel #${x.cell_id} · ${date(x.received_at)}</span></div></div>` },
          { label: 'Celbedrag', num: true, render: (x) => `<span class="muted">${euro(x.cell_amount_cents)}</span>` },
          { label: 'Gebruikt', num: true, render: (x) => `<b style="font-weight:600">${euro(x.amount_cents)}</b>` },
        ], e.allocations)}</div>
      <div class="card"><div class="card-head"><h2>Berichten van de ontvanger</h2></div>
        ${e.messages.length ? e.messages.map((m) => `<div class="message-card" style="border-top:1px solid var(--border);padding-top:14px;margin-top:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="cat-name"><span class="cat-ico sm" style="--c:var(--accent)">${RF.icon(RF.MESSAGE_ICONS[m.type] || 'mail')}</span><b style="font-weight:600">${esc(m.title)}</b></span>
          <button class="icon-btn" data-del-msg="${m.id}" title="Verwijderen" aria-label="Bericht verwijderen">${RF.icon('trash-2')}</button></div>
          <div class="small muted" style="margin-top:4px">${esc(label('message', m.type))} · bezorgd bij ${m.delivered} · ${m.read_count} gelezen</div>
          ${RF.mediaHtml(m.type, m.media_url, m.title)}
          ${m.body ? `<div class="${m.type === 'brief' ? 'letter' : ''}" style="white-space:pre-line;margin-top:8px">${esc(m.body)}</div>` : ''}</div>`).join('').replace('border-top:1px solid var(--border);padding-top:14px;margin-top:14px', '')
          : RF.emptyState({ icon: 'mail-open', title: 'Nog geen bericht', text: 'Koppel een brief, foto of filmpje van de ontvanger. Alle donateurs hiernaast krijgen het in hun portaal.' })}
      </div>
    </div>`;
  const reload = () => renderExpenditure(expId);
  $('#add-msg').onclick = () => modal({
    title: 'Bericht van ontvanger koppelen', wide: true, submitLabel: 'Versturen naar donateurs',
    body: `<div class="field"><label>Van ontvanger</label><select name="recipient_id">${recipientOptions(e.recipient_id)}</select></div>${messageFields()}`,
    onOpen: bindUploads,
    onSubmit: async (f) => {
      const r = await api(`/api/admin/expenditures/${expId}/messages`, { method: 'POST', body: f });
      toast(`Bericht bezorgd bij ${r.delivered_to} donateur(s)`); reload();
    },
  });
  view().querySelectorAll('[data-del-msg]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Dit bericht verwijderen? Het verdwijnt ook uit de portalen van donateurs.', 'Verwijderen'))) return;
    await api(`/api/admin/messages/${b.dataset.delMsg}`, { method: 'DELETE', body: {} }); reload();
  }));
  if (isAdmin()) $('#reverse').onclick = async () => {
    if (!(await confirmDialog('Besteding terugdraaien? Het geld gaat terug in de cellen en gekoppelde berichten worden verwijderd.', 'Terugdraaien'))) return;
    await api(`/api/admin/expenditures/${expId}`, { method: 'DELETE', body: {} });
    await loadLookups(); toast('Besteding teruggedraaid'); go('#/bestedingen');
  };
}

// ======================================================================= ONTVANGERS
async function renderRecipients() {
  const rows = await api('/api/admin/recipients');
  state.recipients = rows;
  view().innerHTML = `
    ${pageHead('Gezinnen', { sub: 'De gezinnen van de kinderen. Het gezin chat met de sponsor (standaard in het Tagalog, automatisch vertaald). Verhaal en gezinsfoto zijn alleen zichtbaar voor sponsors bij toestemming.', actions: btn('new', 'Nieuw gezin', { icon: 'plus', kind: 'primary' }) })}
    ${rows.length ? `<div class="grid grid-3">${rows.map((r) => `<div class="card recipient-card" data-r="${r.id}" style="cursor:pointer;${r.active ? '' : 'opacity:.55'}" tabindex="0">
      <div style="display:flex;gap:12px;align-items:center">
        ${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="" style="width:44px;height:44px;border-radius:12px;object-fit:cover;background:var(--surface-2)">` : RF.avatar(r.name)}
        <div style="min-width:0;flex:1"><div style="font-weight:600">${esc(r.name)}</div>
          <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label('recipient', r.kind))}${r.age ? ` · ${r.age} jaar` : ''}${r.location || r.country ? ` · ${esc([r.location, r.country].filter(Boolean).join(', '))}` : ''}</div></div>
        <button class="icon-btn" data-more="${r.id}" aria-label="Acties voor ${esc(r.name)}">${RF.icon('ellipsis')}</button></div>
      <p class="small" style="margin:12px 0;color:var(--text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px">${esc(r.story) || '<span class="muted">Geen verhaal</span>'}</p>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        <span class="tag">${RF.icon(r.consent ? 'shield-check' : 'lock', 'icon-sm')}&nbsp;${r.consent ? 'Delen toegestaan' : 'Niet delen'}</span>
        <span class="tag">${RF.icon(r.has_login ? 'key-round' : 'circle-dashed', 'icon-sm')}&nbsp;${r.has_login ? esc(r.username) : 'Geen inlog'}</span>
        ${r.has_login && r.chat_enabled ? `<span class="tag">${RF.icon('messages-square', 'icon-sm')}&nbsp;${r.chat_moderated ? 'Chat · gemodereerd' : 'Chat'}</span>` : ''}
      </div>
      <hr style="margin:14px 0 10px"><div style="display:flex;justify-content:space-between;gap:8px" class="small muted"><span>${RF.icon('smile', 'icon-sm')} ${r.children_count ? esc(r.children_names) : 'Nog geen kinderen'}</span>${r.received_cents ? `<b class="num" style="color:var(--text);font-weight:600">${euro(r.received_cents)}</b>` : ''}</div>
    </div>`).join('')}</div>` : `<div class="card">${RF.emptyState({ icon: 'heart-handshake', title: 'Nog geen ontvangers', text: 'Voeg kinderen, scholen of projecten toe om geld aan te besteden.' })}</div>`}`;
  const form = (r = {}) => modal({
    title: r.id ? 'Gezin bewerken' : 'Nieuw gezin', wide: true,
    body: `<div class="field-row"><div class="field"><label>Naam</label><input type="text" name="name" required value="${esc(r.name || '')}" placeholder="bv. Familie Santos"></div>
        <div class="field"><label>Soort</label><select name="kind">${labelOptions('recipient', r.kind || 'gezin')}</select></div>
        <div class="field"><label>Telefoon (intern)</label><input type="text" name="phone" value="${esc(r.phone || '')}"></div></div>
      <div class="field-row"><div class="field"><label>Adres (intern)</label><input type="text" name="street" value="${esc(r.street || '')}"></div>
        <div class="field"><label>Barangay</label><input type="text" name="barangay" value="${esc(r.barangay || '')}"></div></div>
      <div class="field-row"><div class="field"><label>Plaats</label><input type="text" name="location" value="${esc(r.location || '')}"></div>
        <div class="field"><label>Provincie</label><input type="text" name="province" value="${esc(r.province || '')}"></div>
        <div class="field"><label>Land</label><input type="text" name="country" value="${esc(r.country || 'Filipijnen')}"></div></div>
      <input type="hidden" name="school" value="${esc(r.school || '')}"><input type="hidden" name="age" value="${esc(r.age ?? '')}">
      <div class="hint" style="margin:-4px 0 12px">Adres en telefoon zijn alleen voor medewerkers; sponsors zien plaats en provincie.</div>
      <div class="field"><label>Verhaal van het gezin</label><textarea name="story" rows="4">${esc(r.story || '')}</textarea></div>
      <div class="field"><label>Gezinsfoto</label><input type="file" data-upload="photo_url" accept="image/*">
        <input type="text" name="photo_url" value="${esc(r.photo_url || '')}" placeholder="/uploads/… of URL" style="margin-top:6px"><div class="hint" data-upload-status="photo_url"></div></div>
      <label class="check"><input type="checkbox" name="consent" ${r.consent ? 'checked' : ''}> Toestemming (ouder/voogd) om foto en verhaal met sponsors te delen</label>
      <label class="check"><input type="checkbox" name="active" ${r.active ?? 1 ? 'checked' : ''}> Actief</label>`,
    onOpen: bindUploads,
    onSubmit: async (f) => {
      await api(r.id ? `/api/admin/recipients/${r.id}` : '/api/admin/recipients', { method: r.id ? 'PUT' : 'POST', body: f });
      toast('Gezin opgeslagen'); renderRecipients();
    },
  });
  $('#new').onclick = () => form();
  view().querySelectorAll('[data-r]').forEach((el) => {
    const r = rows.find((x) => x.id === Number(el.dataset.r));
    el.addEventListener('click', (e) => { if (!e.target.closest('[data-more]')) form(r); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) form(r); });
  });
  view().querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    const r = rows.find((x) => x.id === Number(b.dataset.more));
    RF.menu(b, [
      { label: 'Bewerken', icon: 'pencil', onClick: () => form(r) },
      { label: 'Inlog & chat', icon: 'key-round', onClick: () => accessForm(r) },
      ...(isAdmin() && r.active ? [{ label: 'Inloggen als ontvanger', icon: 'eye', onClick: () => loginAs(`/api/admin/recipients/${r.id}/impersonate`) }] : []),
    ]);
  }));
}

// "Inloggen als": opent het portaal in een nieuw tabblad (meekijken, alleen-lezen).
async function loginAs(url) {
  const win = window.open('about:blank', '_blank'); // direct openen, anders blokkeert Safari de pop-up
  try {
    const r = await api(url, { method: 'POST', body: {} });
    if (win) win.location = r.url; else location.href = r.url;
  } catch (e) {
    if (win) win.close();
    toast(e.message, 'error');
  }
}

function accessForm(r) {
  const isChild = r.kind === 'kind';
  modal({
    title: `Inlog & chat: ${r.name}`,
    body: `
      <p class="small muted">Met een inlog kan de ontvanger op <b>/ontvanger</b> chatten met de donateurs van wie geld aan hem/haar is besteed.
        Donateurs zien alleen de voornaam; ontvangers zien de publieke naam van de donateur (anoniem blijft anoniem).</p>
      <div class="field"><label>Gebruikersnaam</label><input type="text" name="username" value="${esc(r.username || '')}" placeholder="bv. amara" autocapitalize="none">
        <div class="hint">Leeg laten = inlog verwijderen.</div></div>
      <div class="field"><label>${r.has_login ? 'Nieuw wachtwoord (optioneel)' : 'Wachtwoord'}</label><input type="text" name="password" minlength="8" autocomplete="off"></div>
      <div class="field"><label>Begeleider ${isChild ? '(verplicht bij kinderen)' : '(optioneel)'}</label>
        <input type="text" name="managed_by" value="${esc(r.managed_by || '')}" placeholder="bv. Juf Marie (Escuela Esperanza)" ${isChild ? 'required' : ''}>
        <div class="hint">De volwassene die het account beheert en het kind helpt met lezen en schrijven.</div></div>
      <div class="field"><label>Taal waarin de ontvanger leest en schrijft</label><select name="language">${langOptions(r.language_effective || r.language)}</select>
        <div class="hint">Gezinnen: standaard Tagalog. Berichten worden automatisch vertaald.</div></div>
      <label class="check"><input type="checkbox" name="chat_enabled" ${r.chat_enabled ?? 1 ? 'checked' : ''}> Chat ingeschakeld</label>
      <label class="check"><input type="checkbox" name="chat_moderated" ${r.chat_moderated || isChild ? 'checked' : ''} ${isChild ? 'disabled' : ''}>
        <span>Berichten eerst laten goedkeuren door een medewerker ${isChild ? '<span class="muted">(altijd aan bij kinderen)</span>' : ''}</span></label>
      <p class="hint">Berichten met contactgegevens, links, social media of geldverzoeken worden altijd eerst ter controle aangeboden.</p>`,
    onSubmit: async (f) => {
      await api(`/api/admin/recipients/${r.id}/access`, { method: 'PUT', body: f });
      toast('Inlog & chatinstellingen opgeslagen');
      renderRecipients();
    },
  });
}

// ======================================================================= CHATMODERATIE
async function renderChatModeration() {
  view().innerHTML = `
    <div class="page-head"><div><h1>Chatmoderatie</h1><div class="sub">Berichten tussen donateurs en ontvangers</div></div>
      <div class="toolbar"><select id="f-status">${opt('in_behandeling', 'Wacht op controle', 'in_behandeling')}${opt('goedgekeurd', 'Goedgekeurd')}${opt('afgewezen', 'Afgewezen')}${opt('', 'Alle')}</select></div></div>
    <div class="card" id="mod-card" style="margin-bottom:14px"></div>
    <div id="list"></div>`;
  const drawSwitch = (on) => {
    $('#mod-card').innerHTML = `<div class="card-head" style="margin:0"><div>
        <h3 style="margin:0;display:flex;align-items:center;gap:8px"><span class="cat-ico sm" style="--c:var(--${on ? 'ok' : 'warn'})">${RF.icon(on ? 'shield-check' : 'shield-alert')}</span>${on ? 'Moderatie staat aan' : 'Moderatie staat uit'}</h3>
        <p class="small muted" style="margin:4px 0 0;max-width:720px">${on
          ? 'Berichten met kinderen (en berichten met contactgegevens, links of geldverzoeken) worden pas afgeleverd na goedkeuring.'
          : 'Alle berichten worden direct afgeleverd, ook die met kinderen. Berichten met contactgegevens, links of geldverzoeken krijgen wel een markering zodat je ze hier achteraf kunt zien (kies "Alle"). Zet dit weer aan voordat je met echte kinderen werkt.'}</p></div>
      ${isAdmin() ? `<button class="btn ${on ? 'btn-ghost' : 'btn-primary'}" id="mod-toggle">${on ? 'Moderatie uitzetten' : 'Moderatie aanzetten'}</button>` : ''}</div>`;
    const b = $('#mod-toggle');
    if (b) b.onclick = async () => {
      if (on && !(await confirmDialog('Moderatie uitzetten? Alle berichten, ook met kinderen, worden dan direct afgeleverd.', 'Uitzetten'))) return;
      const r = await api('/api/admin/chat/moderation', { method: 'PUT', body: { enabled: !on } });
      toast(r.enabled ? 'Moderatie staat aan' : 'Moderatie staat uit');
      drawSwitch(r.enabled);
    };
  };
  drawSwitch((await api('/api/admin/chat/moderation')).enabled);
  const load = async () => {
    const rows = await api(`/api/admin/chat?status=${$('#f-status').value}`);
    $('#list').innerHTML = rows.length ? rows.map((m) => `<div class="card" style="margin-bottom:12px">
      <div class="card-head"><div>
        <b>${m.sender === 'donor' ? `${esc(m.donor_name)} → ${esc(m.recipient_name)}` : `${esc(m.recipient_name)} → ${esc(m.donor_name)}`}</b>
        <span class="small muted">· ${dateTime(m.created_at)} · ${esc(label('recipient', m.recipient_kind))}${m.managed_by ? ` (begeleider: ${esc(m.managed_by)})` : ''}</span>
        ${m.flag_reason ? `<div style="margin-top:6px"><span class="badge badge-hoog">Bevat mogelijk: ${esc(m.flag_reason)}</span></div>` : ''}</div>
        ${m.status === 'in_behandeling' ? '' : `<span class="badge badge-${m.status === 'goedgekeurd' ? 'besteed' : 'geannuleerd'}">${esc(m.status)}${m.reviewed_by_name ? ` · ${esc(m.reviewed_by_name)}` : ''}</span>`}</div>
      <div class="bubble theirs" style="max-width:100%"><div class="bubble-body">${esc(m.body)}</div></div>
      ${m.reject_reason ? `<p class="small muted">Reden afwijzing: ${esc(m.reject_reason)}</p>` : ''}
      <div class="toolbar" style="margin-top:10px">
        ${m.status === 'in_behandeling' ? `<button class="btn btn-primary btn-sm" data-approve="${m.id}">${RF.icon('check')}<span>Goedkeuren</span></button>
          <button class="btn btn-danger btn-sm" data-reject="${m.id}">${RF.icon('x')}<span>Afwijzen</span></button>` : ''}
        <button class="btn btn-ghost btn-sm" data-thread="${m.recipient_id}:${m.donor_id}">Heel gesprek bekijken</button>
        <a class="btn btn-ghost btn-sm" href="#/donateurs/${m.donor_id}">Donateur</a></div></div>`).join('')
      : `<div class="card">${RF.emptyState({ icon: 'check-check', title: 'Niets te controleren', text: 'Alle chatberichten in deze selectie zijn afgehandeld.' })}</div>`;
    $('#list').querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/admin/chat/${b.dataset.approve}/approve`, { method: 'POST', body: {} });
      toast('Goedgekeurd en afgeleverd'); refreshNavCounts(); load();
    }));
    $('#list').querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => modal({
      title: 'Bericht afwijzen',
      body: '<div class="field"><label>Reden (de afzender ziet deze)</label><input type="text" name="reason" value="Bevat persoonlijke gegevens"></div>',
      submitLabel: 'Afwijzen',
      onSubmit: async (f) => {
        await api(`/api/admin/chat/${b.dataset.reject}/reject`, { method: 'POST', body: f });
        toast('Afgewezen'); refreshNavCounts(); load();
      },
    })));
    $('#list').querySelectorAll('[data-thread]').forEach((b) => b.addEventListener('click', async () => {
      const [rid, did] = b.dataset.thread.split(':');
      const msgs = await api(`/api/admin/chat/thread?recipient_id=${rid}&donor_id=${did}`);
      modal({
        title: 'Volledig gesprek', wide: true,
        body: `<div class="chat-log" style="height:auto;max-height:60vh">${msgs.map((m) => `<div class="bubble ${m.sender === 'donor' ? 'mine' : 'theirs'} ${m.status !== 'goedgekeurd' ? 'pending' : ''}">
          <div class="bubble-body">${esc(m.body)}</div><div class="bubble-meta">${m.sender === 'donor' ? 'Donateur' : 'Ontvanger'} · ${dateTime(m.created_at)} · ${esc(m.status)}</div></div>`).join('')}</div>`,
      });
    }));
  };
  $('#f-status').onchange = load;
  await load();
}

// ======================================================================= TAKEN
function taskForm(t, done) {
  modal({
    title: t.id ? 'Taak bewerken' : 'Nieuwe taak',
    body: `<div class="field"><label>Titel</label><input type="text" name="title" required value="${esc(t.title || '')}"></div>
      <div class="field"><label>Omschrijving</label><textarea name="description">${esc(t.description || '')}</textarea></div>
      <div class="field-row"><div class="field"><label>Deadline</label><input type="date" name="due_date" value="${esc(t.due_date || '')}"></div>
        <div class="field"><label>Prioriteit</label><select name="priority">${opt('laag', 'Laag', t.priority)}${opt('normaal', 'Normaal', t.priority || 'normaal')}${opt('hoog', 'Hoog', t.priority)}</select></div>
        <div class="field"><label>Toegewezen aan</label><select name="assigned_to">${userOptions(t.assigned_to || state.user.id)}</select></div></div>
      <input type="hidden" name="donor_id" value="${esc(t.donor_id || '')}">
      ${t.id ? `<label class="check"><input type="checkbox" name="done" ${t.status === 'afgerond' ? 'checked' : ''}> Afgerond</label>` : ''}`,
    onSubmit: async (f) => {
      const body = { ...f, donor_id: f.donor_id || null, assigned_to: f.assigned_to || null };
      if (t.id) body.status = f.done ? 'afgerond' : 'open';
      delete body.done;
      await api(t.id ? `/api/admin/tasks/${t.id}` : '/api/admin/tasks', { method: t.id ? 'PUT' : 'POST', body });
      toast('Taak opgeslagen'); refreshNavCounts(); done();
    },
  });
}

async function renderTasks() {
  view().innerHTML = `
    <div class="page-head"><div><h1>Taken</h1><div class="sub">Opvolging en to-do’s van het team</div></div>
      <div class="toolbar"><select id="f-status">${opt('open', 'Open', 'open')}${opt('afgerond', 'Afgerond')}${opt('', 'Alle')}</select>
        <label class="check" style="margin:0"><input type="checkbox" id="f-mine"> Alleen mijn taken</label>
        ${btn('new', 'Nieuwe taak', { icon: 'plus', kind: 'primary' })}</div></div>
    <div class="card flush"><div id="tbl">${RF.skeleton('rows')}</div></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/tasks?status=${$('#f-status').value}&mine=${$('#f-mine').checked ? 1 : 0}`);
    $('#tbl').innerHTML = table([
      { label: '', render: (t) => `<input type="checkbox" data-done="${t.id}" ${t.status === 'afgerond' ? 'checked' : ''} aria-label="Afronden">` },
      { label: 'Taak', render: (t) => `<span style="font-weight:500;${t.status === 'afgerond' ? 'text-decoration:line-through;color:var(--text-3)' : ''}">${esc(t.title)}</span>${t.description ? `<span class="sub">${esc(t.description)}</span>` : ''}` },
      { label: 'Donateur', render: (t) => (t.donor_id ? donorLink(t.donor_id, t.donor_name) : '<span class="muted">—</span>') },
      { label: 'Deadline', render: (t) => (t.status === 'open' && t.due_date && t.due_date < today() ? `<span class="badge badge-hoog">${date(t.due_date)}</span>` : `<span class="muted">${date(t.due_date) || '—'}</span>`) },
      { label: 'Prioriteit', render: (t) => `<span class="badge badge-${esc(t.priority)}">${esc(t.priority.charAt(0).toUpperCase() + t.priority.slice(1))}</span>` },
      { label: 'Toegewezen', render: (t) => (t.assigned_name ? `<div class="cell-person">${RF.avatar(t.assigned_name, 'sm')}<span>${esc(t.assigned_name)}</span></div>` : '<span class="muted">—</span>') },
      { label: '', render: (t) => `<button class="icon-btn" data-del="${t.id}" title="Verwijderen" aria-label="Taak verwijderen">${RF.icon('trash-2')}</button>` },
    ], rows, { empty: 'Geen taken in deze selectie', emptyIcon: 'check-check', onRow: true });
    bindRows($('#tbl'), rows, (t) => taskForm(t, load));
    $('#tbl').querySelectorAll('[data-done]').forEach((cb) => cb.addEventListener('change', async () => {
      await api(`/api/admin/tasks/${cb.dataset.done}`, { method: 'PUT', body: { status: cb.checked ? 'afgerond' : 'open' } });
      refreshNavCounts(); load();
    }));
    $('#tbl').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Taak verwijderen?', 'Verwijderen'))) return;
      await api(`/api/admin/tasks/${b.dataset.del}`, { method: 'DELETE', body: {} }); refreshNavCounts(); load();
    }));
  };
  $('#f-status').onchange = load;
  $('#f-mine').onchange = load;
  $('#new').onclick = () => taskForm({}, load);
  await load();
}

// ======================================================================= CAMPAGNES
async function renderCampaigns() {
  const rows = await api('/api/admin/campaigns');
  state.campaigns = rows;
  view().innerHTML = `
    ${pageHead('Campagnes', { sub: 'Acties met een doel, zichtbaar in het donateursportaal', actions: btn('new', 'Nieuwe campagne', { icon: 'plus', kind: 'primary' }) })}
    <div class="grid grid-2">${rows.map((c) => {
      const pct = c.goal_cents ? Math.min(100, (c.raised_cents / c.goal_cents) * 100) : 0;
      return `<div class="card" data-c="${c.id}" style="cursor:pointer;${c.active ? '' : 'opacity:.6'}" tabindex="0">
        <div style="display:flex;align-items:flex-start;gap:12px">
          ${c.category_key ? RF.catIcon({ key: c.category_key }, 'lg') : `<span class="cat-ico lg">${RF.icon('megaphone')}</span>`}
          <div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3 style="margin:0">${esc(c.name)}</h3>${c.active ? badge('donor', 'actief') : badge('donor', 'inactief')}</div>
          <div class="small muted" style="margin-top:2px">${c.category_name ? `${esc(c.category_name)} · ` : ''}${date(c.start_date)} – ${date(c.end_date) || 'doorlopend'}</div></div></div>
        <p class="small" style="color:var(--text-2);margin:12px 0 16px">${esc(c.description)}</p>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px"><span style="font-size:20px;font-weight:600;letter-spacing:-.02em" class="num">${euro0(c.raised_cents)}</span>
          <span class="small muted">${Math.round(pct)}% van ${euro0(c.goal_cents)}</span></div>
        <div class="meter"><span style="width:${pct}%"></span></div>
        <div class="small muted" style="margin-top:8px">${c.donor_count} ${c.donor_count === 1 ? 'donateur' : 'donateurs'}</div></div>`;
    }).join('') || `<div class="card" style="grid-column:1/-1">${RF.emptyState({ icon: 'megaphone', title: 'Nog geen campagnes', text: 'Start een actie met een doelbedrag, bijvoorbeeld voor noodhulp na een orkaan.' })}</div>`}</div>`;
  const form = (c = {}) => modal({
    title: c.id ? 'Campagne bewerken' : 'Nieuwe campagne',
    body: `<div class="field"><label>Naam</label><input type="text" name="name" required value="${esc(c.name || '')}"></div>
      <div class="field"><label>Omschrijving</label><textarea name="description">${esc(c.description || '')}</textarea></div>
      <div class="field-row"><div class="field"><label>Bestemming</label><select name="category_key">${opt('', '— alle —', c.category_key)}${catOptions(c.category_key)}</select></div>
        <div class="field"><label>Doel (€)</label><input type="text" name="goal" value="${c.goal_cents ? centsToInput(c.goal_cents) : ''}"></div></div>
      <div class="field-row"><div class="field"><label>Start</label><input type="date" name="start_date" value="${esc(c.start_date || today())}"></div>
        <div class="field"><label>Einde</label><input type="date" name="end_date" value="${esc(c.end_date || '')}"></div></div>
      <label class="check"><input type="checkbox" name="active" ${c.active ?? 1 ? 'checked' : ''}> Actief (zichtbaar in donateursportaal)</label>`,
    onSubmit: async (f) => {
      const body = { ...f, goal_cents: f.goal ? toCents(f.goal) : 0 };
      await api(c.id ? `/api/admin/campaigns/${c.id}` : '/api/admin/campaigns', { method: c.id ? 'PUT' : 'POST', body });
      toast('Campagne opgeslagen'); renderCampaigns();
    },
  });
  $('#new').onclick = () => form();
  view().querySelectorAll('[data-c]').forEach((el) => el.addEventListener('click', () => form(rows.find((c) => c.id === Number(el.dataset.c)))));
}

// ======================================================================= LEADERBOARD
async function renderLeaderboard() {
  view().innerHTML = `
    <div class="page-head"><div><h1>Leaderboard</h1><div class="sub">Intern overzicht met echte namen</div></div>
      <div class="toolbar"><select id="f-period">${opt('all', 'Altijd')}${opt('year', 'Dit jaar')}${opt('month', 'Deze maand')}</select>
        <select id="f-cat">${catOptions('', true)}</select><a class="btn btn-ghost" href="/leaderboard" target="_blank" rel="noopener">${RF.icon('arrow-up-right')}<span>Publieke versie</span></a></div></div>
    <div class="callout neutral">${RF.icon('info')}<span>Op het publieke leaderboard en in het portaal zien bezoekers alleen de publieke naam. Anonieme donateurs verschijnen als “Anonieme donateur”.</span></div>
    <div class="card flush"><div id="tbl">${RF.skeleton('rows')}</div></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/leaderboard?period=${$('#f-period').value}&category=${$('#f-cat').value}&limit=100`);
    $('#tbl').innerHTML = table([
      { label: '#', render: (r) => (r.rank <= 3 ? `<span class="medal m${r.rank}" style="display:inline-grid;place-items:center;width:24px;height:24px;border-radius:99px;font-size:12px;font-weight:700">${r.rank}</span>` : `<span class="muted num" style="display:inline-block;width:24px;text-align:center">${r.rank}</span>`) },
      { label: 'Donateur', render: (r) => `<div class="cell-person">${RF.avatar(r.full_name, 'sm')}${donorLink(r.donor_id, r.full_name)}</div>` },
      { label: 'Publiek zichtbaar als', render: (r) => (r.anonymous ? `<span class="muted" style="display:inline-flex;align-items:center;gap:6px">${RF.icon('eye-off', 'icon-sm')}Anonieme donateur</span>` : esc(r.name)) },
      { label: 'Giften', num: true, render: (r) => `<span class="muted">${r.donation_count}</span>` },
      { label: 'Besteed', num: true, render: (r) => `<span class="muted">${euro(r.spent_cents)}</span>` },
      { label: 'Totaal', num: true, render: (r) => `<b style="font-weight:600">${euro(r.total_cents)}</b>` },
    ], rows, { empty: 'Nog geen donaties in deze periode', emptyIcon: 'trophy' });
  };
  $('#f-period').onchange = load;
  $('#f-cat').onchange = load;
  await load();
}

// ======================================================================= RAPPORTAGES
async function renderReports(year) {
  const r = await api(`/api/admin/reports${year ? `?year=${year}` : ''}`);
  const max = Math.max(1, ...r.byCategory.map((c) => c.raised_cents));
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const bm = Object.fromEntries(r.byMonth.map((m) => [m.m, m.cents]));
  const ret = r.retention.last_year ? Math.round((r.retention.retained / r.retention.last_year) * 100) : null;
  const hbars = (rows, keyLabel, fmt) => {
    const mx = Math.max(1, ...rows.map((x) => x.cents));
    return rows.map((x) => `<div class="hbar"><span>${esc(fmt(x[keyLabel]))}</span><div class="bar"><span style="width:${(x.cents / mx) * 100}%"></span></div><span class="right">${euro0(x.cents)}</span></div>`).join('') || '<p class="muted">Geen data</p>';
  };
  view().innerHTML = `
    <div class="page-head"><div><h1>Rapportages ${esc(r.year)}</h1><div class="sub">Opbrengst, bestedingen en donateursgedrag per jaar</div></div>
      <div class="toolbar"><select id="f-year">${(r.years.length ? r.years : [r.year]).map((y) => opt(y, y, r.year)).join('')}</select>
        <button class="btn btn-ghost" onclick="window.print()">${RF.icon('printer')}<span>Afdrukken</span></button>
        <a class="btn btn-ghost" href="/api/admin/donations?from=${r.year}-01-01&to=${r.year}-12-31&format=csv">${RF.icon('download')}<span>Donaties ${esc(r.year)}</span></a></div></div>
    <div class="kpis">
      <div class="kpi"><div class="label">${RF.icon('banknote')}Opgehaald</div><div class="value">${euro0(r.totals.raised_cents)}</div><div class="sub">${r.totals.donations} giften</div></div>
      <div class="kpi"><div class="label">${RF.icon('hand-coins')}Besteed</div><div class="value">${euro0(r.spent.cents)}</div><div class="sub">${r.spent.n} bestedingen</div></div>
      <div class="kpi"><div class="label">${RF.icon('users')}Unieke donateurs</div><div class="value">${r.totals.donors}</div><div class="sub">Gemiddelde gift ${euro(r.totals.avg_cents)}</div></div>
      <div class="kpi"><div class="label">${RF.icon('repeat')}Donateursbehoud</div><div class="value">${ret == null ? '—' : `${ret}%`}</div><div class="sub">${r.retention.retained} van ${r.retention.last_year} van vorig jaar</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Per maand</h2><span class="small muted">Ontvangen giften</span></div>${RF.barChart(months.map(RF.monthName), [{ label: 'Ontvangen', values: months.map((m) => bm[m] || 0), color: 'var(--accent)' }])}</div>
      <div class="card"><div class="card-head"><h2>Per bestemming</h2><span class="small muted">Ontvangen · besteed</span></div>
        ${r.byCategory.map((c) => `<div style="margin-bottom:16px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">${RF.catLabel(c, c.name)}<span class="num small"><b style="font-weight:600">${euro0(c.raised_cents)}</b> <span class="muted">· ${euro0(c.spent_cents)}</span></span></div>
          <div class="meter"><span style="width:${(c.raised_cents / max) * 100}%;background:${RF.catColor(c)}"></span></div>
          ${c.units ? `<div class="small muted" style="margin-top:6px">${num(c.units)} ${esc(c.unit_label_plural)} gefinancierd</div>` : ''}</div>`).join('')}</div>
      <div class="card"><div class="card-head"><h2>Betaalwijze</h2></div>${hbars(r.byMethod, 'method', (k) => label('method', k))}</div>
      <div class="card"><div class="card-head"><h2>Frequentie en type</h2></div>${hbars(r.byFrequency, 'frequency', (k) => label('frequency', k))}
        <hr>${hbars(r.byType, 'donor_type', (k) => label('type', k))}</div>
      <div class="card flush"><div class="card-head"><h2>Top 10 donateurs ${esc(r.year)}</h2></div>${table([
        { label: '#', render: (x) => `<span class="muted num">${x.rank}</span>` }, { label: 'Donateur', render: (x) => `<div class="cell-person">${RF.avatar(x.full_name, 'sm')}${donorLink(x.donor_id, x.full_name)}</div>` },
        { label: 'Totaal', num: true, render: (x) => `<b style="font-weight:600">${euro(x.total_cents)}</b>` }], r.topDonors, { empty: 'Geen donaties dit jaar', emptyIcon: 'trophy' })}</div>
      <div class="card"><div class="card-head"><h2>Impactberichten</h2></div>
        <div style="display:flex;align-items:baseline;gap:8px"><span style="font-size:28px;font-weight:600;letter-spacing:-.02em" class="num">${r.messageStats.delivered ? Math.round((r.messageStats.read / r.messageStats.delivered) * 100) : 0}%</span><span class="muted">gelezen</span></div>
        <div class="meter" style="margin:10px 0"><span style="width:${r.messageStats.delivered ? (r.messageStats.read / r.messageStats.delivered) * 100 : 0}%"></span></div>
        <p class="small muted" style="margin:0">${num(r.messageStats.read)} van ${num(r.messageStats.delivered)} brieven, foto’s en filmpjes zijn geopend door donateurs.</p></div>
    </div>`;
  $('#f-year').onchange = (e) => renderReports(e.target.value);
}

// ======================================================================= E-MAIL LOG
async function renderOutbox() {
  view().innerHTML = `<div class="page-head"><div><h1>E-mail log</h1><div class="sub">Alle e-mails die het systeem naar donateurs stuurt</div></div>
      <div class="toolbar"><select id="f-kind">${opt('', 'Alle soorten')}${['bedankt', 'besteding', 'impactbericht', 'portaal'].map((k) => opt(k, k)).join('')}</select></div></div>
    <div class="callout neutral">${RF.icon('info')}<span>Zonder e-mailkoppeling worden berichten alleen hier gelogd. Koppel Brevo bij <a href="#/instellingen">Instellingen → Integraties</a> om ze echt te versturen.</span></div>
    <div class="card flush"><div id="tbl">${RF.skeleton('rows')}</div></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/outbox?kind=${$('#f-kind').value}`);
    $('#tbl').innerHTML = rows.length ? rows.map((m) => `<details style="border-top:1px solid var(--border);padding:12px 20px">
      <summary style="gap:10px"><span class="cat-ico sm" style="--c:var(--text-3)">${RF.icon('mail')}</span><span style="min-width:0;flex:1"><span style="color:var(--text);font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.subject)}</span>
        <span class="small muted">${esc(m.to_email)} · ${esc(m.kind)}${m.status === 'verzonden' ? ' · <span style="color:var(--ok)">verzonden</span>' : m.status === 'mislukt' ? ` · <span style="color:var(--bad)" title="${esc(m.error)}">mislukt</span>` : ''}</span></span><span class="small muted" style="white-space:nowrap">${dateTime(m.created_at)}</span></summary>
      <p class="small" style="white-space:pre-line;margin:10px 0 0 32px;color:var(--text-2)">${esc(m.body)}</p></details>`).join('').replace('border-top:1px solid var(--border);', '')
      : RF.emptyState({ icon: 'mail', title: 'Geen e-mails' });
  };
  $('#f-kind').onchange = load;
  await load();
}

// ======================================================================= LIVEGANG & INTEGRATIES
async function renderGoLive() {
  const g = await api('/api/admin/golive');
  const step = (ok, title, text, action = '') => `<div class="list-row" style="align-items:flex-start">
    <span style="color:var(--${ok ? 'ok' : 'text-4'});margin-top:2px">${RF.icon(ok ? 'circle-check' : 'circle')}</span>
    <div class="grow"><div class="title" style="white-space:normal">${title}</div><div class="meta" style="white-space:normal">${text}</div></div>${ok ? '' : action}</div>`;
  const done = [!g.weak_password && !g.weak_users.length, !g.demo, g.moderation, g.payments, g.email].filter(Boolean).length;
  $('#golive-card').innerHTML = `<div class="card-head"><div><h2>Klaar voor livegang</h2><div class="small muted">${done} van 5 stappen gedaan</div></div>
      <div class="meter" style="width:140px"><span style="width:${(done / 5) * 100}%"></span></div></div>
    <div class="list">
      ${step(!g.weak_password && !g.weak_users.length, 'Sterke wachtwoorden', g.weak_users.length ? `Zwak of demo-wachtwoord bij: ${g.weak_users.map(esc).join(', ')}` : 'Alle actieve gebruikers hebben een eigen wachtwoord.',
        g.weak_password ? `<button class="btn btn-sm btn-ghost" data-act="pw">Wijzigen</button>` : '')}
      ${step(!g.demo, 'Demodata verwijderd', g.demo ? `Nu: ${g.counts.donors} donateurs, ${g.counts.donations} donaties, ${g.counts.recipients} ontvangers en ${g.counts.users} gebruikers (voorbeeld). Wis ze vóór je echte gegevens invoert.` : 'Er staan geen demo-accounts of voorbeelddonateurs meer in.',
        `<button class="btn btn-sm btn-danger" data-act="wipe">Demodata wissen…</button>`)}
      ${step(g.moderation, 'Chatmoderatie aan', g.moderation ? 'Berichten met kinderen worden eerst gecontroleerd.' : 'Staat uit: berichten met kinderen worden direct afgeleverd.', '<a class="btn btn-sm btn-ghost" href="#/chat">Aanzetten</a>')}
      ${step(g.payments, 'Echte betalingen (Mollie)', g.payments ? 'Donaties worden via Mollie betaald.' : 'Doneren in het portaal is nog een demo. Vul hieronder je Mollie-sleutel in.')}
      ${step(g.email, 'Echte e-mails (Brevo)', g.email ? 'Bedankjes en meldingen worden echt verstuurd.' : 'E-mails worden nu alleen gelogd. Vul hieronder je Brevo-sleutel in.')}
      ${step(true, '“Inloggen als” is alleen-lezen', 'Medewerkers kunnen meekijken, maar niets doen namens een donateur of ontvanger.')}
    </div>`;
  const pw = $('#golive-card [data-act=pw]'); if (pw) pw.onclick = changeOwnPassword;
  $('#golive-card [data-act=wipe]').onclick = () => modal({
    title: 'Alle demodata wissen', submitLabel: 'Definitief wissen',
    body: `<div class="callout warn" style="font-weight:400">${RF.icon('triangle-alert')}<span>Dit verwijdert <b>alle</b> donateurs, donaties, cellen, bestedingen, ontvangers, berichten, chats, taken, campagnes, de e-mail log en alle andere gebruikers. Alleen jouw account, de bestemmingen en de instellingen (sleutels) blijven. Dit kan niet ongedaan worden gemaakt.</span></div>
      <p class="small muted">Voorwaarden: je hebt een eigen, sterk wachtwoord en je inlognaam is je e-mailadres (niet “robin”).</p>
      <div class="field"><label>Typ <b>VERWIJDER</b> om te bevestigen</label><input type="text" name="confirm" autocomplete="off" autocapitalize="characters"></div>`,
    onSubmit: async (f) => {
      await api('/api/admin/demo/wipe', { method: 'POST', body: f });
      toast('Demodata gewist. De CRM is klaar voor echte gegevens.');
      await loadLookups(); renderSettings();
    },
  });
}

async function renderIntegrations() {
  const st = await api('/api/admin/integrations');
  const p = st.payments; const m = st.email;
  const src = (x) => (x.key_source === 'render' ? ' (ingesteld in Render)' : '');
  $('#int-card').innerHTML = `<div class="card-head"><div><h2>Integraties</h2><div class="small muted">Echte betalingen en e-mail. Sleutels worden nooit volledig getoond.</div></div></div>
    <form id="int-form">
      <section class="form-section"><h3 style="display:flex;align-items:center;gap:8px">${RF.icon('wallet')}Betalingen via Mollie
        ${p.enabled ? `<span class="badge badge-actief" style="margin-left:auto">${p.mode === 'live' ? 'Live' : 'Testmodus'} · ${esc(p.key_hint)}${src(p)}</span>` : '<span class="badge" style="margin-left:auto">Demo (niet gekoppeld)</span>'}</h3>
        <div class="field"><label>Mollie API-sleutel</label><input type="password" name="mollie_api_key" placeholder="${p.key_set ? 'Ingesteld · plak een nieuwe om te vervangen' : 'test_… of live_…'}" autocomplete="off" autocapitalize="none" spellcheck="false">
          <div class="hint">Maak een account op <b>mollie.com</b> → Ontwikkelaars → API-sleutels. Begin met de <b>test_</b>-sleutel; met <b>live_</b> wordt er echt betaald.
          Periodieke giften (maandelijks e.d.) worden automatisch een Mollie-abonnement.</div></div>
        <div class="toolbar">${btn('test-mollie', 'Sleutel testen', { icon: 'zap', size: 'sm' })}${p.key_source === 'crm' ? btn('rm-mollie', 'Ontkoppelen', { size: 'sm', kind: 'quiet' }) : ''}<span class="small" id="mollie-result"></span></div>
      </section>
      <section class="form-section"><h3 style="display:flex;align-items:center;gap:8px">${RF.icon('mail')}E-mail via Brevo
        ${m.enabled ? `<span class="badge badge-actief" style="margin-left:auto">Verstuurt · ${esc(m.key_hint)}${src(m)}</span>` : '<span class="badge" style="margin-left:auto">Alleen loggen</span>'}</h3>
        <div class="field"><label>Brevo API-sleutel</label><input type="password" name="mail_api_key" placeholder="${m.key_set ? 'Ingesteld · plak een nieuwe om te vervangen' : 'xkeysib-…'}" autocomplete="off" autocapitalize="none" spellcheck="false">
          <div class="hint">Maak een (gratis) account op <b>brevo.com</b> → SMTP &amp; API → API Keys. Bevestig daar ook je afzenderadres of domein.</div></div>
        <div class="field-row">
          <div class="field"><label>Afzenderadres</label><input type="text" name="mail_from_email" value="${esc(m.from_email)}" placeholder="info@robinfoundation.org" autocapitalize="none"></div>
          <div class="field"><label>Afzendernaam</label><input type="text" name="mail_from_name" value="${esc(m.from_name)}"></div>
        </div>
        <div class="toolbar"><input type="text" id="test-to" placeholder="Stuur testmail naar…" style="width:auto;min-width:220px;height:28px;font-size:13px" autocapitalize="none">${btn('test-mail', 'Testmail sturen', { icon: 'send', size: 'sm' })}${m.key_source === 'crm' ? btn('rm-mail', 'Ontkoppelen', { size: 'sm', kind: 'quiet' }) : ''}<span class="small" id="mail-result"></span></div>
      </section>
      <div class="toolbar" style="justify-content:flex-end;margin-top:6px"><button class="btn btn-primary" type="submit">Opslaan</button></div>
    </form>`;
  const result = (sel, ok, text) => { $(sel).innerHTML = `<span style="color:var(--${ok ? 'ok' : 'bad'})">${esc(text)}</span>`; };
  $('#int-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = RF.formData(e.target);
    try { await api('/api/admin/integrations', { method: 'PUT', body: f }); toast('Integraties opgeslagen'); renderIntegrations(); renderGoLive(); }
    catch (ex) { toast(ex.message, 'error'); }
  };
  $('#test-mollie').onclick = async () => {
    const r = await api('/api/admin/integrations/test-mollie', { method: 'POST', body: {} });
    result('#mollie-result', r.ok, r.ok ? `Werkt (${r.mode === 'live' ? 'live' : 'test'}): ${(r.methods || []).slice(0, 4).join(', ') || 'geen betaalmethoden actief'}` : r.error);
  };
  $('#test-mail').onclick = async () => {
    try { const r = await api('/api/admin/integrations/test-mail', { method: 'POST', body: { to: $('#test-to').value } }); result('#mail-result', r.ok, r.ok ? 'Verstuurd! Kijk in je inbox.' : r.error); }
    catch (ex) { result('#mail-result', false, ex.message); }
  };
  const rm = (sel, body) => { const b = $(sel); if (b) b.onclick = async () => { await api('/api/admin/integrations', { method: 'PUT', body }); renderIntegrations(); renderGoLive(); }; };
  rm('#rm-mollie', { remove_mollie: true });
  rm('#rm-mail', { remove_mail: true });
}

// ======================================================================= INSTELLINGEN
async function renderSettings() {
  await loadLookups();
  view().innerHTML = `
    <div class="page-head"><div><h1>Instellingen</h1><div class="sub">Sponsorbedrag, gebruikers, vertalen en beveiliging</div></div></div>
    <div class="stack" style="max-width:980px">
    ${isAdmin() ? '<div class="card" id="golive-card"></div><div class="card" id="int-card"></div>' : ''}
    ${isAdmin() ? `<div class="card" id="tr-card"><div class="card-head"><h2 style="display:flex;align-items:center;gap:8px">${RF.icon('languages')}Automatisch vertalen</h2>
      ${btn('tr-test', 'Proefvertaling', { icon: 'zap', size: 'sm' })}</div><div id="tr-status"><p class="muted small">Laden…</p></div></div>` : ''}
    <div class="card" id="sponsor-cfg-card"></div>
    <div class="card flush"><div class="card-head"><h2>Gebruikers</h2>${isAdmin() ? btn('new-user', 'Gebruiker', { icon: 'plus', size: 'sm' }) : ''}</div>
      ${table([
        { label: 'Naam', render: (u) => `<div class="cell-person">${RF.avatar(u.name, 'sm')}<div class="grow"><b>${esc(u.name)}</b><span class="sub">${esc(u.email)}</span></div></div>` },
        { label: 'Rol', render: (u) => (u.role === 'admin' ? '<span class="badge badge-admin">Beheerder</span>' : '<span class="muted">Medewerker</span>') },
        { label: 'Status', render: (u) => (u.active ? badge('donor', 'actief') : badge('donor', 'inactief')) },
        { label: '', render: (u) => (isAdmin() ? `<button class="icon-btn" data-user="${u.id}" aria-label="Bewerken" title="Bewerken">${RF.icon('pencil')}</button>` : '') },
      ], state.users)}</div>
    ${isAdmin() ? `<div class="card flush"><div class="card-head" style="padding-bottom:14px"><div><h2>Audit log</h2><div class="small muted">Wie deed wat, en wanneer</div></div>${btn('show-audit', 'Tonen', { icon: 'eye', size: 'sm' })}</div><div id="audit"></div></div>` : ''}
    </div>`;

  view().querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    const c = state.categories.find((x) => x.key === b.dataset.cat);
    modal({
      title: `Bestemming: ${c.name}`,
      body: `<div class="field-row"><div class="field"><label>Naam</label><input type="text" name="name" value="${esc(c.name)}"></div>
          <div class="field"><label>Icoon</label><input type="text" name="icon" value="${esc(c.icon)}"></div>
          <div class="field"><label>Kleur</label><input type="text" name="color" value="${esc(c.color)}" pattern="#[0-9a-fA-F]{6}"></div></div>
        <div class="field"><label>Omschrijving</label><textarea name="description">${esc(c.description)}</textarea></div>
        <div class="field-row"><div class="field"><label>Eenheid (enkelvoud)</label><input type="text" name="unit_label" value="${esc(c.unit_label)}"></div>
          <div class="field"><label>Eenheid (meervoud)</label><input type="text" name="unit_label_plural" value="${esc(c.unit_label_plural)}"></div>
          <div class="field"><label>Prijs per eenheid (€)</label><input type="text" name="cost" value="${c.unit_cost_cents ? centsToInput(c.unit_cost_cents) : ''}" placeholder="leeg = vrij bedrag"></div></div>
        <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Actief (kan op gedoneerd worden)</label>`,
      onSubmit: async (f) => {
        await api(`/api/admin/categories/${c.key}`, { method: 'PUT', body: { ...f, unit_cost_cents: f.cost ? toCents(f.cost) : null } });
        toast('Bestemming opgeslagen'); renderSettings();
      },
    });
  }));
  if (isAdmin()) {
    const line = (ok, okText, badText) => `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px"><span style="color:var(--${ok ? 'ok' : 'bad'});margin-top:1px">${RF.icon(ok ? 'circle-check' : 'circle-x')}</span><span>${ok ? okText : badText}</span></div>`;
    const showStatus = (st) => {
      $('#tr-status').innerHTML = `
        ${line(st.sdk_installed, 'Vertaalpakket is geïnstalleerd', 'Vertaalpakket ontbreekt → zet in Render het <b>Build Command</b> op <code>npm install</code> en deploy opnieuw')}
        ${st.key_problem ? '' : line(st.api_key_set, `API-sleutel is ingesteld ${st.key_source === 'render' ? 'in Render' : 'hier in het CRM'} (<code>${esc(st.key_hint)}</code>)`, 'API-sleutel ontbreekt → vul hem hieronder in')}
        ${st.key_problem ? `<div class="form-error" style="margin:6px 0">${esc(st.key_problem)} ${st.key_source === 'render'
          ? 'Pas in Render bij <b>Environment</b> de waarde van <code>ANTHROPIC_API_KEY</code> aan (of verwijder hem en vul de sleutel hieronder in).'
          : 'Plak hieronder een nieuwe sleutel.'}</div>` : ''}
        ${st.api_key_has_spaces ? '<div class="callout warn">De API-sleutel begint of eindigt met een spatie: verwijder die in Render.</div>' : ''}
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="muted">${RF.icon('sparkles')}</span><span>Model: <code>${esc(st.model)}</code>${st.model_from_env ? ' (ingesteld in Render)' : ''}</span></div>
        ${st.lookalikes && st.lookalikes.length ? `<div class="callout warn" style="display:block">Gevonden variabelen met een <b>bijna</b> goede naam: ${st.lookalikes.map((k) => `<code>${esc(k)}</code>`).join(', ')}
          → hernoem ze precies naar <code>ANTHROPIC_API_KEY</code> en <code>CRM_TRANSLATE_MODEL</code>.</div>` : ''}
        <div class="small muted" style="margin-top:8px">Deze app draait als Render-service: <b>${esc(st.service || 'onbekend')}</b>${st.url ? ` (${esc(st.url)})` : ''}${st.commit ? ` · versie ${esc(st.commit)}` : ''}.
          </div>
        <form id="tr-form" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
          <div class="field"><label>Anthropic API-sleutel ${st.key_source === 'render' ? '<span class="muted">(Render-instelling gaat voor)</span>' : ''}</label>
            <input type="password" name="api_key" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
              placeholder="${st.api_key_set ? 'Ingesteld — plak een nieuwe sleutel om te vervangen' : 'sk-ant-…'}">
            <div class="hint">Maak een sleutel op <b>console.anthropic.com → API Keys</b> en plak hem hier. Hij wordt daarna nooit meer volledig getoond.</div></div>
          <div class="field"><label>Workspace-ID <span class="muted">(alleen nodig bij een persoonlijke sleutel, sk-ant-usr-…)</span></label>
            <input type="text" name="workspace" value="${esc(st.workspace || '')}" placeholder="wrkspc_…" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
            <div class="hint">Te vinden op <b>platform.claude.com → Settings → Workspaces</b>, kolom <b>ID</b>. Laat leeg als je sleutel bij één workspace hoort.</div></div>
          <div class="field"><label>Model</label><select name="model">
            ${Object.entries(st.models || {}).map(([k, v]) => `<option value="${esc(k)}" ${k === st.model ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          <div class="toolbar"><button class="btn btn-primary">Opslaan</button>
            ${st.key_source === 'crm' ? '<button type="button" class="btn btn-danger btn-sm" id="tr-remove">Sleutel verwijderen</button>' : ''}</div>
          <p class="hint" style="margin-top:8px">Op het gratis Render-abonnement wordt de database bij elke nieuwe versie gewist; vul de sleutel daarna opnieuw in
            (of zet hem in Render bij Environment als <code>ANTHROPIC_API_KEY</code>, dan blijft hij bewaard).</p>
        </form>`;
      $('#tr-form').onsubmit = async (e) => {
        e.preventDefault();
        const f = RF.formData(e.target);
        try {
          const st2 = await api('/api/admin/translation/settings', { method: 'PUT', body: { api_key: f.api_key, model: f.model, workspace: f.workspace } });
          showStatus(st2);
          toast('Opgeslagen — tik op Proefvertaling om te testen');
        } catch (ex) { toast(ex.message, 'error'); }
      };
      const rm = $('#tr-remove');
      if (rm) rm.onclick = async () => {
        if (!(await confirmDialog('De API-sleutel uit het CRM verwijderen? Vertalen stopt dan.', 'Verwijderen'))) return;
        showStatus(await api('/api/admin/translation/settings', { method: 'PUT', body: { remove_key: true } }));
      };
    };
    api('/api/admin/translation/status').then(showStatus).catch((e) => { $('#tr-status').textContent = e.message; });
    $('#tr-test').onclick = async () => {
      $('#tr-test').disabled = true;
      $('#tr-status').innerHTML = 'Bezig met proefvertaling…';
      try {
        const r = await api('/api/admin/translation/test', { method: 'POST', body: {} });
        showStatus(r);
        $('#tr-status').insertAdjacentHTML('afterbegin', r.ok
          ? `<div style="margin:0 0 10px" class="callout ok" style="display:block;margin:0 0 12px">Het werkt! (${r.ms} ms)<br><span class="small">“${esc(r.input)}” (${esc(r.source_language)})<br>→ “${esc(r.output)}”</span></div>`
          : `<div class="form-error" style="margin:0 0 12px">${esc(r.error)}${r.detail ? `<br><span class="small">${esc(r.detail)}</span>` : ''}</div>`);
      } catch (e) { $('#tr-status').textContent = e.message; }
      finally { $('#tr-test').disabled = false; }
    };
  }
  const userForm = (u = {}) => modal({
    title: u.id ? 'Gebruiker bewerken' : 'Nieuwe gebruiker',
    body: `<div class="field"><label>Naam</label><input type="text" name="name" value="${esc(u.name || '')}" required></div>
      <div class="field"><label>Inlognaam (e-mailadres)</label><input type="text" name="email" value="${esc(u.email || '')}" required autocapitalize="none" autocorrect="off" spellcheck="false"></div>
      <div class="field"><label>Rol</label><select name="role">${opt('medewerker', 'Medewerker', u.role)}${opt('admin', 'Beheerder', u.role)}</select></div>
      <div class="field"><label>${u.id ? 'Nieuw wachtwoord (optioneel)' : 'Wachtwoord'}</label><input type="password" name="password" ${u.id ? '' : 'required'} minlength="10" autocomplete="new-password">
        <div class="hint">Minimaal 10 tekens. Een korte zin van een paar woorden is sterk en goed te onthouden.</div></div>
      ${u.id ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Actief</label>` : ''}`,
    onSubmit: async (f) => {
      if (u.id && !f.password) delete f.password;
      await api(u.id ? `/api/admin/users/${u.id}` : '/api/admin/users', { method: u.id ? 'PUT' : 'POST', body: f });
      toast('Gebruiker opgeslagen'); renderSettings();
    },
  });
  if ($('#new-user')) $('#new-user').onclick = () => userForm();
  if (isAdmin()) { renderGoLive(); renderIntegrations(); }
  view().querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', () => userForm(state.users.find((u) => u.id === Number(b.dataset.user)))));
  if ($('#show-audit')) $('#show-audit').onclick = async () => {
    const rows = await api('/api/admin/audit');
    $('#audit').innerHTML = table([
      { label: 'Tijd', render: (a) => dateTime(a.created_at) }, { label: 'Wie', key: 'actor' }, { label: 'Actie', key: 'action' },
      { label: 'Object', render: (a) => `${esc(a.entity)} ${a.entity_id ? `#${a.entity_id}` : ''}` },
      { label: 'Details', render: (a) => `<span class="small muted">${esc(a.details).slice(0, 120)}</span>` },
    ], rows);
  };
}

boot();

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

async function showApp() {
  $('#app').classList.remove('hidden');
  $('#me').innerHTML = `<div><b>${esc(state.user.name)}</b></div><div class="muted">${esc(state.user.email)}</div>
    <div><span class="badge badge-admin">${state.user.role === 'admin' ? 'Beheerder' : 'Medewerker'}</span></div>
    <button class="btn btn-ghost btn-sm" id="logout">Uitloggen</button>`;
  $('#logout').onclick = async () => { await api('/api/staff/logout', { method: 'POST', body: {} }); location.replace('/login?rol=medewerker'); };
  const setMenu = (open) => { $('#sidebar').classList.toggle('open', open); $('#nav-backdrop').classList.toggle('open', open); };
  $('#menu-toggle').onclick = () => setMenu(!$('#sidebar').classList.contains('open'));
  $('#nav-backdrop').onclick = () => setMenu(false);
  await loadLookups();
  window.addEventListener('hashchange', route);
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
    $('#nav-cells').textContent = d.totals.open_cells || '';
    $('#nav-tasks').textContent = d.totals.open_tasks || '';
    $('#nav-chat').textContent = d.totals.pending_chats || '';
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
  const fn = ROUTES[name] || renderDashboard;
  document.querySelectorAll('#nav a[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#sidebar').classList.remove('open');
  $('#nav-backdrop').classList.remove('open');
  view().innerHTML = '<p class="muted">Laden…</p>';
  try {
    await fn(param);
  } catch (err) {
    if (err.status === 401) return showLogin();
    view().innerHTML = `<div class="card"><p class="form-error" style="margin:0">${esc(err.message)}</p></div>`;
  }
  window.scrollTo(0, 0);
}

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ------------------------------------------------------------------ helpers
const opt = (value, text, selected) => `<option value="${esc(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${esc(text)}</option>`;
const catOptions = (sel, withAll = false) => (withAll ? opt('', 'Alle bestemmingen', sel) : '') +
  state.categories.map((c) => opt(c.key, `${c.icon} ${c.name}`, sel)).join('');
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

function table(columns, rows, { empty = 'Geen gegevens', onRow } = {}) {
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((r, i) => `<tr data-i="${i}" class="${onRow ? 'clickable' : ''}">${columns.map((c) =>
      `<td class="${c.num ? 'num' : ''}" data-label="${esc(c.label)}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" class="empty">${esc(empty)}</td></tr>`;
  return `<div class="table-wrap cards"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function bindRows(root, rows, onRow) {
  root.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input')) onRow(rows[Number(tr.dataset.i)]); });
  });
}

// ======================================================================= DASHBOARD
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

  view().innerHTML = `
    <div class="page-head"><h1>Dashboard</h1>
      <div class="toolbar"><button class="btn btn-ghost" id="q-donation">+ Donatie</button><button class="btn btn-primary" id="q-spend">Geld besteden</button></div></div>
    <div class="grid grid-4">
      <div class="card kpi accent"><div class="label">Totaal opgehaald</div><div class="value">${euro0(t.raised_cents)}</div><div class="sub">${euro0(t.raised_ytd_cents)} dit jaar</div></div>
      <div class="card kpi wait"><div class="label">In cellen (wachtend)</div><div class="value">${euro0(t.waiting_cents)}</div><div class="sub">${t.open_cells} open cellen</div></div>
      <div class="card kpi ok"><div class="label">Besteed</div><div class="value">${euro0(t.spent_cents)}</div><div class="sub">${t.expenditures_without_message} bestedingen wachten op bericht</div></div>
      <div class="card kpi"><div class="label">Donateurs</div><div class="value">${num(t.donors)}</div><div class="sub">${t.active_donors} actief · ${t.recurring_donors} terugkerend · +${t.new_donors_30d} (30d)</div></div>
    </div>
    <h2 style="margin:22px 0 10px">Saldo per bestemming</h2>
    <div class="grid grid-4">${d.categories.map(catTile).join('')}</div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Inkomsten vs. bestedingen (12 mnd)</h3></div>
        ${RF.barChart(months.map((m) => RF.monthName(m.slice(5))), [
          { label: 'Ontvangen', values: months.map((m) => byMonth[m] || 0), color: 'var(--robin)' },
          { label: 'Besteed', values: months.map((m) => spentByMonth[m] || 0), color: 'var(--spent)' },
        ])}</div>
      <div class="card"><div class="card-head"><h3>Langst wachtende cellen</h3><a href="#/cellen">Alle cellen →</a></div>
        ${table([
          { label: 'Donateur', render: (r) => donorLink(r.donor_id, r.donor_name) },
          { label: 'Bestemming', render: (r) => `${r.icon} ${esc(r.category_name)}` },
          { label: 'Saldo', num: true, render: (r) => euro(r.remaining_cents) },
          { label: 'Wacht', num: true, render: (r) => `${r.age_days} d` },
        ], d.oldestCells, { empty: 'Alle cellen zijn besteed 🎉' })}</div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Recente donaties</h3><a href="#/donaties">Alles →</a></div>
        ${table([
          { label: 'Datum', render: (r) => date(r.received_at) },
          { label: 'Donateur', render: (r) => donorLink(r.donor_id, r.donor_name) },
          { label: 'Bestemming', render: (r) => `${r.icon} ${esc(r.category_name)}` },
          { label: 'Bedrag', num: true, render: (r) => euro(r.amount_cents) },
        ], d.recent)}</div>
      <div class="card"><div class="card-head"><h3>Openstaande taken ${t.overdue_tasks ? `<span class="badge badge-hoog">${t.overdue_tasks} te laat</span>` : ''}</h3><a href="#/taken">Alles →</a></div>
        ${table([
          { label: 'Taak', render: (r) => `${esc(r.title)}${r.donor_name ? `<div class="small muted">${donorLink(r.donor_id, r.donor_name)}</div>` : ''}` },
          { label: 'Deadline', render: (r) => `<span class="${r.due_date && r.due_date < today() ? 'badge badge-hoog' : ''}">${date(r.due_date) || '—'}</span>` },
          { label: 'Prioriteit', render: (r) => `<span class="badge badge-${esc(r.priority)}">${esc(r.priority)}</span>` },
        ], d.tasks, { empty: 'Geen open taken' })}</div>
    </div>`;
  $('#q-donation').onclick = () => donationForm({}, () => renderDashboard());
  $('#q-spend').onclick = () => spendForm({}, () => renderDashboard());
}

function catTile(c) {
  const units = c.unit_cost_cents ? `${num(c.units_spent)} ${c.unit_label_plural} gefinancierd` : `${euro0(c.spent_cents)} noodhulp verleend`;
  const capacity = c.unit_cost_cents ? ` · ruimte voor ${num(Math.floor(c.waiting_cents / c.unit_cost_cents))} ${c.unit_label_plural}` : '';
  return `<div class="card cat-tile" style="--c:${esc(c.color)}">
    <div class="top"><div class="cat-icon">${esc(c.icon)}</div><div><div class="name">${esc(c.name)}</div>
      <div class="small muted">${c.unit_cost_cents ? `${euro(c.unit_cost_cents)} per ${esc(c.unit_label)}` : 'Vrij bedrag'}</div></div></div>
    ${RF.splitBar(c.spent_cents, c.waiting_cents)}
    <div class="nums"><span>🟢 Besteed ${euro0(c.spent_cents)}</span><span>🟠 In cel ${euro0(c.waiting_cents)}</span></div>
    <div class="small muted">${units}${capacity}</div>
  </div>`;
}

// ======================================================================= DONATEURS
async function renderDonors() {
  const params = new URLSearchParams(sessionStorage.getItem('donorFilters') || '');
  view().innerHTML = `
    <div class="page-head"><h1>Donateurs</h1>
      <div class="toolbar">
        <a class="btn btn-ghost" href="/api/admin/donors/export">⬇ CSV export</a>
        <button class="btn btn-primary" id="new-donor">+ Nieuwe donateur</button></div></div>
    <div class="card">
      <div class="toolbar" style="margin-bottom:12px">
        <input type="search" id="f-q" placeholder="Zoek op naam, e-mail, plaats, telefoon…" value="${esc(params.get('q') || '')}">
        <select id="f-status">${labelOptions('donor', params.get('status') || '', 'Alle statussen')}</select>
        <select id="f-type">${labelOptions('type', params.get('type') || '', 'Alle typen')}</select>
        <input type="search" id="f-tag" placeholder="Tag" value="${esc(params.get('tag') || '')}" style="min-width:120px">
        <select id="f-sort">${opt('name', 'Sorteer: naam', params.get('sort'))}${opt('total', 'Sorteer: totaal gedoneerd', params.get('sort'))}${opt('recent', 'Sorteer: laatste donatie', params.get('sort'))}${opt('created', 'Sorteer: nieuwste', params.get('sort'))}</select>
      </div>
      <div id="donor-table"></div>
    </div>`;
  const load = async () => {
    const p = new URLSearchParams({ q: $('#f-q').value, status: $('#f-status').value, type: $('#f-type').value, tag: $('#f-tag').value, sort: $('#f-sort').value });
    sessionStorage.setItem('donorFilters', p.toString());
    const rows = await api(`/api/admin/donors?${p}`);
    $('#donor-table').innerHTML = `<p class="small muted">${rows.length} donateurs</p>` + table([
      { label: 'Naam', render: (r) => `<div style="display:flex;gap:10px;align-items:center"><div class="avatar" style="width:34px;height:34px;font-size:.8rem">${esc(initials(r.full_name))}</div>
          <div><a href="#/donateurs/${r.id}"><b>${esc(r.full_name)}</b></a>${r.anonymous ? ' <span title="Anoniem op leaderboard">🕶️</span>' : ''}${r.has_portal ? ' <span title="Heeft portaal-account">🔑</span>' : ''}
          <div class="small muted">${esc(r.email || '')}</div></div></div>` },
      { label: 'Type', render: (r) => esc(label('type', r.donor_type)) },
      { label: 'Plaats', key: 'city' },
      { label: 'Status', render: (r) => badge('donor', r.status) },
      { label: 'Tags', render: (r) => tags(r.tags) },
      { label: 'Laatste gift', render: (r) => date(r.last_donation) || '—' },
      { label: 'In cel', num: true, render: (r) => euro(r.waiting_cents) },
      { label: 'Totaal', num: true, render: (r) => `<b>${euro(r.total_cents)}</b>${r.recurring ? ' 🔁' : ''}` },
    ], rows, { empty: 'Geen donateurs gevonden', onRow: true });
    bindRows($('#donor-table'), rows, (r) => go(`#/donateurs/${r.id}`));
  };
  const deb = RF.debounce(load);
  ['#f-q', '#f-tag'].forEach((s) => $(s).addEventListener('input', deb));
  ['#f-status', '#f-type', '#f-sort'].forEach((s) => $(s).addEventListener('change', load));
  $('#new-donor').onclick = () => donorForm({}, (d) => go(`#/donateurs/${d.id}`));
  await load();
}

function donorForm(d, done) {
  const isNew = !d.id;
  modal({
    title: isNew ? 'Nieuwe donateur' : 'Donateur bewerken', wide: true,
    body: `
      <div class="field-row">
        <div class="field"><label>Type</label><select name="donor_type">${labelOptions('type', d.donor_type || 'particulier')}</select></div>
        <div class="field"><label>Status</label><select name="status">${labelOptions('donor', d.status || 'actief')}</select></div>
        <div class="field"><label>Bron</label><input type="text" name="source" value="${esc(d.source || '')}" placeholder="website, evenement…"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Voornaam</label><input type="text" name="first_name" value="${esc(d.first_name || '')}"></div>
        <div class="field"><label>Achternaam</label><input type="text" name="last_name" value="${esc(d.last_name || '')}"></div>
        <div class="field"><label>Organisatie</label><input type="text" name="company_name" value="${esc(d.company_name || '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>E-mail</label><input type="email" name="email" value="${esc(d.email || '')}"></div>
        <div class="field"><label>Telefoon</label><input type="text" name="phone" value="${esc(d.phone || '')}"></div>
        <div class="field"><label>Voorkeurskanaal</label><select name="preferred_channel">${opt('email', 'E-mail', d.preferred_channel)}${opt('post', 'Post', d.preferred_channel)}${opt('telefoon', 'Telefoon', d.preferred_channel)}${opt('whatsapp', 'WhatsApp', d.preferred_channel)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Adres</label><input type="text" name="street" value="${esc(d.street || '')}"></div>
        <div class="field"><label>Postcode</label><input type="text" name="postal_code" value="${esc(d.postal_code || '')}"></div>
        <div class="field"><label>Plaats</label><input type="text" name="city" value="${esc(d.city || '')}"></div>
        <div class="field"><label>Land</label><input type="text" name="country" value="${esc(d.country || 'Nederland')}"></div>
      </div>
      <div class="field"><label>Taal (chat)</label><select name="language">${langOptions(d.language || 'nl')}</select></div>
      <div class="field"><label>Tags (komma-gescheiden)</label><input type="text" name="tags" value="${esc(d.tags || '')}" placeholder="maandgever, major donor"></div>
      <div class="field-row">
        <div class="field"><label class="check"><input type="checkbox" name="anonymous" ${d.anonymous ?? 1 ? 'checked' : ''}> Anoniem op het leaderboard</label>
          <div class="hint">Standaard aan (privacy). Zet alleen uit met toestemming van de donateur.</div></div>
        <div class="field"><label>Weergavenaam leaderboard</label><input type="text" name="display_name" value="${esc(d.display_name || '')}" placeholder="bv. Familie Jansen"></div>
        <div class="field"><label class="check"><input type="checkbox" name="newsletter" ${d.newsletter ?? 1 ? 'checked' : ''}> Ontvangt nieuwsbrief</label></div>
      </div>
      <div class="field"><label>Notities</label><textarea name="notes">${esc(d.notes || '')}</textarea></div>`,
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

  view().innerHTML = `
    <div class="page-head">
      <div class="profile-head"><div class="avatar">${esc(initials(d.full_name))}</div>
        <div><h1>${esc(d.full_name)}</h1>
          <div class="muted">${badge('donor', d.status)} ${esc(label('type', d.donor_type))} · klant sinds ${date(d.created_at)}
          ${data.rank ? ` · <b>#${data.rank}</b> op leaderboard` : ''} ${d.anonymous ? '· 🕶️ anoniem' : `· publiek als “${esc(d.public_name)}”`}</div>
          <div>${tags(d.tags)}</div></div></div>
      <div class="toolbar">
        <a class="btn btn-ghost" href="#/donateurs">← Terug</a>
        <button class="btn btn-ghost" id="edit">Bewerken</button>
        <button class="btn btn-ghost" id="portal">${d.has_portal ? '🔑 Nieuw wachtwoord' : '🔑 Portaaltoegang geven'}</button>
        <button class="btn btn-ghost" id="annual">📄 Jaaroverzicht</button>
        ${isAdmin() ? '<button class="btn btn-ghost" id="as-donor">👁️ Inloggen als donateur</button>' : ''}
        <button class="btn btn-ghost" id="spend-donor">⚡ Geld besteden</button>
        <button class="btn btn-primary" id="add-donation">+ Donatie</button>
      </div>
    </div>
    <div class="grid grid-4">
      <div class="card kpi accent"><div class="label">Totaal gedoneerd</div><div class="value">${euro(totals.donated)}</div></div>
      <div class="card kpi wait"><div class="label">Nog in cellen</div><div class="value">${euro(totals.waiting)}</div></div>
      <div class="card kpi ok"><div class="label">Besteed</div><div class="value">${euro(totals.spent)}</div></div>
      <div class="card kpi"><div class="label">Berichten ontvangen</div><div class="value">${new Set(data.journey.flatMap((j) => j.messages.map((m) => m.id))).size}</div></div>
    </div>
    <div class="grid grid-1-2" style="margin-top:16px">
      <div class="stack">
        <div class="card"><h3>Contactgegevens</h3>
          <dl class="dl">
            <dt>E-mail</dt><dd>${d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : '—'}</dd>
            <dt>Telefoon</dt><dd>${esc(d.phone) || '—'}</dd>
            <dt>Adres</dt><dd>${esc([d.street, `${d.postal_code} ${d.city}`.trim(), d.country].filter(Boolean).join(', ')) || '—'}</dd>
            <dt>Organisatie</dt><dd>${esc(d.company_name) || '—'}</dd>
            <dt>Voorkeur</dt><dd>${esc(d.preferred_channel)}</dd>
            <dt>Nieuwsbrief</dt><dd>${d.newsletter ? 'Ja' : 'Nee'}</dd>
            <dt>Bron</dt><dd>${esc(d.source) || '—'}</dd>
            <dt>Portaal</dt><dd>${d.has_portal ? `Actief${d.last_login_at ? ` · laatst ingelogd ${dateTime(d.last_login_at)}` : ''}` : 'Geen account'}</dd>
          </dl>
          ${d.notes ? `<h3 style="margin-top:14px">Notities</h3><p style="white-space:pre-line">${esc(d.notes)}</p>` : ''}
        </div>
        <div class="card"><h3>Impact per bestemming</h3>
          ${data.impact.map((r) => `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between"><span>${r.icon} ${esc(r.name)}</span><b>${euro(r.donated_cents)}</b></div>
            ${RF.splitBar(r.spent_cents, r.waiting_cents)}
            <div class="small muted">${r.units_funded ? `≈ ${esc(RF.unitsText(r, r.units_funded))} gefinancierd · ` : ''}${euro(r.waiting_cents)} wachtend</div></div>`).join('')}
        </div>
        <div class="card"><div class="card-head"><h3>Taken</h3><button class="btn btn-ghost btn-sm" id="add-task">+ Taak</button></div>
          ${data.tasks.length ? data.tasks.map((t) => `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">
            <input type="checkbox" data-task="${t.id}" ${t.status === 'afgerond' ? 'checked' : ''}>
            <div><div style="${t.status === 'afgerond' ? 'text-decoration:line-through;color:var(--ink-3)' : ''}">${esc(t.title)}</div>
            <div class="small muted">${t.due_date ? `Deadline ${date(t.due_date)} · ` : ''}${esc(t.assigned_name || '')}</div></div></div>`).join('') : '<p class="muted small">Geen taken</p>'}
        </div>
        ${isAdmin() ? `<div class="card"><h3>Privacy (AVG)</h3><p class="small muted">Anonimiseren verwijdert persoonsgegevens maar behoudt de financiële historie.</p>
          <button class="btn btn-danger btn-sm" id="anonymize">Anonimiseren</button>
          <button class="btn btn-danger btn-sm" id="delete">Verwijderen</button></div>` : ''}
      </div>
      <div class="card">
        <div class="tabs" id="tabs">
          <button data-tab="journey" class="active">Waar ging het geld heen?</button>
          <button data-tab="donations">Donaties & cellen (${data.donations.length})</button>
          <button data-tab="interactions">Contactmomenten (${data.interactions.length})</button>
          <button data-tab="emails">E-mails (${data.emails.length})</button>
        </div>
        <div id="tab-journey">${journeyHtml(data.journey)}</div>
        <div id="tab-donations" class="hidden">
          ${table([
            { label: 'Datum', render: (r) => date(r.received_at) },
            { label: 'Bestemming', render: (r) => `${r.icon} ${esc(r.category_name)}${r.campaign_name ? `<div class="small muted">📣 ${esc(r.campaign_name)}</div>` : ''}` },
            { label: 'Frequentie', render: (r) => esc(label('frequency', r.frequency)) },
            { label: 'Status', render: (r) => badge('donation', r.status) },
            { label: 'Cel', render: (r) => (r.cell_id ? `${badge('cell', r.cell_status)} <span class="small muted">${euro(r.remaining_cents)} over</span>` : '—') },
            { label: 'Bedrag', num: true, render: (r) => `<b>${euro(r.amount_cents)}</b>` },
            { label: '', render: (r) => `<button class="btn btn-ghost btn-sm" data-edit-donation="${r.id}">Bewerk</button>` },
          ], data.donations, { empty: 'Nog geen donaties' })}
        </div>
        <div id="tab-interactions" class="hidden">
          <button class="btn btn-ghost btn-sm" id="add-interaction" style="margin-bottom:12px">+ Contactmoment vastleggen</button>
          ${data.interactions.length ? `<ul class="timeline">${data.interactions.map((i) => `<li>
            <div class="when">${dateTime(i.occurred_at)} · ${esc(label('interaction', i.type))} · ${esc(i.user_name || '')}
              <button class="icon-btn" data-del-interaction="${i.id}" title="Verwijderen">🗑</button></div>
            <b>${esc(i.subject)}</b><div style="white-space:pre-line">${esc(i.body)}</div></li>`).join('')}</ul>` : '<p class="muted">Nog geen contactmomenten.</p>'}
        </div>
        <div id="tab-emails" class="hidden">
          ${data.emails.length ? data.emails.map((m) => `<details style="border-bottom:1px solid var(--line);padding:8px 0">
            <summary><b>${esc(m.subject)}</b> <span class="small muted">· ${dateTime(m.created_at)} · ${esc(m.kind)}</span></summary>
            <p style="white-space:pre-line;margin-top:8px" class="small">${esc(m.body)}</p></details>`).join('') : '<p class="muted">Geen e-mails verstuurd.</p>'}
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
  if (isAdmin()) $('#as-donor').onclick = () => loginAs(`/api/admin/donors/${d.id}/impersonate`);
  $('#spend-donor').onclick = () => {
    const withMoney = data.impact.find((r) => r.waiting_cents > 0);
    if (!withMoney) { toast('Deze donateur heeft geen geld meer in de cellen', 'error'); return; }
    spendForm({ donor_id: d.id, category_key: withMoney.key }, reload);
  };
  $('#add-task').onclick = () => taskForm({ donor_id: d.id }, reload);
  $('#add-interaction').onclick = () => interactionForm(d.id, reload);
  $('#annual').onclick = () => annualModal(`/api/admin/donors/${d.id}/annual`, year);
  $('#portal').onclick = () => modal({
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
  if (isAdmin()) {
    $('#anonymize').onclick = async () => {
      if (!(await confirmDialog('Alle persoonsgegevens van deze donateur worden onherroepelijk verwijderd. Donaties blijven (anoniem) bewaard.', 'Anonimiseren'))) return;
      await api(`/api/admin/donors/${d.id}/anonymize`, { method: 'POST', body: {} });
      toast('Donateur geanonimiseerd'); reload();
    };
    $('#delete').onclick = async () => {
      if (!(await confirmDialog('Donateur en alle donaties definitief verwijderen?', 'Verwijderen'))) return;
      try { await api(`/api/admin/donors/${d.id}`, { method: 'DELETE', body: {} }); toast('Verwijderd'); go('#/donateurs'); }
      catch (e) { toast(e.message, 'error'); }
    };
  }
}

function journeyHtml(journey) {
  if (!journey.length) return '<p class="muted">Er is nog geen geld van deze donateur besteed. Het staat veilig in de cellen.</p>';
  return `<ul class="timeline">${journey.map((j) => `<li>
    <div class="when">${date(j.spent_at)} · gedoneerd op ${date(j.donated_at)} (cel #${j.cell_id})</div>
    <div><b>${euro(j.amount_cents)}</b> → ${j.icon} ${esc(j.category_name)}${j.recipient_name ? ` voor <b>${esc(j.recipient_name)}</b>` : ''}
      <a class="small" href="#/bestedingen/${j.expenditure_id}">besteding #${j.expenditure_id}</a></div>
    <div class="small muted">${esc(j.description)} ${j.units ? `(${Math.round(j.share * 100)}% van ${esc(RF.unitsText(j, j.units))})` : ''}</div>
    ${j.messages.length ? j.messages.map((m) => `<div class="small">${esc(label('message', m.type))}: <b>${esc(m.title)}</b> ${m.read_at ? '<span class="badge badge-besteed">gelezen</span>' : '<span class="badge badge-wachtend">ongelezen</span>'}</div>`).join('')
      : '<div class="small"><span class="badge badge-wachtend">Wacht op bericht van ontvanger</span></div>'}
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
        <button type="button" class="btn btn-ghost" onclick="window.print()">🖨 Afdrukken / PDF</button></div>
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
          $('#donor-results', form).innerHTML = `<span class="badge badge-besteed">✓ ${esc(b.dataset.name)}</span>`;
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
    <div class="page-head"><h1>Donaties</h1>
      <div class="toolbar"><button class="btn btn-ghost" id="export">⬇ CSV export</button><button class="btn btn-primary" id="new">+ Donatie registreren</button></div></div>
    <div class="card">
      <div class="toolbar" style="margin-bottom:12px">
        <input type="search" id="f-q" placeholder="Zoek donateur of referentie…">
        <select id="f-cat">${catOptions('', true)}</select>
        <select id="f-status">${labelOptions('donation', '', 'Alle statussen')}</select>
        <select id="f-method">${labelOptions('method', '', 'Alle betaalwijzen')}</select>
        <select id="f-freq">${labelOptions('frequency', '', 'Alle frequenties')}</select>
        <select id="f-camp">${opt('', 'Alle campagnes', '')}${state.campaigns.map((c) => opt(c.id, c.name)).join('')}</select>
        <input type="date" id="f-from" title="Vanaf"> <input type="date" id="f-to" title="Tot en met">
      </div>
      <div id="tbl"></div>
    </div>`;
  const qs = () => new URLSearchParams({ q: $('#f-q').value, category: $('#f-cat').value, status: $('#f-status').value, method: $('#f-method').value,
    frequency: $('#f-freq').value, campaign: $('#f-camp').value, from: $('#f-from').value, to: $('#f-to').value });
  const load = async () => {
    const rows = await api(`/api/admin/donations?${qs()}`);
    const sum = rows.filter((r) => r.status === 'ontvangen').reduce((s, r) => s + r.amount_cents, 0);
    $('#tbl').innerHTML = `<p class="small muted">${rows.length} donaties · ontvangen totaal <b>${euro(sum)}</b></p>` + table([
      { label: 'Datum', render: (r) => date(r.received_at) },
      { label: 'Donateur', render: (r) => donorLink(r.donor_id, r.donor_name) },
      { label: 'Bestemming', render: (r) => `${r.icon} ${esc(r.category_name)}${r.campaign_name ? `<div class="small muted">📣 ${esc(r.campaign_name)}</div>` : ''}` },
      { label: 'Betaalwijze', render: (r) => esc(label('method', r.method)) },
      { label: 'Freq.', render: (r) => (r.frequency === 'eenmalig' ? 'Eenmalig' : badge('frequency', r.frequency)) },
      { label: 'Status', render: (r) => badge('donation', r.status) },
      { label: 'Cel', render: (r) => (r.cell_id ? `${badge('cell', r.cell_status)}` : '—') },
      { label: 'Bedrag', num: true, render: (r) => `<b>${euro(r.amount_cents)}</b>` },
    ], rows, { empty: 'Geen donaties gevonden', onRow: true });
    bindRows($('#tbl'), rows, (r) => donationForm(r, load));
  };
  $('#f-q').addEventListener('input', RF.debounce(load));
  view().querySelectorAll('.toolbar select, .toolbar input[type=date]').forEach((el) => el.addEventListener('change', load));
  $('#new').onclick = () => donationForm({}, load);
  $('#export').onclick = () => { location.href = `/api/admin/donations?${qs()}&format=csv`; };
  await load();
}

// ======================================================================= CELLEN
async function renderCells() {
  view().innerHTML = `
    <div class="page-head"><h1>Cellen</h1>
      <div class="toolbar"><button class="btn btn-primary" id="trigger" disabled>⚡ Geselecteerde cellen besteden</button></div></div>
    <p class="muted" style="max-width:780px">Elke ontvangen donatie wordt in een eigen <b>cel</b> bewaard tot het geld daadwerkelijk wordt uitgegeven.
      Selecteer cellen van dezelfde bestemming en trigger een besteding: de donateurs krijgen automatisch bericht, en zodra je
      een brief, foto of filmpje van de ontvanger koppelt komt dat in hun portaal.</p>
    <div class="grid grid-4" id="cat-summary" style="margin-bottom:16px"></div>
    <div class="card">
      <div class="toolbar" style="margin-bottom:12px">
        <select id="f-cat">${catOptions('', true)}</select>
        <select id="f-status">${opt('open', 'Open (saldo > 0)', 'open')}${opt('', 'Alle', '')}${labelOptions('cell', '')}</select>
        <span class="small muted" id="sel-info"></span>
      </div>
      <div id="tbl"></div>
    </div>`;
  const selected = new Map();
  $('#cat-summary').innerHTML = state.categories.map((c) => `<div class="card kpi" style="border-top:3px solid ${esc(c.color)}">
    <div class="label">${esc(c.icon)} ${esc(c.name)}</div><div class="value">${euro0(c.waiting_cents)}</div>
    <div class="sub">${c.open_cells} open cellen${c.unit_cost_cents ? ` · ${num(Math.floor(c.waiting_cents / c.unit_cost_cents))} ${esc(c.unit_label_plural)}` : ''}</div></div>`).join('');

  const updateSel = () => {
    const cells = [...selected.values()];
    const sum = cells.reduce((s, c) => s + c.remaining_cents, 0);
    const cats = new Set(cells.map((c) => c.category_key));
    $('#sel-info').innerHTML = cells.length ? `${cells.length} geselecteerd · ${euro(sum)}${cats.size > 1 ? ' · <span style="color:var(--bad)">kies één bestemming</span>' : ''}` : '';
    $('#trigger').disabled = !cells.length || cats.size > 1;
  };
  const load = async () => {
    const rows = await api(`/api/admin/cells?category=${$('#f-cat').value}&status=${$('#f-status').value}`);
    selected.clear(); updateSel();
    $('#tbl').innerHTML = table([
      { label: '', render: (r) => (r.remaining_cents > 0 ? `<input type="checkbox" data-cell="${r.id}" aria-label="Selecteer cel ${r.id}">` : '') },
      { label: 'Cel', render: (r) => `#${r.id}` },
      { label: 'Donateur', render: (r) => donorLink(r.donor_id, r.donor_name) },
      { label: 'Bestemming', render: (r) => `${r.icon} ${esc(r.category_name)}` },
      { label: 'Gedoneerd', render: (r) => date(r.received_at) },
      { label: 'Wacht', num: true, render: (r) => (r.remaining_cents > 0 ? `${r.age_days} d` : '—') },
      { label: 'Status', render: (r) => badge('cell', r.status) },
      { label: 'Vulling', render: (r) => `<div style="min-width:90px">${RF.splitBar(r.amount_cents - r.remaining_cents, r.remaining_cents)}</div>` },
      { label: 'Bedrag', num: true, render: (r) => euro(r.amount_cents) },
      { label: 'Saldo', num: true, render: (r) => `<b>${euro(r.remaining_cents)}</b>` },
    ], rows, { empty: 'Geen cellen' });
    $('#tbl').querySelectorAll('[data-cell]').forEach((cb) => cb.addEventListener('change', () => {
      const cell = rows.find((r) => r.id === Number(cb.dataset.cell));
      if (cb.checked) selected.set(cell.id, cell); else selected.delete(cell.id);
      updateSel();
    }));
  };
  $('#f-cat').onchange = load;
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
      status.textContent = `✓ Geüpload (${Math.round(r.size / 1024)} kB)`;
    } catch (e) { status.textContent = `✗ ${e.message}`; }
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
    <div class="page-head"><h1>Bestedingen</h1>
      <div class="toolbar"><select id="f-cat">${catOptions('', true)}</select><button class="btn btn-primary" id="new">Geld besteden</button></div></div>
    <div class="card"><div id="tbl"></div></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/expenditures?category=${$('#f-cat').value}`);
    $('#tbl').innerHTML = table([
      { label: 'Datum', render: (r) => date(r.spent_at) },
      { label: 'Bestemming', render: (r) => `${r.icon} ${esc(r.category_name)}` },
      { label: 'Ontvanger', render: (r) => esc(r.recipient_name || '—') },
      { label: 'Omschrijving', render: (r) => `<span class="small">${esc(r.description)}</span>` },
      { label: 'Aantal', num: true, render: (r) => (r.units ? `${num(r.units)} ${esc(r.units === 1 ? r.unit_label : r.unit_label_plural)}` : '—') },
      { label: 'Donateurs', num: true, key: 'donor_count' },
      { label: 'Bericht', render: (r) => (r.message_count ? `<span class="badge badge-besteed">✓ ${r.message_count}</span>` : '<span class="badge badge-wachtend">ontbreekt</span>') },
      { label: 'Bedrag', num: true, render: (r) => `<b>${euro(r.amount_cents)}</b>` },
    ], rows, { empty: 'Nog geen bestedingen', onRow: true });
    bindRows($('#tbl'), rows, (r) => go(`#/bestedingen/${r.id}`));
  };
  $('#f-cat').onchange = load;
  $('#new').onclick = () => spendForm({}, (r) => go(`#/bestedingen/${r.id}`));
  await load();
}

async function renderExpenditure(expId) {
  const e = await api(`/api/admin/expenditures/${expId}`);
  view().innerHTML = `
    <div class="page-head"><div><h1>${esc(e.icon)} Besteding #${e.id}</h1>
      <div class="muted">${date(e.spent_at)} · ${esc(e.category_name)}${e.recipient_name ? ` · voor <b>${esc(e.recipient_name)}</b>` : ''}</div></div>
      <div class="toolbar"><a class="btn btn-ghost" href="#/bestedingen">← Terug</a>
        ${isAdmin() ? '<button class="btn btn-danger" id="reverse">Terugdraaien</button>' : ''}
        <button class="btn btn-primary" id="add-msg">+ Brief / filmpje / foto koppelen</button></div></div>
    <div class="grid grid-3">
      <div class="card kpi accent"><div class="label">Bedrag</div><div class="value">${euro(e.amount_cents)}</div><div class="sub">${e.units ? `${num(e.units)} ${esc(e.unit_label_plural)}` : ''}</div></div>
      <div class="card kpi"><div class="label">Gefinancierd door</div><div class="value">${new Set(e.allocations.map((a) => a.donor_id)).size} donateurs</div><div class="sub">uit ${e.allocations.length} cellen</div></div>
      <div class="card kpi ${e.messages.length ? 'ok' : 'wait'}"><div class="label">Berichten</div><div class="value">${e.messages.length}</div><div class="sub">${e.messages.length ? 'verstuurd naar donateurs' : 'Nog geen bericht van de ontvanger'}</div></div>
    </div>
    ${e.description ? `<div class="card" style="margin-top:16px"><p style="margin:0">${esc(e.description)}</p></div>` : ''}
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h3>Uit welke cellen kwam het geld?</h3>
        ${table([
          { label: 'Donateur', render: (a) => donorLink(a.donor_id, a.donor_name) },
          { label: 'Cel', render: (a) => `#${a.cell_id} <span class="small muted">(${date(a.received_at)})</span>` },
          { label: 'Celbedrag', num: true, render: (a) => euro(a.cell_amount_cents) },
          { label: 'Gebruikt', num: true, render: (a) => `<b>${euro(a.amount_cents)}</b>` },
        ], e.allocations)}</div>
      <div class="card"><h3>Berichten van de ontvanger</h3>
        ${e.messages.length ? e.messages.map((m) => `<div class="message-card" style="border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(label('message', m.type))} · ${esc(m.title)}</b>
          <button class="icon-btn" data-del-msg="${m.id}" title="Verwijderen">🗑</button></div>
          <div class="small muted">Bezorgd bij ${m.delivered} donateurs · ${m.read_count} gelezen</div>
          ${RF.mediaHtml(m.type, m.media_url, m.title)}
          ${m.body ? `<div class="${m.type === 'brief' ? 'letter' : ''}" style="white-space:pre-line">${esc(m.body)}</div>` : ''}</div>`).join('')
          : '<p class="muted">Nog geen bericht. Voeg een brief, filmpje of foto toe: alle donateurs hierboven krijgen het in hun portaal.</p>'}
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
    <div class="page-head"><h1>Ontvangers</h1><div class="toolbar"><button class="btn btn-primary" id="new">+ Nieuwe ontvanger</button></div></div>
    <p class="muted">Kinderen, gezinnen, scholen en gemeenschappen die geholpen worden. Verhaal en foto worden alleen aan donateurs getoond als er toestemming is.</p>
    <div class="grid grid-3">${rows.map((r) => `<div class="card" data-r="${r.id}" style="cursor:pointer;${r.active ? '' : 'opacity:.55'}">
      <div style="display:flex;gap:12px;align-items:center">
        ${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="" style="width:56px;height:56px;border-radius:50%;object-fit:cover">` : `<div class="avatar">${esc(initials(r.name))}</div>`}
        <div><b>${esc(r.name)}</b><div class="small muted">${esc(label('recipient', r.kind))}${r.age ? ` · ${r.age} jaar` : ''} · ${esc([r.location, r.country].filter(Boolean).join(', '))}</div>
        <div class="small">${r.consent ? '✅ toestemming delen' : '🚫 geen toestemming'}</div>
        <div class="small">${r.has_login ? `🔑 ${esc(r.username)} · ${r.chat_enabled ? (r.chat_moderated ? '💬 chat (gemodereerd)' : '💬 chat') : 'chat uit'}` : '<span class="muted">geen inlog</span>'}</div></div></div>
      <p class="small" style="margin-top:10px">${esc(r.story).slice(0, 160)}</p>
      <div class="small muted">${r.expenditure_count} bestedingen · ${euro(r.received_cents)}${r.chat_count ? ` · ${r.chat_count} chatberichten` : ''}</div>
      <div class="toolbar" style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-access="${r.id}">🔑 Inlog & chat</button>
        ${isAdmin() && r.active ? `<button class="btn btn-ghost btn-sm" data-as="${r.id}">👁️ Inloggen als</button>` : ''}</div></div>`).join('') || '<p class="muted">Nog geen ontvangers.</p>'}</div>`;
  const form = (r = {}) => modal({
    title: r.id ? 'Ontvanger bewerken' : 'Nieuwe ontvanger', wide: true,
    body: `<div class="field-row"><div class="field"><label>Naam</label><input type="text" name="name" required value="${esc(r.name || '')}"></div>
        <div class="field"><label>Soort</label><select name="kind">${labelOptions('recipient', r.kind || 'kind')}</select></div>
        <div class="field"><label>Leeftijd</label><input type="number" name="age" value="${esc(r.age ?? '')}"></div></div>
      <div class="field-row"><div class="field"><label>School</label><input type="text" name="school" value="${esc(r.school || '')}"></div>
        <div class="field"><label>Plaats</label><input type="text" name="location" value="${esc(r.location || '')}"></div>
        <div class="field"><label>Land</label><input type="text" name="country" value="${esc(r.country || '')}"></div></div>
      <div class="field"><label>Verhaal</label><textarea name="story">${esc(r.story || '')}</textarea></div>
      <div class="field"><label>Foto</label><input type="file" data-upload="photo_url" accept="image/*">
        <input type="text" name="photo_url" value="${esc(r.photo_url || '')}" placeholder="/uploads/… of URL" style="margin-top:6px"><div class="hint" data-upload-status="photo_url"></div></div>
      <label class="check"><input type="checkbox" name="consent" ${r.consent ? 'checked' : ''}> Toestemming (ouder/voogd) om foto en verhaal met donateurs te delen</label>
      <label class="check"><input type="checkbox" name="active" ${r.active ?? 1 ? 'checked' : ''}> Actief</label>`,
    onOpen: bindUploads,
    onSubmit: async (f) => {
      await api(r.id ? `/api/admin/recipients/${r.id}` : '/api/admin/recipients', { method: r.id ? 'PUT' : 'POST', body: f });
      toast('Ontvanger opgeslagen'); renderRecipients();
    },
  });
  $('#new').onclick = () => form();
  view().querySelectorAll('[data-r]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-access],[data-as]')) return;
    form(rows.find((r) => r.id === Number(el.dataset.r)));
  }));
  view().querySelectorAll('[data-as]').forEach((b) => b.addEventListener('click', () => loginAs(`/api/admin/recipients/${b.dataset.as}/impersonate`)));
  view().querySelectorAll('[data-access]').forEach((b) => b.addEventListener('click', () => accessForm(rows.find((r) => r.id === Number(b.dataset.access)))));
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
        <div class="hint">Standaard afgeleid uit het land (bv. Haïti → Kreyòl ayisyen). Berichten worden automatisch vertaald.</div></div>
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
    <div class="page-head"><h1>Chatmoderatie</h1>
      <div class="toolbar"><select id="f-status">${opt('in_behandeling', 'Wacht op controle', 'in_behandeling')}${opt('goedgekeurd', 'Goedgekeurd')}${opt('afgewezen', 'Afgewezen')}${opt('', 'Alle')}</select></div></div>
    <p class="muted" style="max-width:820px">Berichten tussen donateurs en kinderen (en berichten met contactgegevens, links of geldverzoeken) worden pas afgeleverd na goedkeuring.
      Controleer of er geen persoonlijke gegevens worden gedeeld en of de toon passend is.</p>
    <div id="list"></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/chat?status=${$('#f-status').value}`);
    $('#list').innerHTML = rows.length ? rows.map((m) => `<div class="card" style="margin-bottom:12px">
      <div class="card-head"><div>
        <b>${m.sender === 'donor' ? `${esc(m.donor_name)} → ${esc(m.recipient_name)}` : `${esc(m.recipient_name)} → ${esc(m.donor_name)}`}</b>
        <span class="small muted">· ${dateTime(m.created_at)} · ${esc(label('recipient', m.recipient_kind))}${m.managed_by ? ` (begeleider: ${esc(m.managed_by)})` : ''}</span>
        ${m.flag_reason ? `<div><span class="badge badge-hoog">⚠️ bevat mogelijk: ${esc(m.flag_reason)}</span></div>` : ''}</div>
        ${m.status === 'in_behandeling' ? '' : `<span class="badge badge-${m.status === 'goedgekeurd' ? 'besteed' : 'geannuleerd'}">${esc(m.status)}${m.reviewed_by_name ? ` · ${esc(m.reviewed_by_name)}` : ''}</span>`}</div>
      <div class="bubble theirs" style="max-width:100%"><div class="bubble-body">${esc(m.body)}</div></div>
      ${m.reject_reason ? `<p class="small muted">Reden afwijzing: ${esc(m.reject_reason)}</p>` : ''}
      <div class="toolbar" style="margin-top:10px">
        ${m.status === 'in_behandeling' ? `<button class="btn btn-primary btn-sm" data-approve="${m.id}">✓ Goedkeuren</button>
          <button class="btn btn-danger btn-sm" data-reject="${m.id}">✗ Afwijzen</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-thread="${m.recipient_id}:${m.donor_id}">Heel gesprek bekijken</button>
        <a class="btn btn-ghost btn-sm" href="#/donateurs/${m.donor_id}">Donateur</a></div></div>`).join('')
      : '<div class="card"><p class="empty">Geen berichten 🎉</p></div>';
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
    <div class="page-head"><h1>Taken</h1>
      <div class="toolbar"><select id="f-status">${opt('open', 'Open', 'open')}${opt('afgerond', 'Afgerond')}${opt('', 'Alle')}</select>
        <label class="check" style="margin:0"><input type="checkbox" id="f-mine"> Alleen mijn taken</label>
        <button class="btn btn-primary" id="new">+ Nieuwe taak</button></div></div>
    <div class="card"><div id="tbl"></div></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/tasks?status=${$('#f-status').value}&mine=${$('#f-mine').checked ? 1 : 0}`);
    $('#tbl').innerHTML = table([
      { label: '', render: (t) => `<input type="checkbox" data-done="${t.id}" ${t.status === 'afgerond' ? 'checked' : ''} aria-label="Afronden">` },
      { label: 'Taak', render: (t) => `<b>${esc(t.title)}</b>${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ''}` },
      { label: 'Donateur', render: (t) => (t.donor_id ? donorLink(t.donor_id, t.donor_name) : '—') },
      { label: 'Deadline', render: (t) => `<span class="${t.status === 'open' && t.due_date && t.due_date < today() ? 'badge badge-hoog' : ''}">${date(t.due_date) || '—'}</span>` },
      { label: 'Prioriteit', render: (t) => `<span class="badge badge-${esc(t.priority)}">${esc(t.priority)}</span>` },
      { label: 'Toegewezen', render: (t) => esc(t.assigned_name || '—') },
      { label: '', render: (t) => `<button class="icon-btn" data-del="${t.id}" title="Verwijderen">🗑</button>` },
    ], rows, { empty: 'Geen taken', onRow: true });
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
    <div class="page-head"><h1>Campagnes</h1><div class="toolbar"><button class="btn btn-primary" id="new">+ Nieuwe campagne</button></div></div>
    <div class="grid grid-2">${rows.map((c) => {
      const pct = c.goal_cents ? Math.min(100, (c.raised_cents / c.goal_cents) * 100) : 0;
      return `<div class="card" data-c="${c.id}" style="cursor:pointer;${c.active ? '' : 'opacity:.6'}">
        <div class="card-head"><h3>${esc(c.name)}</h3>${c.active ? badge('donor', 'actief') : badge('donor', 'inactief')}</div>
        <p class="small muted">${esc(c.description)}</p>
        <div class="small">${c.category_name ? `Bestemming: ${esc(c.category_name)} · ` : ''}${date(c.start_date)} – ${date(c.end_date)}</div>
        <div class="splitbar" style="margin:10px 0 6px"><span class="spent" style="width:${pct}%;background:var(--robin)"></span></div>
        <div style="display:flex;justify-content:space-between"><b>${euro0(c.raised_cents)}</b><span class="muted">doel ${euro0(c.goal_cents)} · ${c.donor_count} donateurs</span></div></div>`;
    }).join('') || '<p class="muted">Nog geen campagnes.</p>'}</div>`;
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
    <div class="page-head"><h1>Leaderboard</h1>
      <div class="toolbar"><select id="f-period">${opt('all', 'Altijd')}${opt('year', 'Dit jaar')}${opt('month', 'Deze maand')}</select>
        <select id="f-cat">${catOptions('', true)}</select><a class="btn btn-ghost" href="/leaderboard" target="_blank">Publieke versie ↗</a></div></div>
    <p class="muted">Intern overzicht met echte namen. Op het publieke leaderboard en in het portaal zien bezoekers alleen de publieke naam; anonieme donateurs verschijnen als “Anonieme donateur”.</p>
    <div class="card"><div id="tbl"></div></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/leaderboard?period=${$('#f-period').value}&category=${$('#f-cat').value}&limit=100`);
    $('#tbl').innerHTML = table([
      { label: '#', render: (r) => `<b>${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</b>` },
      { label: 'Donateur', render: (r) => donorLink(r.donor_id, r.full_name) },
      { label: 'Publiek zichtbaar als', render: (r) => (r.anonymous ? '<i class="muted">🕶️ Anonieme donateur</i>' : esc(r.name)) },
      { label: 'Giften', num: true, key: 'donation_count' },
      { label: 'Besteed', num: true, render: (r) => euro(r.spent_cents) },
      { label: 'Totaal', num: true, render: (r) => `<b>${euro(r.total_cents)}</b>` },
    ], rows);
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
    <div class="page-head"><h1>Rapportages ${esc(r.year)}</h1>
      <div class="toolbar"><select id="f-year">${(r.years.length ? r.years : [r.year]).map((y) => opt(y, y, r.year)).join('')}</select>
        <button class="btn btn-ghost" onclick="window.print()">🖨 Afdrukken</button>
        <a class="btn btn-ghost" href="/api/admin/donations?from=${r.year}-01-01&to=${r.year}-12-31&format=csv">⬇ Donaties ${esc(r.year)} (CSV)</a></div></div>
    <div class="grid grid-4">
      <div class="card kpi accent"><div class="label">Opgehaald</div><div class="value">${euro0(r.totals.raised_cents)}</div><div class="sub">${r.totals.donations} giften</div></div>
      <div class="card kpi ok"><div class="label">Besteed</div><div class="value">${euro0(r.spent.cents)}</div><div class="sub">${r.spent.n} bestedingen</div></div>
      <div class="card kpi"><div class="label">Unieke donateurs</div><div class="value">${r.totals.donors}</div><div class="sub">gem. gift ${euro(r.totals.avg_cents)}</div></div>
      <div class="card kpi"><div class="label">Donateursbehoud</div><div class="value">${ret == null ? '—' : `${ret}%`}</div><div class="sub">${r.retention.retained} van ${r.retention.last_year} van vorig jaar</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h3>Per bestemming</h3>
        ${r.byCategory.map((c) => `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between"><span>${esc(c.icon)} ${esc(c.name)}</span><span>${euro0(c.raised_cents)} in · ${euro0(c.spent_cents)} uit</span></div>
          <div class="splitbar"><span style="width:${(c.raised_cents / max) * 100}%;background:${esc(c.color)}"></span></div>
          ${c.units ? `<div class="small muted">${num(c.units)} ${esc(c.unit_label_plural)} gefinancierd</div>` : ''}</div>`).join('')}</div>
      <div class="card"><h3>Per maand</h3>${RF.barChart(months.map(RF.monthName), [{ label: 'Ontvangen', values: months.map((m) => bm[m] || 0), color: 'var(--robin)' }])}</div>
      <div class="card"><h3>Betaalwijze</h3>${hbars(r.byMethod, 'method', (k) => label('method', k))}</div>
      <div class="card"><h3>Frequentie</h3>${hbars(r.byFrequency, 'frequency', (k) => label('frequency', k))}
        <h3 style="margin-top:16px">Type donateur</h3>${hbars(r.byType, 'donor_type', (k) => label('type', k))}</div>
      <div class="card"><h3>Top 10 donateurs ${esc(r.year)}</h3>${table([
        { label: '#', key: 'rank' }, { label: 'Donateur', render: (x) => donorLink(x.donor_id, x.full_name) },
        { label: 'Totaal', num: true, render: (x) => euro(x.total_cents) }], r.topDonors)}</div>
      <div class="card"><h3>Impactberichten</h3>
        <p>${num(r.messageStats.delivered)} berichten bezorgd in donateursportalen, waarvan <b>${num(r.messageStats.read)}</b> gelezen
        (${r.messageStats.delivered ? Math.round((r.messageStats.read / r.messageStats.delivered) * 100) : 0}%).</p></div>
    </div>`;
  $('#f-year').onchange = (e) => renderReports(e.target.value);
}

// ======================================================================= E-MAIL LOG
async function renderOutbox() {
  view().innerHTML = `<div class="page-head"><h1>E-mail log</h1>
      <div class="toolbar"><select id="f-kind">${opt('', 'Alle soorten')}${['bedankt', 'besteding', 'impactbericht', 'portaal'].map((k) => opt(k, k)).join('')}</select></div></div>
    <p class="muted">Alle e-mails die het systeem naar donateurs stuurt. (In deze versie worden ze gelogd, niet echt verzonden — koppel een SMTP-/mailprovider voor productie.)</p>
    <div class="card"><div id="tbl"></div></div>`;
  const load = async () => {
    const rows = await api(`/api/admin/outbox?kind=${$('#f-kind').value}`);
    $('#tbl').innerHTML = rows.length ? rows.map((m) => `<details style="border-bottom:1px solid var(--line);padding:8px 0">
      <summary><b>${esc(m.subject)}</b> <span class="small muted">→ ${m.donor_id ? donorLink(m.donor_id, m.to_email) : esc(m.to_email)} · ${dateTime(m.created_at)} · ${esc(m.kind)}</span></summary>
      <p class="small" style="white-space:pre-line;margin-top:8px">${esc(m.body)}</p></details>`).join('') : '<p class="empty">Geen e-mails</p>';
  };
  $('#f-kind').onchange = load;
  await load();
}

// ======================================================================= INSTELLINGEN
async function renderSettings() {
  await loadLookups();
  view().innerHTML = `
    <div class="page-head"><h1>Instellingen</h1></div>
    ${isAdmin() ? `<div class="card" id="tr-card"><div class="card-head"><h2>🌐 Automatisch vertalen</h2>
      <button class="btn btn-primary btn-sm" id="tr-test">Proefvertaling</button></div><div id="tr-status" class="muted">Laden…</div></div>` : ''}
    <div class="card"><div class="card-head"><h2>Bestemmingen & kosten per eenheid</h2></div>
      <p class="small muted">Bepaalt hoe donaties worden omgerekend naar impact (“€ 25 = 50 maaltijden”) en hoeveel er per eenheid uit de cellen wordt gehaald.</p>
      ${table([
        { label: '', render: (c) => esc(c.icon) },
        { label: 'Bestemming', render: (c) => `<b>${esc(c.name)}</b><div class="small muted">${esc(c.description)}</div>` },
        { label: 'Eenheid', render: (c) => esc(c.unit_label || 'vrij bedrag') },
        { label: 'Prijs / eenheid', num: true, render: (c) => (c.unit_cost_cents ? euro(c.unit_cost_cents) : '—') },
        { label: 'Actief', render: (c) => (c.active ? '✅' : '—') },
        { label: '', render: (c) => (isAdmin() ? `<button class="btn btn-ghost btn-sm" data-cat="${esc(c.key)}">Bewerk</button>` : '') },
      ], state.categories)}</div>
    <div class="card"><div class="card-head"><h2>Gebruikers</h2>${isAdmin() ? '<button class="btn btn-primary btn-sm" id="new-user">+ Gebruiker</button>' : ''}</div>
      ${table([
        { label: 'Naam', key: 'name' }, { label: 'E-mail', key: 'email' },
        { label: 'Rol', render: (u) => (u.role === 'admin' ? '<span class="badge badge-admin">Beheerder</span>' : 'Medewerker') },
        { label: 'Status', render: (u) => (u.active ? badge('donor', 'actief') : badge('donor', 'inactief')) },
        { label: '', render: (u) => (isAdmin() ? `<button class="btn btn-ghost btn-sm" data-user="${u.id}">Bewerk</button>` : '') },
      ], state.users)}</div>
    ${isAdmin() ? '<div class="card"><div class="card-head"><h2>Audit log</h2><button class="btn btn-ghost btn-sm" id="show-audit">Tonen</button></div><div id="audit"></div></div>' : ''}`;

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
    const line = (ok, okText, badText) => `<div>${ok ? '✅' : '❌'} ${ok ? okText : badText}</div>`;
    const showStatus = (st) => {
      $('#tr-status').innerHTML = `
        ${line(st.sdk_installed, 'Vertaalpakket is geïnstalleerd', 'Vertaalpakket ontbreekt → zet in Render het <b>Build Command</b> op <code>npm install</code> en deploy opnieuw')}
        ${line(st.api_key_set, 'API-sleutel is ingesteld', 'API-sleutel ontbreekt → voeg in Render bij <b>Environment</b> <code>ANTHROPIC_API_KEY</code> toe')}
        ${st.api_key_has_spaces ? '<div>⚠️ De API-sleutel begint of eindigt met een spatie: verwijder die in Render.</div>' : ''}
        ${line(!!st.model_from_env, `Model ingesteld via CRM_TRANSLATE_MODEL: <code>${esc(st.model_from_env || '')}</code>`, `CRM_TRANSLATE_MODEL niet gevonden → standaardmodel <code>${esc(st.model)}</code>`)}
        ${st.lookalikes && st.lookalikes.length ? `<div style="margin-top:6px">⚠️ Gevonden variabelen met een <b>bijna</b> goede naam: ${st.lookalikes.map((k) => `<code>${esc(k)}</code>`).join(', ')}
          → hernoem ze precies naar <code>ANTHROPIC_API_KEY</code> en <code>CRM_TRANSLATE_MODEL</code>.</div>` : ''}
        <div class="small muted" style="margin-top:8px">Deze app draait als Render-service: <b>${esc(st.service || 'onbekend')}</b>${st.url ? ` (${esc(st.url)})` : ''}${st.commit ? ` · versie ${esc(st.commit)}` : ''}.
          Vul de variabelen in bij <b>deze</b> service.</div>`;
    };
    api('/api/admin/translation/status').then(showStatus).catch((e) => { $('#tr-status').textContent = e.message; });
    $('#tr-test').onclick = async () => {
      $('#tr-test').disabled = true;
      $('#tr-status').innerHTML = 'Bezig met proefvertaling…';
      try {
        const r = await api('/api/admin/translation/test', { method: 'POST', body: {} });
        showStatus(r);
        $('#tr-status').innerHTML += r.ok
          ? `<div style="margin-top:10px" class="impact-preview">✅ Het werkt! (${r.ms} ms)<br><span class="small">“${esc(r.input)}” (${esc(r.source_language)})<br>→ “${esc(r.output)}”</span></div>`
          : `<div style="margin-top:10px" class="form-error" style="margin:10px 0 0">❌ ${esc(r.error)}${r.detail ? `<br><span class="small">${esc(r.detail)}</span>` : ''}</div>`;
      } catch (e) { $('#tr-status').textContent = e.message; }
      finally { $('#tr-test').disabled = false; }
    };
  }
  const userForm = (u = {}) => modal({
    title: u.id ? 'Gebruiker bewerken' : 'Nieuwe gebruiker',
    body: `<div class="field"><label>Naam</label><input type="text" name="name" value="${esc(u.name || '')}" required></div>
      ${u.id ? '' : '<div class="field"><label>E-mail</label><input type="email" name="email" required></div>'}
      <div class="field"><label>Rol</label><select name="role">${opt('medewerker', 'Medewerker', u.role)}${opt('admin', 'Beheerder', u.role)}</select></div>
      <div class="field"><label>${u.id ? 'Nieuw wachtwoord (optioneel)' : 'Wachtwoord'}</label><input type="password" name="password" ${u.id ? '' : 'required'} minlength="8"></div>
      ${u.id ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Actief</label>` : ''}`,
    onSubmit: async (f) => {
      await api(u.id ? `/api/admin/users/${u.id}` : '/api/admin/users', { method: u.id ? 'PUT' : 'POST', body: f });
      toast('Gebruiker opgeslagen'); renderSettings();
    },
  });
  if ($('#new-user')) $('#new-user').onclick = () => userForm();
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

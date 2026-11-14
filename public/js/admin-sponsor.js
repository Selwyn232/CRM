// Beheer: sponsormodel (kinderen, sponsorschappen, maandupdates, sponsorbedrag).
// Draait na admin.js en gebruikt diens helpers (pageHead, btn, table, modal, …).
'use strict';

const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthLabel = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
const childThumb = (c, name = c.first_name || c.child_name) => (c.photo_url
  ? `<img class="child-thumb" src="${esc(c.photo_url)}" alt="">`
  : `<span class="child-thumb">${esc(String(name || '?').slice(0, 1))}</span>`);
const ageOf = (birth) => {
  if (!birth) return null;
  const b = new Date(birth); const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return a;
};
const families = () => state.recipients.filter((r) => r.kind === 'gezin' || r.kind === 'kind');

// ======================================================================= DASHBOARD
async function renderSponsorDashboard() {
  const [o, d] = await Promise.all([api('/api/admin/sponsor/overview'), api('/api/admin/dashboard')]);
  const t = o.totals;
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  const byMonth = Object.fromEntries(d.monthly.map((r) => [r.month, r.cents]));
  const todayLabel = now.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  view().innerHTML = `
    ${pageHead(`${greeting()}, ${esc(firstName(state.user.name))}`, {
      sub: `${todayLabel.charAt(0).toUpperCase() + todayLabel.slice(1)} · zo staat Robin Foundation ervoor`,
      actions: btn('q-child', 'Kind', { icon: 'plus' }) + btn('q-update', 'Maandupdates', { icon: 'image', kind: 'primary' }),
    })}
    <div class="kpis">
      <div class="kpi"><div class="label">${RF.icon('smile')}Gesponsorde kinderen</div><div class="value">${num(t.sponsored)}</div>
        <div class="sub">${num(t.available)} wachten op een sponsor${t.in_review ? ` · ${t.in_review} in behandeling` : ''}</div></div>
      <div class="kpi"><div class="label">${RF.icon('users')}Sponsors</div><div class="value">${num(t.sponsors)}</div>
        <div class="sub">gemiddeld ${t.sponsors ? (t.sponsorships / t.sponsors).toFixed(1).replace('.', ',') : 0} kind per sponsor</div></div>
      <div class="kpi"><div class="label">${RF.icon('repeat')}Maandinkomsten</div><div class="value">${euro0(t.monthly_cents)}</div>
        <div class="sub">${euro(o.config.amount_cents)} per kind per maand</div></div>
      <div class="kpi"><div class="label">${RF.icon('cloud-lightning')}Noodfonds</div><div class="value">${euro0(t.fund_cents)}</div>
        <div class="sub">beschikbaar voor orkanen en overstromingen</div></div>
    </div>
    <div class="grid grid-2-1" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div><h2>Ontvangen per maand</h2><div class="small muted">Laatste 12 maanden</div></div></div>
        ${RF.barChart(months.map((m) => RF.monthName(m.slice(5))), [{ label: 'Ontvangen', values: months.map((m) => byMonth[m] || 0), color: 'var(--accent)' }], { legend: false })}
      </div>
      <div class="card">
        <div class="card-head"><h2>Aandacht nodig</h2></div>
        <div class="list">
          ${attentionRow('#/updates', 'image', `${t.updates_missing} ${t.updates_missing === 1 ? 'kind' : 'kinderen'} zonder update`, `Voor ${monthLabel(o.month)}`, t.updates_missing)}
          ${attentionRow('#/sponsorschappen/betaling_gemist', 'circle-alert', `${t.missed} ${t.missed === 1 ? 'gemiste betaling' : 'gemiste betalingen'}`, 'Na 2 maanden komt het kind weer vrij', t.missed)}
          ${attentionRow('#/kinderen/te_beoordelen', 'badge-check', `${t.in_review} ${t.in_review === 1 ? 'kind' : 'kinderen'} te beoordelen`, 'Nieuwe aanmeldingen controleren', t.in_review)}
          ${attentionRow('#/chat', 'messages-square', `${d.totals.pending_chats} ${d.totals.pending_chats === 1 ? 'chatbericht' : 'chatberichten'}`, 'Wachten op controle', d.totals.pending_chats)}
          ${attentionRow('#/taken', 'list-checks', `${d.totals.open_tasks} open ${d.totals.open_tasks === 1 ? 'taak' : 'taken'}`, d.totals.overdue_tasks ? `${d.totals.overdue_tasks} te laat` : 'Niets te laat', d.totals.overdue_tasks)}
        </div>
      </div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Verdeling per kind</h2><a href="#/instellingen">Aanpassen</a></div>
        <div class="breakdown">${o.config.parts.map((p) => `<div class="bd-row"><span class="bd-ico">${RF.icon(p.icon || 'circle')}</span>
          <div class="grow"><div class="t">${esc(p.label)}</div><div class="small muted">${esc(p.description)}</div></div><b class="num">${euro(p.cents)}</b></div>`).join('')}
          <div class="bd-row total"><div class="grow">Per kind per maand</div><b class="num">${euro(o.config.amount_cents)}</b></div></div></div>
      <div class="card"><div class="card-head"><h2>Recente betalingen</h2><a href="#/donaties">Alles</a></div>
        <div class="list">${d.recent.slice(0, 7).map((r) => `<a class="list-row" href="#/donateurs/${r.donor_id}">${RF.catIcon(r, 'sm')}
          <div class="grow"><div class="title">${esc(r.donor_name)}</div><div class="meta">${esc(r.category_name)} · ${date(r.received_at)}</div></div>
          <div class="end">${euro(r.amount_cents)}</div></a>`).join('') || RF.emptyState({ icon: 'banknote', title: 'Nog geen betalingen' })}</div></div>
    </div>`;
  $('#q-child').onclick = () => childForm({}, (c) => go(`#/kinderen/${c.id}`));
  $('#q-update').onclick = () => go('#/updates');
}

// ======================================================================= KINDEREN
async function renderKids(param) {
  if (param && /^\d+$/.test(param)) return renderKid(param);
  const status = param || '';
  const q = sessionStorage.getItem('rf-kids-q') || '';
  view().innerHTML = `
    ${pageHead('Kinderen', { sub: 'Alle kinderen in het programma. Donateurs zien alleen voornaam, leeftijd, school, provincie, verhaal en foto.', actions: btn('new', 'Nieuw kind', { icon: 'plus', kind: 'primary' }) })}
    <div class="toolbar" style="margin-bottom:12px">${searchInput('q', 'Zoek op naam, gezin of school', q)}
      <select id="f-status">${opt('', 'Alle statussen', status)}${Object.entries(RF.LABELS.child).map(([k, v]) => opt(k, v, status)).join('')}</select></div>
    <div class="card flush" id="tbl">${RF.skeleton('rows')}</div>`;
  const load = async () => {
    const qs = new URLSearchParams({ status: $('#f-status').value, q: $('#q').value });
    const rows = await api(`/api/admin/children?${qs}`);
    $('#tbl').innerHTML = table([
      { label: 'Kind', render: (c) => `<div class="cell-person">${childThumb(c)}<div class="grow"><b>${esc(c.first_name)} ${esc(c.last_name)}</b><span class="sub">${c.age != null ? `${c.age} jaar` : ''}${c.grade ? ` · ${esc(c.grade)}` : ''}</span></div></div>` },
      { label: 'Gezin', render: (c) => `<span class="muted">${esc(c.family_name || '—')}${c.province ? `<span class="sub">${esc([c.city, c.province].filter(Boolean).join(', '))}</span>` : ''}</span>` },
      { label: 'School', render: (c) => `<span class="muted">${esc(c.school || '—')}</span>` },
      { label: 'Status', render: (c) => badge('child', c.status) + (c.sponsorship_status === 'betaling_gemist' ? ` ${badge('sponsorship', 'betaling_gemist')}` : '') },
      { label: 'Sponsor', render: (c) => (c.donor_id ? donorLink(c.donor_id, c.sponsor_name) : '<span class="muted">—</span>') },
    ], rows, { empty: 'Geen kinderen gevonden', emptyIcon: 'smile', onRow: true });
    bindRows($('#tbl'), rows, (c) => go(`#/kinderen/${c.id}`));
  };
  $('#q').addEventListener('input', RF.debounce(() => { sessionStorage.setItem('rf-kids-q', $('#q').value); load(); }, 200));
  $('#f-status').onchange = () => { location.hash = $('#f-status').value ? `#/kinderen/${$('#f-status').value}` : '#/kinderen'; };
  $('#new').onclick = () => childForm({}, (c) => go(`#/kinderen/${c.id}`));
  await load();
}

function childForm(c, done) {
  const fams = families();
  modal({
    title: c.id ? `${c.first_name} bewerken` : 'Nieuw kind', wide: true,
    body: `<div class="field-row"><div class="field"><label>Voornaam</label><input type="text" name="first_name" required value="${esc(c.first_name || '')}"></div>
        <div class="field"><label>Achternaam <span class="muted">(niet zichtbaar voor donateurs)</span></label><input type="text" name="last_name" value="${esc(c.last_name || '')}"></div></div>
      <div class="field-row"><div class="field"><label>Geboortedatum</label><input type="date" name="birth_date" value="${esc(c.birth_date || '')}"></div>
        <div class="field"><label>Geslacht</label><select name="gender">${opt('', '—', c.gender)}${opt('meisje', 'Meisje', c.gender)}${opt('jongen', 'Jongen', c.gender)}</select></div>
        <div class="field"><label>Status</label><select name="status" ${c.status === 'gesponsord' ? 'disabled' : ''}>${Object.entries(RF.LABELS.child).filter(([k]) => k !== 'gesponsord' || c.status === 'gesponsord').map(([k, v]) => opt(k, v, c.status || 'beschikbaar')).join('')}</select></div></div>
      <div class="field"><label>Gezin</label><select name="family_id">${opt('', '— kies een gezin —', c.family_id)}${fams.map((f) => opt(f.id, `${f.name}${f.location ? ` (${f.location})` : ''}`, c.family_id)).join('')}</select>
        <div class="hint">Het gezin is de chatpartner van de sponsor. Nieuw gezin? Voeg het toe bij Gezinnen.</div></div>
      <div class="field-row"><div class="field"><label>School</label><input type="text" name="school" value="${esc(c.school || '')}"></div>
        <div class="field"><label>Klas / groep</label><input type="text" name="grade" value="${esc(c.grade || '')}" placeholder="bv. Grade 3"></div></div>
      <div class="field"><label>Verhaal van het kind</label><textarea name="story" rows="5">${esc(c.story || '')}</textarea></div>
      <div class="field"><label>Foto</label><input type="file" data-upload="photo_url" accept="image/*">
        <input type="text" name="photo_url" value="${esc(c.photo_url || '')}" placeholder="/uploads/… of URL" style="margin-top:6px"><div class="hint" data-upload-status="photo_url"></div></div>`,
    onOpen: bindUploads,
    onSubmit: async (f) => {
      if (c.status === 'gesponsord') delete f.status;
      const r = await api(c.id ? `/api/admin/children/${c.id}` : '/api/admin/children', { method: c.id ? 'PUT' : 'POST', body: f });
      toast('Kind opgeslagen');
      done(r);
    },
  });
}

async function renderKid(childId) {
  const c = await api(`/api/admin/children/${childId}`);
  const active = c.sponsorships.find((s) => s.status !== 'beeindigd');
  view().innerHTML = `
    <div class="crumbs"><a href="#/kinderen">Kinderen</a>${RF.icon('chevron-right', 'icon-sm')}<span>${esc(c.first_name)} ${esc(c.last_name)}</span></div>
    <div class="page-head" style="align-items:center">
      <div class="profile-head">${c.photo_url ? `<img src="${esc(c.photo_url)}" alt="" style="width:56px;height:56px;border-radius:14px;object-fit:cover">` : RF.avatar(c.first_name, 'lg')}
        <div><h1>${esc(c.first_name)} ${esc(c.last_name)}</h1>
          <div class="profile-meta">${badge('child', c.status)}${c.age != null ? `<span>${c.age} jaar</span>` : ''}
            ${c.family_name ? `<span class="dot-sep">${esc(c.family_name)}</span>` : ''}${c.province ? `<span class="dot-sep">${esc([c.city, c.province].filter(Boolean).join(', '))}</span>` : ''}</div></div></div>
      <div class="toolbar">${btn('edit', 'Bewerken', { icon: 'pencil' })}${btn('add-update', 'Update plaatsen', { icon: 'image', kind: 'primary' })}
        ${!active && c.status === 'beschikbaar' ? btn('link', 'Koppel aan donateur', { icon: 'user-plus' }) : ''}</div>
    </div>
    <div class="grid grid-1-2">
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Sponsor</h2></div>
          ${active ? `<div class="cell-person">${RF.avatar(active.donor_name, 'sm')}<div class="grow">${donorLink(active.donor_id, active.donor_name)}
            <span class="sub">Sinds ${date(active.started_at)} · ${active.months} ${active.months === 1 ? 'maand' : 'maanden'} betaald</span></div>${badge('sponsorship', active.status)}</div>
            <div class="toolbar" style="margin-top:12px">${btn('pay', 'Betaling registreren', { icon: 'banknote', size: 'sm' })}${btn('end', 'Beëindigen', { icon: 'ban', size: 'sm' })}</div>`
            : `<p class="muted small" style="margin:0">${c.status === 'beschikbaar' ? 'Nog geen sponsor. Het kind staat zichtbaar voor donateurs.' : 'Niet zichtbaar voor donateurs (status: ' + esc(label('child', c.status)) + ').'}</p>`}
        </div>
        <div class="card"><div class="card-head"><h2>Gegevens</h2></div><dl class="props">
          <dt>${RF.icon('calendar')}Geboren</dt><dd>${c.birth_date ? date(c.birth_date) : '<span class="muted">—</span>'}</dd>
          <dt>${RF.icon('school')}School</dt><dd>${esc(c.school) || '<span class="muted">—</span>'}${c.grade ? `<span class="sub muted">${esc(c.grade)}</span>` : ''}</dd>
          <dt>${RF.icon('house')}Gezin</dt><dd>${esc(c.family_name) || '<span class="muted">—</span>'}</dd>
          <dt>${RF.icon('clock')}In programma</dt><dd>${date(c.created_at)}</dd></dl></div>
        ${c.sponsorships.length > (active ? 1 : 0) ? `<div class="card"><div class="card-head"><h2>Eerdere sponsors</h2></div>
          <div class="list">${c.sponsorships.filter((s) => s.status === 'beeindigd').map((s) => `<div class="list-row"><div class="grow"><div class="title">${donorLink(s.donor_id, s.donor_name)}</div>
            <div class="meta">${date(s.started_at)} – ${date(s.ended_at)} · ${s.months} mnd${s.end_reason ? ` · ${esc(s.end_reason)}` : ''}</div></div></div>`).join('')}</div></div>` : ''}
      </div>
      <div class="stack">
        <div class="card"><h2>Verhaal</h2><p style="white-space:pre-line;margin:0">${esc(c.story) || '<span class="muted">Nog geen verhaal</span>'}</p></div>
        <div class="card"><div class="card-head"><h2>Updates</h2><span class="small muted">${c.updates.length}</span></div>
          ${c.updates.length ? `<div class="list">${c.updates.map((u) => `<div class="list-row"><span class="cat-ico sm" style="--c:var(--accent)">${RF.icon(RF.MESSAGE_ICONS[u.type] || 'image')}</span>
            <div class="grow"><div class="title">${esc(u.title)}</div><div class="meta">${esc(monthLabel(u.month))} · ${esc(u.created_by_name || '')}${u.read_at ? ' · gelezen' : ''}</div></div>
            <button class="icon-btn" data-del-update="${u.id}" aria-label="Verwijderen">${RF.icon('trash-2')}</button></div>`).join('')}</div>`
            : RF.emptyState({ icon: 'image', title: 'Nog geen updates' })}</div>
        <div class="card"><div class="card-head"><h2>Betaalde maanden</h2></div>
          ${c.months.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${c.months.map((m) => `<span class="tag">${esc(monthLabel(m.month))} · ${euro(m.amount_cents)}</span>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nog geen betalingen.</p>'}</div>
      </div>
    </div>`;
  $('#edit').onclick = () => childForm(c, () => renderKid(childId));
  $('#add-update').onclick = () => updateForm(c, () => renderKid(childId));
  if ($('#link')) $('#link').onclick = () => linkSponsorForm([c], () => renderKid(childId));
  if ($('#pay')) $('#pay').onclick = () => paymentForm(active, () => renderKid(childId));
  if ($('#end')) $('#end').onclick = () => endForm(active, () => renderKid(childId));
  view().querySelectorAll('[data-del-update]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog('Deze update verwijderen? De sponsor ziet hem dan niet meer.', 'Verwijderen')) return;
    await api(`/api/admin/updates/${b.dataset.delUpdate}`, { method: 'DELETE' });
    renderKid(childId);
  }));
}

function updateForm(c, done) {
  modal({
    title: `Update voor ${c.first_name}`, wide: true, submitLabel: 'Plaatsen en sponsor mailen',
    body: `<div class="field-row"><div class="field"><label>Soort</label><select name="type">${labelOptions('message', 'foto')}</select></div>
        <div class="field"><label>Maand</label><input type="month" name="month" value="${thisMonth()}"></div></div>
      <div class="field"><label>Titel</label><input type="text" name="title" required placeholder="bv. Eerste rapport van dit schooljaar"></div>
      <div class="field"><label>Tekst / brief</label><textarea name="body" rows="5"></textarea></div>
      <div class="field"><label>Foto of filmpje</label><input type="file" data-upload="media_url" accept="image/*,video/*">
        <input type="text" name="media_url" placeholder="/uploads/… of URL" style="margin-top:6px"><div class="hint" data-upload-status="media_url"></div></div>`,
    onOpen: bindUploads,
    onSubmit: async (f) => { await api(`/api/admin/children/${c.id}/updates`, { method: 'POST', body: f }); toast('Update geplaatst'); done(); },
  });
}

async function linkSponsorForm(kids, done) {
  modal({
    title: 'Koppel aan donateur',
    body: `<p class="small muted">Gebruik dit voor sponsors die per bankoverschrijving betalen. Online sponsors kiezen zelf in het portaal.</p>
      <div class="field"><label>Donateur</label><input type="search" id="donor-q" placeholder="Zoek op naam of e-mail" autocomplete="off"><input type="hidden" name="donor_id"><div class="hint" id="donor-pick"></div></div>
      <p>Kinderen: <b>${esc(kids.map((k) => k.first_name).join(', '))}</b></p>
      <label class="check"><input type="checkbox" name="book_first" checked> Eerste maand meteen als betaald boeken</label>
      <div class="field-row"><div class="field"><label>Betaalwijze</label><select name="method">${opt('overschrijving', 'Overschrijving')}${opt('incasso', 'Incasso')}${opt('contant', 'Contant')}</select></div>
        <div class="field"><label>Kenmerk</label><input type="text" name="reference"></div></div>`,
    onOpen: (form) => {
      const q = form.querySelector('#donor-q');
      q.addEventListener('input', RF.debounce(async () => {
        const list = q.value.trim().length < 2 ? [] : (await api(`/api/admin/donors?q=${encodeURIComponent(q.value.trim())}`)).slice(0, 6);
        $('#donor-pick').innerHTML = list.map((d) => `<button type="button" class="tag" data-d="${d.id}" style="cursor:pointer;border:0">${esc(d.full_name)}${d.email ? ` · ${esc(d.email)}` : ''}</button>`).join(' ') || (q.value ? 'Niemand gevonden' : '');
        $('#donor-pick').querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
          form.elements.donor_id.value = b.dataset.d; q.value = b.textContent; $('#donor-pick').textContent = 'Gekozen';
        }));
      }, 200));
    },
    onSubmit: async (f) => {
      if (!f.donor_id) throw new Error('Kies een donateur');
      await api('/api/admin/sponsorships', { method: 'POST', body: { ...f, child_ids: kids.map((k) => k.id) } });
      toast('Sponsorschap gestart'); done();
    },
  });
}

function paymentForm(s, done) {
  modal({
    title: `Betaling registreren: ${s.donor_name}`,
    body: `<p class="small muted">Boekt een maand voor dit sponsorschap (bv. na een bankoverschrijving). Online betalingen via Mollie worden automatisch geboekt.</p>
      <div class="field-row"><div class="field"><label>Maand</label><input type="month" name="month" value="${thisMonth()}"></div>
        <div class="field"><label>Betaalwijze</label><select name="method">${opt('overschrijving', 'Overschrijving')}${opt('incasso', 'Incasso')}${opt('contant', 'Contant')}</select></div></div>
      <div class="field"><label>Kenmerk</label><input type="text" name="reference"></div>`,
    onSubmit: async (f) => {
      await api('/api/admin/sponsorships/payment', { method: 'POST', body: { ...f, donor_id: s.donor_id, sponsorship_ids: [s.id] } });
      toast('Maand geboekt'); done();
    },
  });
}

function endForm(s, done) {
  modal({
    title: 'Sponsorschap beëindigen', submitLabel: 'Beëindigen',
    body: `<p>Het kind komt weer beschikbaar voor een nieuwe sponsor. De donateur krijgt een bevestiging per e-mail en een lopende Mollie-incasso wordt aangepast.</p>
      <div class="field"><label>Reden</label><input type="text" name="reason" placeholder="bv. Op verzoek van donateur"></div>`,
    onSubmit: async (f) => { await api(`/api/admin/sponsorships/${s.id}/end`, { method: 'POST', body: f }); toast('Sponsorschap beëindigd'); done(); },
  });
}

// ======================================================================= SPONSORSCHAPPEN
async function renderSponsorships(status = '') {
  view().innerHTML = `
    ${pageHead('Sponsorschappen', { sub: 'Wie sponsort welk kind. Betalingen via Mollie worden automatisch geboekt; na 2 gemiste maanden komt het kind weer vrij.', actions: btn('new', 'Nieuw sponsorschap', { icon: 'plus', kind: 'primary' }) })}
    <div class="toolbar" style="margin-bottom:12px"><select id="f-status">${opt('', 'Lopend', status)}${opt('actief', 'Actief', status)}${opt('betaling_gemist', 'Betaling gemist', status)}${opt('beeindigd', 'Beëindigd', status)}</select></div>
    <div class="card flush" id="tbl">${RF.skeleton('rows')}</div>`;
  const rows = await api(`/api/admin/sponsorships?status=${encodeURIComponent(status)}`);
  $('#tbl').innerHTML = table([
    { label: 'Kind', render: (s) => `<div class="cell-person">${childThumb(s)}<div class="grow"><a href="#/kinderen/${s.child_id}"><b>${esc(s.child_name)}</b></a><span class="sub">${esc(s.family_name || '')}</span></div></div>` },
    { label: 'Sponsor', render: (s) => donorLink(s.donor_id, s.donor_name) },
    { label: 'Sinds', render: (s) => `<span class="muted">${date(s.started_at)}</span>` },
    { label: 'Laatste maand', render: (s) => `<span class="muted">${s.last_month ? esc(monthLabel(s.last_month)) : '—'}</span>` },
    { label: 'Status', render: (s) => badge('sponsorship', s.status) + (s.missed_months ? `<span class="sub muted">${s.missed_months} gemist</span>` : '') },
    { label: 'Per maand', num: true, render: (s) => euro(s.monthly_cents) },
    { label: '', render: (s) => (s.status !== 'beeindigd' ? `<button class="icon-btn" data-more="${s.id}" aria-label="Acties">${RF.icon('ellipsis')}</button>` : '') },
  ], rows, { empty: 'Geen sponsorschappen', emptyIcon: 'heart-handshake' });
  $('#f-status').onchange = () => { location.hash = $('#f-status').value ? `#/sponsorschappen/${$('#f-status').value}` : '#/sponsorschappen'; };
  $('#new').onclick = async () => {
    const kids = await api('/api/admin/children?status=beschikbaar');
    if (!kids.length) return toast('Er zijn geen beschikbare kinderen', 'error');
    modal({
      title: 'Kinderen kiezen', submitLabel: 'Verder',
      body: `<div class="stack" style="max-height:50vh;overflow:auto">${kids.map((k) => `<label class="check"><input type="checkbox" name="k${k.id}"> ${childThumb(k)}<span><b>${esc(k.first_name)} ${esc(k.last_name)}</b><span class="sub muted"> ${k.age != null ? `${k.age} jaar · ` : ''}${esc(k.family_name || '')}</span></span></label>`).join('')}</div>`,
      onSubmit: (f) => {
        const picked = kids.filter((k) => f[`k${k.id}`]);
        if (!picked.length) throw new Error('Kies minimaal één kind');
        setTimeout(() => linkSponsorForm(picked, () => renderSponsorships(status)), 0);
      },
    });
  };
  view().querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    const s = rows.find((x) => x.id === Number(b.dataset.more));
    RF.menu(b, [
      { label: 'Betaling registreren', icon: 'banknote', onClick: () => paymentForm(s, () => renderSponsorships(status)) },
      { label: 'Update plaatsen', icon: 'image', onClick: () => updateForm({ id: s.child_id, first_name: s.child_name }, () => renderSponsorships(status)) },
      { label: 'Betaling gemist', icon: 'circle-alert', onClick: async () => {
        if (!await confirmDialog(`Een gemiste betaling registreren voor ${s.child_name}? Na 2 gemiste maanden komt het kind weer vrij.`, 'Registreren')) return;
        await api(`/api/admin/sponsorships/${s.id}/missed`, { method: 'POST', body: {} }); renderSponsorships(status);
      } },
      { label: 'Beëindigen', icon: 'ban', onClick: () => endForm(s, () => renderSponsorships(status)) },
    ]);
  }));
}

// ======================================================================= MAANDUPDATES
async function renderUpdates(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : thisMonth();
  const d = await api(`/api/admin/updates?month=${m}`);
  const missing = d.rows.filter((r) => !r.updates);
  view().innerHTML = `
    ${pageHead('Maandupdates', { sub: 'Elke sponsor krijgt elke maand een foto, brief of filmpje van zijn of haar kind.' })}
    <div class="toolbar" style="margin-bottom:12px"><input type="month" id="f-month" value="${m}">
      <span class="small muted">${missing.length ? `${missing.length} van ${d.rows.length} kinderen hebben nog geen update voor ${esc(monthLabel(m))}` : `Alle ${d.rows.length} kinderen hebben een update voor ${esc(monthLabel(m))}`}</span></div>
    <div class="card" style="margin-bottom:16px"><div class="meter"><span style="width:${d.rows.length ? ((d.rows.length - missing.length) / d.rows.length) * 100 : 100}%"></span></div></div>
    <div class="card flush">${table([
      { label: 'Kind', render: (r) => `<div class="cell-person">${childThumb(r)}<div class="grow"><a href="#/kinderen/${r.child_id}"><b>${esc(r.first_name)}</b></a><span class="sub">${esc(r.family_name || '')}</span></div></div>` },
      { label: 'Sponsor', render: (r) => donorLink(r.donor_id, r.sponsor_name) },
      { label: 'Deze maand', render: (r) => (r.updates ? `<span class="badge badge-goedgekeurd">${r.updates} geplaatst</span>` : '<span class="badge badge-wachtend">Nog niet</span>') },
      { label: '', render: (r) => `<button class="btn btn-ghost btn-sm" data-up="${r.child_id}">${RF.icon('plus')}<span>Update</span></button>` },
    ], d.rows, { empty: 'Nog geen gesponsorde kinderen', emptyIcon: 'image' })}</div>`;
  $('#f-month').onchange = () => { location.hash = `#/updates/${$('#f-month').value}`; };
  view().querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
    const r = d.rows.find((x) => x.child_id === Number(b.dataset.up));
    updateForm({ id: r.child_id, first_name: r.first_name }, () => renderUpdates(m));
  }));
}

// ======================================================================= LEADERBOARD
async function renderSponsorLeaderboard() {
  const rows = await api('/api/admin/leaderboard');
  view().innerHTML = `
    ${pageHead('Leaderboard', { sub: 'Op aantal gesponsorde kinderen · intern overzicht met echte namen', actions: '<a class="btn btn-ghost" href="/leaderboard" target="_blank" rel="noopener">' + RF.icon('arrow-up-right') + '<span>Publieke versie</span></a>' })}
    <div class="callout neutral">${RF.icon('info')}<span>Publiek en in het portaal zien bezoekers alleen de publieke naam. Anonieme sponsors verschijnen als “Anonieme donateur”.</span></div>
    <div class="card flush">${table([
      { label: '#', render: (r) => `<span class="muted num">${r.rank}</span>` },
      { label: 'Sponsor', render: (r) => `<div class="cell-person">${RF.avatar(r.full_name, 'sm')}${donorLink(r.donor_id, r.full_name)}</div>` },
      { label: 'Publiek als', render: (r) => (r.anonymous ? `<span class="muted">${RF.icon('eye-off', 'icon-sm')} Anonieme donateur</span>` : esc(r.name)) },
      { label: 'Maanden', num: true, render: (r) => `<span class="muted">${r.months}</span>` },
      { label: 'Kinderen', num: true, render: (r) => `<b style="font-weight:600">${r.children}</b>` },
    ], rows, { empty: 'Nog geen sponsors', emptyIcon: 'trophy' })}</div>`;
}

// ======================================================================= INSTELLINGEN: sponsorbedrag
async function renderSponsorConfig() {
  if (!$('#sponsor-cfg-card')) return;
  const cfg = await api('/api/admin/sponsor/config');
  const card = $('#sponsor-cfg-card'); // opnieuw opzoeken: de pagina kan intussen opnieuw zijn opgebouwd
  if (!card) return;
  const ICONS = ['utensils', 'graduation-cap', 'heart-pulse', 'cloud-lightning', 'school', 'house', 'gift', 'smile', 'circle'];
  const row = (p = {}) => `<div class="part-row">
    <input type="text" data-f="label" value="${esc(p.label || '')}" placeholder="Onderdeel" aria-label="Onderdeel" ${isAdmin() ? '' : 'disabled'}>
    <input type="text" data-f="description" value="${esc(p.description || '')}" placeholder="Omschrijving voor donateurs" aria-label="Omschrijving" ${isAdmin() ? '' : 'disabled'}>
    <select data-f="icon" aria-label="Icoon" ${isAdmin() ? '' : 'disabled'}>${ICONS.map((i) => opt(i, i, p.icon || 'circle')).join('')}</select>
    <input type="text" data-f="cents" inputmode="decimal" value="${p.cents != null ? centsToInput(p.cents) : ''}" placeholder="€" aria-label="Bedrag" ${isAdmin() ? '' : 'disabled'}>
    ${isAdmin() ? `<button type="button" class="icon-btn" data-rm aria-label="Verwijderen">${RF.icon('trash-2')}</button>` : '<span></span>'}
    <input type="hidden" data-f="key" value="${esc(p.key || '')}"><input type="hidden" data-f="fund" value="${p.fund ? 1 : ''}"></div>`;
  card.innerHTML = `<div class="card-head"><div><h2 style="display:flex;align-items:center;gap:8px">${RF.icon('heart-handshake')}Sponsorbedrag en verdeling</h2>
      <div class="small muted">Wat een sponsor per kind per maand betaalt en waar dat heen gaat. Nieuwe bedragen gelden voor nieuwe sponsorschappen; geboekte maanden blijven ongewijzigd.</div></div></div>
    <form id="cfg-form">
      <div class="field" style="max-width:220px"><label>Bedrag per kind per maand (€)</label><input type="text" name="amount" inputmode="decimal" value="${centsToInput(cfg.amount_cents)}" ${isAdmin() ? '' : 'disabled'}></div>
      <div id="parts">${cfg.parts.map(row).join('')}</div>
      <div class="small muted" id="cfg-sum" style="margin:6px 0 12px"></div>
      ${isAdmin() ? `<div class="toolbar"><button type="button" class="btn btn-ghost btn-sm" id="add-part">${RF.icon('plus')}<span>Onderdeel</span></button>
        <button class="btn btn-primary btn-sm">Opslaan</button></div>` : '<p class="hint">Alleen beheerders kunnen dit wijzigen.</p>'}
      <p class="hint">Het onderdeel “Robin Noodfonds” gaat naar de gezamenlijke noodfondspot; de rest wordt op naam van het kind geboekt.</p>
    </form>`;
  const form = card.querySelector('#cfg-form');
  if (!form) return;
  const parts = () => [...form.querySelectorAll('.part-row')].map((r) => Object.fromEntries([...r.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value])));
  const sum = () => {
    const total = parts().reduce((s, p) => s + (toCents(p.cents) || 0), 0);
    const amount = toCents(form.elements.amount.value) || 0;
    card.querySelector('#cfg-sum').innerHTML = total === amount ? `${RF.icon('check', 'icon-sm')} Onderdelen tellen op tot ${euro(amount)}`
      : `<span style="color:var(--bad)">Onderdelen tellen op tot ${euro(total)}; dat moet ${euro(amount)} zijn.</span>`;
  };
  form.addEventListener('input', sum);
  form.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { e.target.closest('.part-row').remove(); sum(); } });
  if (card.querySelector('#add-part')) card.querySelector('#add-part').onclick = () => { card.querySelector('#parts').insertAdjacentHTML('beforeend', row()); sum(); };
  sum();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/sponsor/config', { method: 'PUT', body: {
        amount_cents: toCents(form.elements.amount.value),
        parts: parts().map((p) => ({ ...p, cents: toCents(p.cents), fund: !!p.fund })),
      } });
      toast('Sponsorbedrag opgeslagen');
    } catch (ex) { toast(ex.message, 'error'); }
  };
}

// ======================================================================= NOODFONDS
async function renderNoodfonds() {
  const d = await api('/api/admin/noodfonds');
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  const byMonth = Object.fromEntries(d.monthly.map((r) => [r.month, r.cents]));
  view().innerHTML = `
    ${pageHead('Noodfonds', { sub: 'Gezamenlijke pot voor orkanen en overstromingen, gevuld met het noodfondsdeel van elke sponsorbetaling.',
    actions: btn('deploy', 'Noodhulp inzetten', { icon: 'cloud-lightning', kind: 'primary' }) })}
    <div class="kpis">
      <div class="kpi"><div class="label">${RF.icon('cloud-lightning')}Beschikbaar</div><div class="value">${euro0(d.balance_cents)}</div><div class="sub">direct inzetbaar</div></div>
      <div class="kpi"><div class="label">${RF.icon('trending-up')}Totaal ingelegd</div><div class="value">${euro0(d.in_cents)}</div><div class="sub">sinds de start</div></div>
      <div class="kpi"><div class="label">${RF.icon('hand-heart')}Totaal ingezet</div><div class="value">${euro0(d.out_cents)}</div><div class="sub">noodhulp verleend</div></div>
      <div class="kpi"><div class="label">${RF.icon('house')}Inzetten</div><div class="value">${num(d.deployments)}</div><div class="sub">keer noodhulp</div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><div><h2>Inleg per maand</h2><div class="small muted">Laatste 12 maanden</div></div></div>
      ${RF.barChart(months.map((m) => RF.monthName(m.slice(5))), [{ label: 'Inleg', values: months.map((m) => byMonth[m] || 0), color: 'var(--accent)' }], { legend: false })}</div>
    <div class="card flush" style="margin-top:16px"><div class="card-head"><h2>Ingezette noodhulp</h2></div>
      ${table([
        { label: 'Datum', render: (e) => `<span class="muted">${date(e.spent_at)}</span>` },
        { label: 'Gezin', render: (e) => (e.family_name ? `<b>${esc(e.family_name)}</b><span class="sub">${esc([e.location, e.province].filter(Boolean).join(', '))}</span>` : '<span class="muted">Meerdere gezinnen</span>') },
        { label: 'Omschrijving', render: (e) => `<span class="muted">${esc(e.description)}</span>` },
        { label: 'Door', render: (e) => `<span class="muted">${esc(e.created_by_name || '')}</span>` },
        { label: 'Bedrag', num: true, render: (e) => `<b style="font-weight:600">${euro(e.amount_cents)}</b>` },
        { label: '', render: (e) => (isAdmin() ? `<button class="icon-btn" data-undo="${e.id}" aria-label="Terugdraaien" title="Terugdraaien">${RF.icon('undo-2')}</button>` : '') },
      ], d.items, { empty: 'Nog geen noodhulp ingezet', emptyIcon: 'cloud-lightning' })}</div>`;
  $('#deploy').onclick = () => modal({
    title: 'Noodhulp inzetten', submitLabel: 'Vastleggen',
    body: `<div class="impact-preview">${RF.icon('cloud-lightning')}<span>Beschikbaar in het noodfonds: <b>${euro(d.balance_cents)}</b></span></div>
      <div class="field-row"><div class="field"><label>Bedrag (€)</label><input type="text" name="amount" inputmode="decimal" required></div>
        <div class="field"><label>Datum</label><input type="date" name="spent_at" value="${today()}"></div></div>
      <div class="field"><label>Gezin (optioneel)</label><select name="recipient_id">${opt('', '— meerdere gezinnen / algemeen —', '')}${families().map((f) => opt(f.id, `${f.name}${f.location ? ` (${f.location})` : ''}`, '')).join('')}</select></div>
      <div class="field"><label>Omschrijving</label><textarea name="description" rows="3" required placeholder="bv. Tyfoon: rijst, drinkwater en zeil voor 40 gezinnen in Borongan"></textarea></div>`,
    onSubmit: async (f) => {
      await api('/api/admin/noodfonds', { method: 'POST', body: { amount_cents: toCents(f.amount), spent_at: f.spent_at, recipient_id: f.recipient_id || null, description: f.description } });
      toast('Noodhulp vastgelegd'); renderNoodfonds();
    },
  });
  view().querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog('Deze inzet terugdraaien? Het bedrag gaat terug in het noodfonds.', 'Terugdraaien')) return;
    try { await api(`/api/admin/noodfonds/${b.dataset.undo}`, { method: 'DELETE' }); toast('Teruggedraaid'); renderNoodfonds(); }
    catch (ex) { toast(ex.message, 'error'); }
  }));
}

// ======================================================================= registreren in admin.js
Object.assign(ROUTES, {
  dashboard: renderSponsorDashboard,
  kinderen: renderKids,
  sponsorschappen: renderSponsorships,
  updates: renderUpdates,
  leaderboard: renderSponsorLeaderboard,
  noodfonds: renderNoodfonds,
});
{
  const donors = ROUTES.donateurs;
  ROUTES.donateurs = async (id) => {
    await donors(id);
    if (!id) return;
    const rows = await api(`/api/admin/sponsorships?donor_id=${id}`);
    const host = view().querySelector('.grid.grid-1-2 > .stack');
    if (!host) return;
    host.insertAdjacentHTML('afterbegin', `<div class="card"><div class="card-head"><h2>Sponsorkinderen</h2><span class="small muted">${rows.length ? `${euro(rows.reduce((t, s) => t + s.monthly_cents, 0))} per maand` : ''}</span></div>
      ${rows.length ? `<div class="list">${rows.map((s) => `<a class="list-row" href="#/kinderen/${s.child_id}">${childThumb(s)}<div class="grow"><div class="title">${esc(s.child_name)}</div>
        <div class="meta">Sinds ${date(s.started_at)} · ${s.months} ${s.months === 1 ? 'maand' : 'maanden'}</div></div>${badge('sponsorship', s.status)}</a>`).join('')}</div>`
        : '<p class="muted small" style="margin:0">Sponsort (nog) geen kind.</p>'}</div>`);
  };
  const settings = ROUTES.instellingen;
  ROUTES.instellingen = async (p) => { await settings(p); await renderSponsorConfig(); };
}

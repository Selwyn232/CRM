// Donateursportaal Robin Foundation
'use strict';

const { api, esc, euro, euro0, num, date, dateTime, today, toCents, label, toast } = RF;
const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');
let me = null;

async function boot() {
  try {
    me = await api('/api/donor/me');
    showApp();
  } catch {
    showAuth();
  }
}

// Niet ingelogd: naar de centrale inlogpagina (en daarna terug naar deze pagina).
function showAuth() {
  location.replace(`/login?rol=donateur&terug=${encodeURIComponent(location.pathname + location.hash)}`);
}

function showApp() {
  $('#app').classList.remove('hidden');
  RF.markLoggedIn();
  $('#nav-toggle-ic').innerHTML = RF.icon('menu', 'icon-lg');
  $('#donate-btn').innerHTML = `${RF.icon('heart')}<span>Doneer</span>`;
  RF.impersonationBanner(me, '/api/donor/logout');
  const logout = async () => { await api('/api/donor/logout', { method: 'POST', body: {} }); location.replace('/login?rol=donateur'); };
  $('#logout').onclick = logout;
  $('#logout-m').onclick = (e) => { e.preventDefault(); logout(); };
  $('#nav-toggle').onclick = () => {
    const open = !$('#nav').classList.contains('open');
    $('#nav').classList.toggle('open', open);
    $('#nav-toggle').setAttribute('aria-expanded', open);
  };
  window.addEventListener('hashchange', route);
  route();
}

const ROUTES = {
  overzicht: renderOverview, reis: renderJourney, berichten: renderMessages, doneren: renderDonate,
  chat: renderChat, leaderboard: renderLeaderboard, jaaroverzicht: renderAnnual, profiel: renderProfile,
};

async function route() {
  const [name, param] = (location.hash.replace(/^#\/?/, '') || 'overzicht').split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#nav').classList.remove('open');
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
  view().innerHTML = '<p class="muted">Laden…</p>';
  try {
    await (ROUTES[name] || renderOverview)(param);
  } catch (err) {
    if (err.status === 401) return showAuth();
    view().innerHTML = `<div class="card"><p class="form-error" style="margin:0">${esc(err.message)}</p></div>`;
  }
  refreshUnread();
  window.scrollTo(0, 0);
}

async function refreshUnread() {
  try {
    const msgs = await api('/api/portal/messages');
    const n = msgs.filter((m) => !m.read_at).length;
    $('#unread').textContent = n;
    $('#unread').classList.toggle('hidden', !n);
    const convs = await api('/api/portal/conversations');
    const c = convs.reduce((s, x) => s + x.unread, 0);
    $('#chat-unread').textContent = c;
    $('#chat-unread').classList.toggle('hidden', !c);
    $('#unread-m').textContent = n + c;
    $('#unread-m').classList.toggle('hidden', !(n + c));
  } catch { /* stil */ }
}

// ======================================================================= OVERZICHT
const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond'; };

async function renderOverview() {
  const [o, donations, journey] = await Promise.all([api('/api/portal/overview'), api('/api/portal/donations'), api('/api/portal/journey')]);
  me = o.donor;
  const t = o.totals;
  const openCells = donations.filter((d) => d.cell_id && d.remaining_cents > 0);
  const impact = o.impact.filter((r) => r.spent_cents > 0);

  view().innerHTML = `
    <section class="hero">
      <div class="eyebrow">${RF.icon('heart', 'icon-sm')} Jouw impact</div>
      <h1>${greet()}, ${esc(me.first_name || me.full_name)}</h1>
      <p>Iedere euro die je geeft, bewaren we in een eigen cel. Pas als hij echt wordt uitgegeven, zie je hier waar hij heen ging, met een bericht van wie je hebt geholpen.</p>
      <div class="hero-stats">
        <div><div class="label">Totaal gedoneerd</div><div class="value">${euro(t.donated_cents)}</div></div>
        <div><div class="label">Al besteed</div><div class="value">${euro(t.spent_cents)}</div></div>
        <div><div class="label">Wacht in je cellen</div><div class="value">${euro(t.waiting_cents)}</div></div>
        <div><div class="label">Leaderboard</div><div class="value">${o.rank ? `#${o.rank}` : '—'}<span class="muted" style="font-size:13px;font-weight:400"> ${o.rank ? `van ${o.ranked_donors}` : ''}</span></div></div>
      </div>
    </section>

    ${o.unread ? `<a href="#/berichten" class="card" style="display:flex;gap:14px;align-items:center;margin-bottom:16px;text-decoration:none;color:inherit">
      <span class="cat-ico lg" style="--c:var(--accent)">${RF.icon('mail-open')}</span>
      <div style="flex:1"><div style="font-weight:600">${o.unread} ${o.unread === 1 ? 'nieuw bericht' : 'nieuwe berichten'} van wie je hebt geholpen</div>
      <div class="muted small">Brieven, foto's en filmpjes van kinderen, gezinnen en scholen</div></div>
      <span class="btn btn-ghost btn-sm">Bekijken ${RF.icon('arrow-right', 'icon-sm')}</span></a>` : ''}

    <div class="grid grid-3-2">
      <div class="card"><div class="card-head"><h2>Wat jouw geld heeft gedaan</h2>${t.recipients ? `<span class="small muted">${t.recipients} ${t.recipients === 1 ? 'ontvanger' : 'ontvangers'} geholpen</span>` : ''}</div>
        ${impact.length ? `<div class="grid grid-2" style="gap:10px">${impact.map((r) => `<div style="display:flex;gap:12px;align-items:center;padding:14px;border:1px solid var(--border);border-radius:12px">
          ${RF.catIcon(r, 'lg')}<div><div style="font-size:18px;font-weight:600;letter-spacing:-.01em" class="num">${r.unit_cost_cents ? esc(RF.unitsText(r, r.units_funded)) : euro(r.spent_cents)}</div>
          <div class="small muted">${r.unit_cost_cents ? esc(r.name) : 'noodhulp na stormen'}</div></div></div>`).join('')}</div>`
          : RF.emptyState({ icon: 'piggy-bank', title: 'Je geld staat nog veilig in je cellen', text: 'Zodra het wordt besteed, zie je hier wat het heeft opgeleverd.' })}
      </div>
      <div class="card"><div class="card-head"><h2>Per bestemming</h2>
        <div class="legend"><span><i style="background:var(--spent)"></i>Besteed</span><span><i style="background:var(--waiting)"></i>In cel</span></div></div>
        ${o.impact.filter((r) => r.donated_cents).map((r) => `<div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">${RF.catLabel(r, r.name)}<b class="num" style="font-weight:600">${euro(r.donated_cents)}</b></div>
          ${RF.splitBar(r.spent_cents, r.waiting_cents)}</div>`).join('') || '<p class="muted small">Nog geen donaties.</p>'}
      </div>
    </div>

    <div class="section-title"><h2>Je cellen</h2><span class="small muted">Geld dat klaarstaat om te worden uitgegeven</span></div>
    ${openCells.length ? `<div class="cell-viz">${openCells.map((c) => `<div class="cell-chip">
        <div class="cat-name">${RF.catIcon(c, 'sm')}<span class="muted">${esc(c.category_name)}</span></div>
        <div class="amt">${euro(c.remaining_cents)}</div>
        <div class="small muted">van ${euro(c.amount_cents)} · sinds ${date(c.received_at)}</div>
        <div class="fill"><span style="width:${(c.remaining_cents / c.amount_cents) * 100}%"></span></div></div>`).join('')}</div>`
      : `<div class="card">${RF.emptyState({ icon: 'check-check', title: 'Al je geld is besteed', text: 'Dankjewel! Wil je nog meer kinderen helpen?', action: `<a class="btn btn-primary btn-sm" href="#/doneren">${RF.icon('heart')}Doneer opnieuw</a>` })}</div>`}

    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Laatst besteed</h2><a href="#/reis">Alles bekijken</a></div>
        <div class="list">${journey.slice(0, 4).map(journeyItem).join('') || RF.emptyState({ icon: 'hourglass', title: 'Nog niets besteed' })}</div></div>
      <div class="card flush"><div class="card-head"><h2>Mijn donaties</h2><a href="#/jaaroverzicht">Jaaroverzicht</a></div>
        <div class="table-wrap cards"><table><thead><tr><th>Bestemming</th><th>Status</th><th class="num">Bedrag</th></tr></thead><tbody>
        ${donations.slice(0, 6).map((d) => `<tr><td data-label="Bestemming">${RF.catLabel(d)}<span class="sub">${date(d.received_at)}${d.frequency !== 'eenmalig' ? ` · ${esc(label('frequency', d.frequency))}` : ''}</span></td>
          <td data-label="Status">${d.status === 'ontvangen' ? RF.badge('cell', d.cell_status) : RF.badge('donation', d.status)}</td><td class="num" data-label="Bedrag"><b style="font-weight:600">${euro(d.amount_cents)}</b></td></tr>`).join('')
          || `<tr><td colspan="3" class="empty">Nog geen donaties</td></tr>`}
        </tbody></table></div></div>
    </div>`;
}

function journeyItem(j) {
  const pct = Math.round(j.share * 100);
  return `<div class="list-row">
    ${j.recipient_photo ? `<img src="${esc(j.recipient_photo)}" alt="" style="width:36px;height:36px;border-radius:10px;object-fit:cover;flex:none;background:var(--surface-2)">` : RF.catIcon(j, 'lg')}
    <div class="grow"><div class="title">${j.recipient_name ? esc(j.recipient_name) : esc(j.category_name)}</div>
    <div class="meta">${esc(j.category_name)} · ${date(j.spent_at)}${j.units ? ` · ${pct}% van ${esc(RF.unitsText(j, j.units))}` : ''}</div></div>
    <div class="end"><b style="font-weight:600">${euro(j.amount_cents)}</b><div class="small">${j.messages.length ? `<a href="#/berichten">${j.messages.length} ${j.messages.length === 1 ? 'bericht' : 'berichten'}</a>` : '<span class="muted">bericht volgt</span>'}</div></div></div>`;
}

// ======================================================================= REIS VAN HET GELD
async function renderJourney() {
  const [journey, donations] = await Promise.all([api('/api/portal/journey'), api('/api/portal/donations')]);
  // Groepeer per donatie: van donatie -> cel -> bestedingen
  const byCell = new Map();
  for (const j of journey) {
    if (!byCell.has(j.cell_id)) byCell.set(j.cell_id, []);
    byCell.get(j.cell_id).push(j);
  }
  const received = donations.filter((d) => d.status === 'ontvangen');
  view().innerHTML = `
    <div class="page-head"><div><h1>Waar gaat mijn geld heen?</h1><div class="sub">Per donatie de hele reis: van jouw gift, via je eigen cel, tot wie ermee geholpen is</div></div></div>
    <div class="stack">
    ${received.map((d) => {
      const steps = byCell.get(d.cell_id) || [];
      const spent = d.amount_cents - (d.remaining_cents ?? 0);
      return `<div class="card">
        <div class="card-head"><span class="cat-name">${RF.catIcon(d, 'lg')}<span><b style="font-size:16px;font-weight:600" class="num">${euro(d.amount_cents)}</b><span class="sub">${esc(d.category_name)} · ${date(d.received_at)}</span></span></span>${RF.badge('cell', d.cell_status)}</div>
        ${RF.splitBar(spent, d.remaining_cents ?? 0)}
        <ul class="timeline" style="margin-top:14px">
          <li><div class="when">${date(d.received_at)}</div>Je donatie is ontvangen${d.frequency !== 'eenmalig' ? ` (${esc(label('frequency', d.frequency).toLowerCase())})` : ''}</li>
          <li><div class="when">${date(d.received_at)}</div>Opgeslagen in je eigen cel <span class="small muted">#${d.cell_id}</span></li>
          ${steps.map((j) => `<li><div class="when">${date(j.spent_at)}</div>
            <b class="num">${euro(j.amount_cents)}</b> besteed aan ${esc(j.category_name.toLowerCase())}${j.recipient_name ? ` voor <b>${esc(j.recipient_name)}</b>` : ''}
            ${j.recipient_location ? `<span class="muted">in ${esc(j.recipient_location)}, ${esc(j.recipient_country)}</span>` : ''}
            <div class="small muted">${esc(j.description)}${j.units ? ` — jouw deel: ${Math.round(j.share * 100)}% van ${esc(RF.unitsText(j, j.units))}` : ''}</div>
            ${j.recipient_story ? `<div class="small" style="margin-top:6px;padding-left:10px;border-left:2px solid var(--border);color:var(--text-2)">${esc(j.recipient_story)}</div>` : ''}
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${j.messages.length ? j.messages.map((m) => `<a class="tag" href="#/berichten" style="text-decoration:none">${RF.icon(RF.MESSAGE_ICONS[m.type] || 'mail', 'icon-sm')}&nbsp;${esc(m.title)}</a>`).join('') : '<span class="small muted">Bericht van de ontvanger volgt</span>'}</div>
          </li>`).join('')}
          ${d.remaining_cents > 0 ? `<li><div class="when">Nu</div><b class="num">${euro(d.remaining_cents)}</b> wacht nog in je cel tot het wordt uitgegeven.</li>` : ''}
        </ul></div>`;
    }).join('') || `<div class="card">${RF.emptyState({ icon: 'heart', title: 'Nog geen donaties', text: 'Doe je eerste donatie en volg precies waar je geld heen gaat.', action: `<a class="btn btn-primary btn-sm" href="#/doneren">${RF.icon('heart')}Doneer</a>` })}</div>`}
    </div>`;
}

// ======================================================================= BERICHTEN
async function renderMessages() {
  const msgs = await api('/api/portal/messages');
  view().innerHTML = `
    <div class="page-head"><div><h1>Berichten</h1><div class="sub">Brieven, foto’s en filmpjes van wie je hebt geholpen</div></div></div>
    <div class="stack" style="max-width:760px">${msgs.map((m) => `<article class="card message-card" data-id="${m.id}" data-read="${m.read_at ? 1 : 0}">
      <div style="display:flex;gap:12px;align-items:center">
        ${m.recipient_photo ? `<img src="${esc(m.recipient_photo)}" alt="" style="width:40px;height:40px;border-radius:12px;object-fit:cover;margin:0;flex:none">` : RF.catIcon(m, 'lg')}
        <div style="flex:1;min-width:0"><div style="font-weight:600">${m.read_at ? '' : '<span class="unread-dot" title="Nieuw"></span>'}${esc(m.recipient_name || m.title)}</div>
        <div class="small muted">${m.recipient_location ? `${esc(m.recipient_location)}, ${esc(m.recipient_country)} · ` : ''}${dateTime(m.delivered_at)}</div></div>
        <span class="tag">${RF.icon(RF.MESSAGE_ICONS[m.type] || 'mail', 'icon-sm')}&nbsp;${esc(label('message', m.type))}</span></div>
      <h2 style="margin:16px 0 0">${esc(m.title)}</h2>
      ${RF.mediaHtml(m.type, m.media_url, m.title)}
      ${m.body ? `<div class="${m.type === 'brief' ? 'letter' : ''}" style="white-space:pre-line">${esc(m.body)}</div>` : ''}
      <div class="callout neutral" style="margin:14px 0 0">${RF.catIcon(m, 'sm')}<span>${esc(m.category_name)} · besteed op ${date(m.spent_at)} · jouw bijdrage <b>${euro(m.my_share_cents)}</b></span></div>
    </article>`).join('') || `<div class="card">${RF.emptyState({ icon: 'mail-open', title: 'Nog geen berichten', text: 'Zodra je geld wordt uitgegeven, sturen de kinderen, gezinnen en scholen je een brief, foto of filmpje.' })}</div>`}</div>`;
  // Markeer als gelezen zodra het bericht in beeld komt.
  const io = new IntersectionObserver((entries) => {
    entries.forEach(async (e) => {
      if (!e.isIntersecting || e.target.dataset.read === '1') return;
      e.target.dataset.read = '1';
      io.unobserve(e.target);
      await api(`/api/portal/messages/${e.target.dataset.id}/read`, { method: 'POST', body: {} });
      setTimeout(() => { const dot = e.target.querySelector('.unread-dot'); if (dot) dot.remove(); refreshUnread(); }, 1200);
    });
  }, { threshold: 0.6 });
  view().querySelectorAll('[data-read="0"]').forEach((el) => io.observe(el));
}

// ======================================================================= DONEREN
async function renderDonate() {
  const [cats, campaigns] = await Promise.all([api('/api/portal/categories'), api('/api/portal/campaigns')]);
  const presets = { schoolmaaltijd: [1000, 2500, 5000], schoolgeld: [5000, 15000, 30000], noodfonds: [2500, 5000, 10000], gezondheidspakket: [2500, 5000, 10000] };
  view().innerHTML = `
    <div class="page-head"><div><h1>Doneer</h1><div class="sub">Kies waar je geld heen gaat. Je volgt het tot het moment dat het wordt uitgegeven.</div></div></div>
    <div class="grid grid-3-2">
      <form class="card" id="donate-form">
        <div class="step-title"><span class="n">1</span>Kies een bestemming</div>
        <div class="cat-picker">${cats.map((c, i) => `<label><input type="radio" name="category_key" value="${esc(c.key)}" ${i === 0 ? 'checked' : ''}>
          ${RF.catIcon(c, 'lg')}<span><span class="t">${esc(c.name)}</span><span class="small muted" style="display:block">${esc(c.description)}</span>
          <span class="small" style="display:block;margin-top:6px;font-weight:500">${c.unit_cost_cents ? `${euro(c.unit_cost_cents)} per ${esc(c.unit_label)}` : 'Elk bedrag helpt'}</span></span></label>`).join('')}</div>
        <div class="step-title"><span class="n">2</span>Kies een bedrag</div>
        <div class="amount-picker" id="presets"></div>
        <div class="field"><label>Of vul zelf een bedrag in (€)</label><input type="text" name="amount" inputmode="decimal" placeholder="bv. 20"></div>
        <div class="impact-preview" id="preview"></div>
        <div class="field-row">
          <div class="field"><label>Hoe vaak?</label><select name="frequency">${Object.entries(RF.LABELS.frequency).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          ${campaigns.length ? `<div class="field"><label>Campagne (optioneel)</label><select name="campaign_id"><option value="">—</option>${campaigns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>` : ''}
        </div>
        <p class="form-error" hidden style="margin:0 0 12px"></p>
        <button class="btn btn-primary btn-lg btn-block">${RF.icon('heart')}Doneer nu via iDEAL</button>
        <p class="hint" style="text-align:center">Demo-omgeving: er wordt niet echt betaald.</p>
      </form>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Zo werkt het</h2></div>
          <ol style="padding-left:18px;margin:0;line-height:1.7;color:var(--text-2)">
            <li>Je donatie komt in een <b>eigen cel</b> — gescheiden van ander geld.</li>
            <li>Zodra er een maaltijd, schoolgeld, noodhulp of pakket nodig is, wordt jouw cel <b>getriggerd</b>.</li>
            <li>Je krijgt bericht en ziet precies <b>waar en aan wie</b> je geld is besteed.</li>
            <li>Je ontvangt een <b>brief, foto of filmpje</b> van degene die je hebt geholpen.</li>
          </ol></div>
        ${campaigns.map((c) => {
          const pct = c.goal_cents ? Math.min(100, (c.raised_cents / c.goal_cents) * 100) : 0;
          return `<div class="card"><div class="small muted" style="display:flex;align-items:center;gap:6px;margin-bottom:6px">${RF.icon('megaphone', 'icon-sm')}Campagne</div>
            <h3 style="margin:0 0 4px">${esc(c.name)}</h3><p class="small muted">${esc(c.description)}</p>
            <div class="meter"><span style="width:${pct}%"></span></div>
            <div class="small" style="margin-top:8px;display:flex;justify-content:space-between"><b class="num">${euro0(c.raised_cents)}</b><span class="muted">van ${euro0(c.goal_cents)}</span></div></div>`;
        }).join('')}
      </div>
    </div>`;
  const form = $('#donate-form');
  let preset = null;
  const cat = () => cats.find((c) => c.key === form.elements.category_key.value);
  const amount = () => (form.elements.amount.value ? toCents(form.elements.amount.value) : preset);
  const drawPresets = () => {
    const list = presets[cat().key] || [1000, 2500, 5000];
    if (!list.includes(preset)) preset = list[1];
    $('#presets').innerHTML = list.map((v) => `<button type="button" data-v="${v}" class="${v === preset && !form.elements.amount.value ? 'active' : ''}">${euro0(v)}</button>`).join('');
  };
  const update = () => {
    const c = cat();
    const a = amount();
    $('#preview').innerHTML = !a || isNaN(a) ? 'Kies een bedrag'
      : c.unit_cost_cents ? `${euro(a)} = ${esc(RF.unitsText(c, a / c.unit_cost_cents))} ${c.key === 'schoolgeld' && a < c.unit_cost_cents ? '(samen met andere donateurs)' : ''}`
        : `${euro(a)} gaat direct naar het noodfonds voor stormen en orkanen`;
  };
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    preset = Number(b.dataset.v); form.elements.amount.value = ''; drawPresets(); update();
  });
  form.addEventListener('change', (e) => { if (e.target.name === 'category_key') drawPresets(); update(); });
  form.elements.amount.addEventListener('input', () => { drawPresets(); update(); });
  drawPresets(); update();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    err.hidden = true;
    try {
      const f = RF.formData(form);
      await api('/api/portal/donate', { method: 'POST', body: { category_key: f.category_key, amount_cents: amount(), frequency: f.frequency, campaign_id: f.campaign_id || null } });
      toast('Dankjewel! Je donatie staat in je eigen cel.');
      location.hash = '#/overzicht';
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

// ======================================================================= CHAT
async function renderChat(openId) {
  const convs = await api('/api/portal/conversations');
  const selected = openId ? Number(openId) : null;
  view().innerHTML = `
    <div class="page-head"><div><h1>Chat</h1><div class="sub">Praat met de kinderen, scholen en projecten die je hebt geholpen</div></div></div>
    <div class="callout neutral">${RF.icon(me.anonymous ? 'eye-off' : 'user')}<span>${me.anonymous ? 'Je bent anoniem: ontvangers zien je als “Anonieme donateur”.' : `Ontvangers zien je als <b>${esc(me.public_name)}</b>.`} <a href="#/profiel">Wijzigen</a></span></div>
    <div class="chat-layout ${selected ? 'has-open' : ''}">
      <div class="card chat-list">
        ${convs.map((c) => `<button data-id="${c.id}" class="${c.id === selected ? 'active' : ''}">
          ${c.photo_url ? `<img src="${esc(c.photo_url)}" alt="">` : `<div class="avatar">${esc(c.name.slice(0, 1))}</div>`}
          <div style="min-width:0"><div class="who">${esc(c.name)}</div>
          <div class="last">${esc(c.last_message || [c.location, c.country].filter(Boolean).join(', '))}</div></div>
          ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}</button>`).join('')
          || `<p class="muted" style="padding:10px">Er is nog niemand om mee te chatten. Zodra Robin Foundation geld uit <b>jouw</b> cellen besteedt aan een kind, school of project, verschijnt die ontvanger hier.
            <a href="#/reis">Bekijk waar je geld nu is →</a></p>`}
      </div>
      <div class="card" id="thread">${selected ? '' : '<p class="muted">Kies een gesprek om te chatten.</p>'}</div>
    </div>`;
  view().querySelectorAll('.chat-list button[data-id]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/chat/${b.dataset.id}`; }));
  const c = convs.find((x) => x.id === selected);
  if (!c) return;
  $('#thread').innerHTML = `<div class="card-head"><div><h2 style="margin:0">${esc(c.name)}</h2>
      <div class="small muted">${esc([c.age ? `${c.age} jaar` : '', c.location, c.country].filter(Boolean).join(' · '))}</div></div>
      <a class="btn btn-ghost btn-sm" href="#/chat">← Terug</a></div><div id="box"></div>`;
  const noLogin = c.has_login ? '' : `${esc(c.name)} heeft nog geen account. Je bericht wordt bewaard en verschijnt zodra ${esc(c.name)} kan inloggen.<br>`;
  await RF.chatBox($('#box'), {
    otherName: c.name,
    notice: noLogin + (c.chat_moderated
      ? 'Berichten worden eerst door een begeleider gelezen voordat ze worden afgeleverd. Deel geen contactgegevens en vraag niet om die van de ontvanger.'
      : 'Deel geen contactgegevens; berichten met telefoonnummers, adressen of links worden eerst gecontroleerd.'),
    load: () => api(`/api/portal/conversations/${c.id}`),
    setLanguage: async (language) => { await api('/api/portal/language', { method: 'PUT', body: { language } }); me.language = language; },
    send: (body) => api(`/api/portal/conversations/${c.id}`, { method: 'POST', body: { body } }),
  });
  refreshUnread();
}

// ======================================================================= LEADERBOARD
async function renderLeaderboard() {
  view().innerHTML = `
    <div class="page-head"><div><h1>Leaderboard</h1><div class="sub">Samen maken we het verschil</div></div>
      <div class="toolbar"><select id="f-period"><option value="all">Altijd</option><option value="year">Dit jaar</option><option value="month">Deze maand</option></select>
      <select id="f-cat"><option value="">Alle bestemmingen</option></select></div></div>
    <p class="muted">Je verschijnt hier als <b>${esc(me.anonymous ? 'Anonieme donateur' : me.public_name)}</b>. <a href="#/profiel">Wijzig in je privacy-instellingen</a>.</p>
    <div class="card" id="lb"></div>`;
  const cats = await api('/api/portal/categories');
  $('#f-cat').innerHTML += cats.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join('');
  const load = async () => {
    const rows = await api(`/api/portal/leaderboard?period=${$('#f-period').value}&category=${$('#f-cat').value}&limit=100`);
    $('#lb').innerHTML = leaderboardRows(rows);
    const mine = $('#lb .me');
    if (mine) mine.scrollIntoView({ block: 'nearest' });
  };
  $('#f-period').onchange = load;
  $('#f-cat').onchange = load;
  await load();
}

function leaderboardRows(rows) {
  if (!rows.length) return '<p class="empty">Nog geen donaties in deze periode.</p>';
  return rows.map((r) => `<div class="lb-row ${r.rank <= 3 ? `top${r.rank}` : ''} ${r.is_me ? 'me' : ''}">
    <div class="lb-rank">${r.rank <= 3 ? `<span class="medal m${r.rank}">${r.rank}</span>` : r.rank}</div>
    <div><div class="lb-name">${r.anonymous ? `<span class="anon">${RF.icon('eye-off', 'icon-sm')}${esc(r.name)}</span>` : esc(r.name)} ${r.is_me ? '<span class="badge badge-admin">jij</span>' : ''}</div>
      <div class="lb-meta">${r.donation_count} ${r.donation_count === 1 ? 'gift' : 'giften'}${r.city ? ` · ${esc(r.city)}` : ''}${r.messages ? ` · ${r.messages} berichten ontvangen` : ''}</div></div>
    <div class="lb-amount">${euro0(r.total_cents)}</div></div>`).join('');
}

// ======================================================================= JAAROVERZICHT
async function renderAnnual(y) {
  const year = y || new Date().getFullYear();
  const a = await api(`/api/portal/annual?year=${year}`);
  const years = []; for (let i = new Date().getFullYear(); i >= new Date().getFullYear() - 5; i--) years.push(i);
  view().innerHTML = `
    <div class="page-head"><div><h1>Jaaroverzicht ${esc(a.year)}</h1><div class="sub">Voor je belastingaangifte (giften aan een ANBI)</div></div>
      <div class="toolbar"><select id="f-year">${years.map((v) => `<option ${String(v) === a.year ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button class="btn btn-ghost" onclick="window.print()">${RF.icon('printer')}<span>Afdrukken of PDF</span></button></div></div>
    <div class="card">
      <h2>Giftenoverzicht ${esc(a.year)}</h2>
      <p><b>${esc(a.organisation.name)}</b> · ${esc(a.organisation.anbi)} · RSIN ${esc(a.organisation.rsin)}</p>
      <p>${esc(a.donor.full_name)}<br>${esc(a.donor.street)}<br>${esc(a.donor.postal_code)} ${esc(a.donor.city)}</p>
      <div class="table-wrap cards"><table><thead><tr><th>Datum</th><th>Bestemming</th><th>Betaalwijze</th><th>Kenmerk</th><th class="num">Bedrag</th></tr></thead><tbody>
      ${a.donations.map((d) => `<tr><td data-label="Datum">${date(d.received_at)}</td><td data-label="Bestemming">${esc(d.category_name)}</td><td data-label="Betaalwijze">${esc(label('method', d.method))}</td><td class="small muted" data-label="Kenmerk">${esc(d.reference)}</td><td class="num" data-label="Bedrag">${euro(d.amount_cents)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Geen giften in dit jaar</td></tr>'}
      </tbody><tfoot><tr><th colspan="4">Totaal</th><th class="num">${euro(a.total_cents)}</th></tr></tfoot></table></div>
      <p class="small muted" style="margin-top:12px">In ${esc(a.year)} is ${euro(a.spent_in_year_cents)} van jouw giften besteed aan projecten. Giften aan een ANBI zijn onder voorwaarden aftrekbaar voor de inkomstenbelasting.</p>
    </div>`;
  $('#f-year').onchange = (e) => renderAnnual(e.target.value);
}

// ======================================================================= PROFIEL
async function renderProfile() {
  me = await api('/api/donor/me');
  view().innerHTML = `
    <div class="page-head"><div><h1>Profiel & privacy</h1><div class="sub">Je gegevens, je taal en hoe je zichtbaar bent op het leaderboard</div></div></div>
    <div class="grid grid-2">
      <form class="card" id="privacy">
        <h2>Leaderboard & privacy</h2>
        <label class="check" style="font-size:1rem"><input type="checkbox" name="anonymous" ${me.anonymous ? 'checked' : ''}> <span><b>Blijf anoniem</b><br><span class="small muted">Op het leaderboard verschijn je dan als “Anonieme donateur”. Je donaties tellen wel mee.</span></span></label>
        <div class="field" style="margin-top:10px"><label>Weergavenaam (als je niet anoniem bent)</label><input type="text" name="display_name" value="${esc(me.display_name)}" placeholder="${esc(`${me.first_name} ${me.last_name ? `${me.last_name[0]}.` : ''}`)}">
          <div class="hint">Leeg = je voornaam en de eerste letter van je achternaam.</div></div>
        <p>Voorbeeld: <b id="preview-name"></b></p>
        <label class="check"><input type="checkbox" name="newsletter" ${me.newsletter ? 'checked' : ''}> Nieuwsbrief ontvangen</label>
        <div class="field"><label>Mijn taal (voor de chat)</label><select name="language" id="lang-select"></select>
          <div class="hint">Berichten van ontvangers worden automatisch naar deze taal vertaald, en jij kunt in deze taal terugschrijven.</div></div>
        <div class="field"><label>Hoe willen we je bereiken?</label><select name="preferred_channel">
          ${[['email', 'E-mail'], ['post', 'Post'], ['telefoon', 'Telefoon'], ['whatsapp', 'WhatsApp']].map(([k, v]) => `<option value="${k}" ${me.preferred_channel === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <button class="btn btn-primary">Opslaan</button>
      </form>
      <div class="stack">
        <form class="card" id="details">
          <h2>Mijn gegevens</h2>
          <div class="field-row"><div class="field"><label>Voornaam</label><input type="text" name="first_name" value="${esc(me.first_name)}"></div>
            <div class="field"><label>Achternaam</label><input type="text" name="last_name" value="${esc(me.last_name)}"></div></div>
          <div class="field"><label>E-mail</label><input type="email" value="${esc(me.email)}" disabled><div class="hint">Wijzigen? Neem contact met ons op.</div></div>
          <div class="field"><label>Telefoon</label><input type="text" name="phone" value="${esc(me.phone)}"></div>
          <div class="field-row"><div class="field"><label>Adres</label><input type="text" name="street" value="${esc(me.street)}"></div>
            <div class="field"><label>Postcode</label><input type="text" name="postal_code" value="${esc(me.postal_code)}"></div>
            <div class="field"><label>Plaats</label><input type="text" name="city" value="${esc(me.city)}"></div></div>
          <p class="hint">Je adres gebruiken we voor je jaaroverzicht (belastingaangifte).</p>
          <button class="btn btn-primary">Opslaan</button>
        </form>
        <form class="card" id="pw">
          <h2>Wachtwoord wijzigen</h2>
          <div class="field"><label>Huidig wachtwoord</label><input type="password" name="current" required autocomplete="current-password"></div>
          <div class="field"><label>Nieuw wachtwoord</label><input type="password" name="password" minlength="8" required autocomplete="new-password"></div>
          <button class="btn btn-ghost">Wijzigen</button>
        </form>
      </div>
    </div>`;
  RF.api('/api/public/translation').then((t) => {
    $('#lang-select').innerHTML = Object.entries(t.languages).map(([k, v]) => `<option value="${k}" ${(me.language || 'nl') === k ? 'selected' : ''}>${esc(v)}</option>`).join('');
  });
  const pf = $('#privacy');
  const preview = () => {
    const anon = pf.elements.anonymous.checked;
    $('#preview-name').textContent = anon ? 'Anonieme donateur' : (pf.elements.display_name.value || `${me.first_name}${me.last_name ? ` ${me.last_name[0].toUpperCase()}.` : ''}`);
  };
  pf.addEventListener('input', preview);
  preview();
  const save = (form, url) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const isPw = url.includes('password');
        const res = await api(url, { method: isPw ? 'POST' : 'PUT', body: RF.formData(form) });
        if (isPw) form.reset(); else me = res;
        toast('Opgeslagen');
      }
      catch (ex) { toast(ex.message, 'error'); }
    };
  };
  save(pf, '/api/portal/profile');
  save($('#details'), '/api/portal/profile');
  save($('#pw'), '/api/portal/password');
}

boot();

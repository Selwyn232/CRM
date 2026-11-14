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
  $('#donate-btn').innerHTML = `${RF.icon('heart')}<span>Sponsor een kind</span>`;
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
  overzicht: renderOverview, kinderen: renderChildren, sponsoren: renderSponsor, doneren: renderSponsor,
  berichten: renderMessages,
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
    const kids = await api('/api/portal/my-children');
    const n = kids.reduce((s, k) => s + k.unread_updates, 0);
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
const childPhoto = (c, cls = '') => (c.photo_url
  ? `<img class="child-photo ${cls}" src="${esc(c.photo_url)}" alt="${esc(c.first_name)}" loading="lazy">`
  : `<div class="child-photo ${cls} ph">${esc((c.first_name || '?').slice(0, 1))}</div>`);
const childMeta = (c) => [c.age != null ? `${c.age} jaar` : '', c.grade, [c.city, c.province].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
const monthName = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
let sponsorConfig = null;
const getConfig = async () => (sponsorConfig = sponsorConfig || await api('/api/portal/sponsor/config'));

function breakdownHtml(cfg, times = 1) {
  return `<div class="breakdown">${cfg.parts.map((p) => `<div class="bd-row">
    <span class="bd-ico">${RF.icon(p.icon || 'circle')}</span>
    <div class="grow"><div class="t">${esc(p.label)}</div><div class="small muted">${esc(p.description)}</div></div>
    <b class="num">${euro(p.cents * times)}</b></div>`).join('')}
    <div class="bd-row total"><div class="grow">Per maand${times > 1 ? ` voor ${times} kinderen` : ''}</div><b class="num">${euro(cfg.amount_cents * times)}</b></div></div>`;
}

async function renderOverview() {
  const [o, kids, cfg] = await Promise.all([api('/api/portal/overview'), api('/api/portal/my-children'), getConfig()]);
  me = o.donor;
  const sp = o.sponsor;
  view().innerHTML = `
    <section class="hero">
      <div class="eyebrow">${RF.icon('heart', 'icon-sm')} Jouw sponsorkinderen</div>
      <h1>${greet()}, ${esc(me.first_name || me.full_name)}</h1>
      <p>${sp.children ? `Dankzij jou ${sp.children === 1 ? 'gaat' : 'gaan'} ${sp.children} ${sp.children === 1 ? 'kind' : 'kinderen'} op de Filipijnen elke dag met een volle buik naar school.`
        : `Voor ${euro(cfg.amount_cents)} per maand geef je één kind op de Filipijnen elke schooldag een maaltijd, schoolgeld en basisverzorging. Je weet precies wie je helpt en kunt met het gezin chatten.`}</p>
      <div class="hero-stats">
        <div><div class="label">Mijn kinderen</div><div class="value">${sp.children}</div></div>
        <div><div class="label">Per maand</div><div class="value">${euro(sp.monthly_cents)}</div></div>
        <div><div class="label">Totaal gesponsord</div><div class="value">${euro(sp.sponsored_cents)}</div></div>
        <div><div class="label">Leaderboard</div><div class="value">${o.rank ? `#${o.rank}` : '—'}<span class="muted" style="font-size:13px;font-weight:400"> ${o.rank ? `van ${o.ranked_donors}` : ''}</span></div></div>
      </div>
    </section>
    ${sp.unread_updates ? `<a href="#/kinderen" class="card linkcard">
      <span class="cat-ico lg" style="--c:var(--accent)">${RF.icon('image')}</span>
      <div style="flex:1"><div style="font-weight:600">${sp.unread_updates} ${sp.unread_updates === 1 ? 'nieuwe update' : 'nieuwe updates'} van je sponsorkinderen</div>
      <div class="small muted">Foto’s, brieven en filmpjes</div></div><span class="btn btn-ghost btn-sm">Bekijken ${RF.icon('arrow-right', 'icon-sm')}</span></a>` : ''}
    ${kids.length ? `<div class="section-title"><h2>Mijn kinderen</h2><a href="#/sponsoren" class="small">${RF.icon('plus', 'icon-sm')} Nog een kind sponsoren</a></div>
      <div class="child-grid">${kids.map(myChildCard).join('')}</div>`
      : `<div class="card">${RF.emptyState({ icon: 'smile', title: 'Je sponsort nog geen kind', text: 'Kies een kind uit de profielen. Je ziet precies waar je geld heen gaat en ontvangt elke maand een update.', action: `<a class="btn btn-primary" href="#/sponsoren">${RF.icon('heart')}Kies een kind</a>` })}</div>`}
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Waar gaat ${euro(cfg.amount_cents)} per kind heen?</h2></div>${breakdownHtml(cfg)}</div>
      <div class="card"><div class="card-head"><h2>Zo werkt sponsoren</h2></div>
        <ol class="steps-list">
          <li>Je kiest zelf een of meer kinderen. Elk kind heeft maar <b>één sponsor</b>: jou.</li>
          <li>Elke maand wordt ${euro(cfg.amount_cents)} per kind afgeschreven en direct <b>op naam van jouw kind</b> geboekt.</li>
          <li>Je ziet per maand precies wat er van je geld is betaald.</li>
          <li>Elke maand krijg je een <b>foto, brief of filmpje</b>, en je kunt <b>chatten met het gezin</b> (automatisch vertaald).</li>
        </ol></div>
    </div>`;
}

function myChildCard(c) {
  return `<a class="card child-card" href="#/kinderen/${c.id}">
    ${childPhoto(c)}
    <div class="child-body">
      <div class="child-name">${esc(c.first_name)} ${c.unread_updates ? `<span class="pill">${c.unread_updates}</span>` : ''}</div>
      <div class="small muted">${esc(childMeta(c))}</div>
      <div class="small" style="margin-top:8px">${c.months} ${c.months === 1 ? 'maand' : 'maanden'} gesponsord · ${euro(c.total_cents)}</div>
      ${c.sponsorship_status === 'betaling_gemist' ? `<div class="small" style="color:var(--danger);margin-top:4px">${RF.icon('circle-alert', 'icon-sm')} Laatste betaling is niet gelukt</div>` : ''}
    </div></a>`;
}

// ======================================================================= MIJN KINDEREN
async function renderChildren(childId) {
  if (childId) return renderChild(childId);
  const kids = await api('/api/portal/my-children');
  view().innerHTML = `
    <div class="page-head"><div><h1>Mijn kinderen</h1><div class="sub">De kinderen die jij sponsort, met elke maand een update</div></div>
      <div class="toolbar"><a class="btn btn-primary" href="#/sponsoren">${RF.icon('plus')}<span>Kind toevoegen</span></a></div></div>
    ${kids.length ? `<div class="child-grid">${kids.map(myChildCard).join('')}</div>`
      : `<div class="card">${RF.emptyState({ icon: 'smile', title: 'Je sponsort nog geen kind', action: `<a class="btn btn-primary" href="#/sponsoren">${RF.icon('heart')}Kies een kind</a>` })}</div>`}`;
}

async function renderChild(childId) {
  const d = await api(`/api/portal/my-children/${childId}`);
  const c = d.child;
  const maxTotal = Math.max(1, ...d.totals.map((t) => t.cents));
  view().innerHTML = `
    <a href="#/kinderen" class="back-link">${RF.icon('arrow-left', 'icon-sm')} Mijn kinderen</a>
    <section class="card child-hero">
      ${childPhoto(c, 'xl')}
      <div class="grow">
        <h1 style="margin:0">${esc(c.first_name)}</h1>
        <div class="muted">${esc(childMeta(c))}${c.school ? ` · ${esc(c.school)}` : ''}</div>
        <div class="child-stats">
          <div><div class="label">Sponsor sinds</div><div class="value">${date(c.started_at)}</div></div>
          <div><div class="label">Maanden</div><div class="value">${c.months}</div></div>
          <div><div class="label">Totaal</div><div class="value">${euro(c.total_cents)}</div></div>
        </div>
        <div class="toolbar" style="margin-top:14px">
          ${c.can_chat ? `<a class="btn btn-primary btn-sm" href="#/chat/${c.family_id}">${RF.icon('message-circle')}Chat met het gezin</a>` : ''}
        </div>
      </div>
    </section>
    <div class="grid grid-3-2" style="margin-top:16px">
      <div class="stack">
        ${c.story ? `<div class="card"><h2>Over ${esc(c.first_name)}</h2><p style="white-space:pre-line;margin:0">${esc(c.story)}</p></div>` : ''}
        ${c.family_story || c.family_photo ? `<div class="card"><h2>Het gezin</h2>${c.family_photo ? `<img src="${esc(c.family_photo)}" alt="Gezin van ${esc(c.first_name)}" class="family-photo">` : ''}
          <p style="white-space:pre-line;margin:0">${esc(c.family_story)}</p></div>` : ''}
        <div class="card"><div class="card-head"><h2>Updates</h2><span class="small muted">Elke maand een foto, brief of filmpje</span></div>
          ${d.updates.length ? `<div class="stack">${d.updates.map((u, i) => `${i === 3 ? `<details class="more-updates"><summary class="link">Oudere updates (${d.updates.length - 3})</summary><div class="stack">` : ''}<article class="update">
            <div class="small muted">${esc(monthName(u.month))} · ${esc(label('message', u.type))}</div>
            <h3 style="margin:4px 0 8px">${esc(u.title)}</h3>
            ${RF.mediaHtml(u.type, u.media_url, u.title)}
            ${u.body ? `<div class="${u.type === 'brief' ? 'letter' : ''}" style="white-space:pre-line">${esc(u.body)}</div>` : ''}</article>`).join('')}${d.updates.length > 3 ? '</div></details>' : ''}</div>`
            : RF.emptyState({ icon: 'image', title: 'De eerste update komt eraan', text: `Binnen een maand ontvang je een foto of brief van ${esc(c.first_name)}.` })}
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Wat jouw geld deed</h2><span class="small muted">totaal</span></div>
          ${d.totals.length ? d.totals.map((t) => `<div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><span class="cat-name"><span class="bd-ico sm">${RF.icon(t.icon || 'circle', 'icon-sm')}</span>${esc(t.label)}</span><b class="num">${euro(t.cents)}</b></div>
            <div class="meter"><span style="width:${(t.cents / maxTotal) * 100}%"></span></div></div>`).join('') : '<p class="muted small">Nog geen maand geboekt.</p>'}
        </div>
        <div class="card"><div class="card-head"><h2>Per maand</h2></div>
          ${d.months.map((m) => `<details class="month"><summary><span>${esc(monthName(m.month))}</span><b class="num">${euro(m.amount_cents)}</b></summary>
            ${m.lines.map((l) => `<div class="bd-row"><span class="bd-ico sm">${RF.icon(l.icon || 'circle', 'icon-sm')}</span><div class="grow small">${esc(l.label)}</div><span class="num small">${euro(l.cents)}</span></div>`).join('')}
          </details>`).join('') || '<p class="muted small">Nog geen maand geboekt.</p>'}
        </div>
        <div class="card"><h2>Sponsoring stoppen</h2>
          <p class="small muted">Stop je, dan zoeken we een nieuwe sponsor voor ${esc(c.first_name)} zodat de hulp doorgaat.</p>
          <button class="btn btn-ghost btn-sm" id="stop">Sponsoring van ${esc(c.first_name)} stoppen</button></div>
      </div>
    </div>`;
  $('#stop').onclick = async () => {
    if (!await RF.confirmDialog(`Weet je zeker dat je stopt met het sponsoren van ${c.first_name}? De maandelijkse betaling voor ${c.first_name} stopt dan.`, 'Ja, stoppen')) return;
    try { await api(`/api/portal/my-children/${c.id}/stop`, { method: 'POST', body: {} }); toast(`Sponsoring van ${c.first_name} is gestopt`); location.hash = '#/kinderen'; }
    catch (ex) { toast(ex.message, 'error'); }
  };
}

// ======================================================================= KIND KIEZEN
async function renderSponsorDone(donationId) {
  const draw = (d) => {
    const ok = d.status === 'ontvangen'; const bad = d.status === 'geannuleerd';
    view().innerHTML = `<div class="card" style="max-width:520px;margin:40px auto">${RF.emptyState({
      icon: ok ? 'party-popper' : bad ? 'circle-x' : 'hourglass',
      title: ok ? 'Welkom als sponsor!' : bad ? 'De betaling is niet gelukt' : 'Je betaling wordt bevestigd…',
      text: ok ? 'Je sponsorschap is gestart en de eerste maand is geboekt. Elke maand ontvang je een update.'
        : bad ? 'Er is niets afgeschreven. Je kunt het opnieuw proberen.' : 'Dit duurt meestal maar een paar seconden.',
      action: ok ? `<a class="btn btn-primary btn-sm" href="#/kinderen">Naar mijn kinderen</a>` : bad ? `<a class="btn btn-primary btn-sm" href="#/sponsoren">Opnieuw proberen</a>` : '',
    })}</div>`;
    return ok || bad;
  };
  for (let i = 0; i < 20; i++) {
    const d = await api(`/api/portal/sponsor/${donationId}`);
    if (!location.hash.includes('/klaar/')) return;
    if (draw(d)) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

async function renderSponsor(sub) {
  if (sub === 'klaar') return renderSponsorDone(location.hash.split('/').pop());
  const [kids, cfg, config] = await Promise.all([api('/api/portal/children'), getConfig(), api('/api/public/config').catch(() => ({}))]);
  const picked = new Set();
  view().innerHTML = `
    <div class="page-head"><div><h1>Kies een kind</h1><div class="sub">${euro(cfg.amount_cents)} per kind per maand. Elk kind heeft één sponsor. ${kids.length} ${kids.length === 1 ? 'kind wacht' : 'kinderen wachten'} op een sponsor.</div></div></div>
    ${kids.length ? `<div class="toolbar wrap" style="margin-bottom:14px">
        <span class="small muted">Snel kiezen:</span>
        ${[1, 2, 5, 10, 20].filter((n) => n <= kids.length).map((n) => `<button type="button" class="btn btn-ghost btn-sm" data-auto="${n}">${n} ${n === 1 ? 'kind' : 'kinderen'}</button>`).join('')}
        <span class="small muted">(wie het langst wacht)</span></div>
      <div class="child-grid" id="kids">${kids.map((c) => `<label class="card child-card pick" data-id="${c.id}">
        <input type="checkbox" value="${c.id}" class="sr-only">
        ${childPhoto(c)}
        <span class="pick-check">${RF.icon('check', 'icon-sm')}</span>
        <div class="child-body">
          <div class="child-name">${esc(c.first_name)}</div>
          <div class="small muted">${esc(childMeta(c))}</div>
          ${c.story ? `<p class="small story">${esc(c.story)}</p>` : ''}
          <button type="button" class="link small" data-more="${c.id}">Lees meer</button>
        </div></label>`).join('')}</div>
      <div class="sponsor-bar" id="bar" hidden>
        <div class="grow"><b id="bar-n"></b><div class="small muted" id="bar-t"></div></div>
        <button class="btn btn-primary" id="go">${RF.icon('heart')}<span>Sponsor nu</span></button>
      </div>
      <p class="hint" style="text-align:center;margin-top:12px">${!config.payments ? 'Demo-omgeving: er wordt niet echt betaald.'
        : config.payments_mode === 'test' ? 'Testmodus: je gaat naar een testbetaling van Mollie, er wordt niets afgeschreven.'
          : 'Je betaalt de eerste maand veilig via Mollie (iDEAL); daarna wordt elke maand automatisch afgeschreven. Stoppen kan altijd.'}</p>`
      : `<div class="card">${RF.emptyState({ icon: 'party-popper', title: 'Alle kinderen hebben op dit moment een sponsor', text: 'Nieuwe kinderen worden steeds toegevoegd. Kijk binnenkort nog eens.' })}</div>`}`;
  if (!kids.length) return;
  const draw = () => {
    view().querySelectorAll('.child-card.pick').forEach((el) => {
      const on = picked.has(Number(el.dataset.id));
      el.classList.toggle('selected', on);
      el.querySelector('input').checked = on;
    });
    const n = picked.size;
    $('#bar').hidden = !n;
    $('#bar-n').textContent = `${n} ${n === 1 ? 'kind' : 'kinderen'} · ${euro(n * cfg.amount_cents)} per maand`;
    $('#bar-t').textContent = [...picked].map((id) => kids.find((k) => k.id === id).first_name).join(', ');
  };
  $('#kids').addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { e.preventDefault(); return showChild(kids.find((k) => k.id === Number(more.dataset.more))); }
    const card = e.target.closest('.child-card.pick');
    if (!card) return;
    e.preventDefault();
    const idn = Number(card.dataset.id);
    if (picked.has(idn)) picked.delete(idn); else picked.add(idn);
    draw();
  });
  view().querySelectorAll('[data-auto]').forEach((b) => b.addEventListener('click', () => {
    picked.clear(); kids.slice(0, Number(b.dataset.auto)).forEach((k) => picked.add(k.id)); draw();
  }));
  const showChild = (c) => RF.modal({
    title: c.first_name, wide: true,
    body: `<div class="child-modal">${childPhoto(c, 'xl')}<div><div class="muted">${esc(childMeta(c))}${c.school ? ` · ${esc(c.school)}` : ''}</div>
      <p style="white-space:pre-line">${esc(c.story)}</p>
      ${c.family_story ? `<h3>Het gezin</h3>${c.family_photo ? `<img src="${esc(c.family_photo)}" alt="" class="family-photo">` : ''}<p style="white-space:pre-line">${esc(c.family_story)}</p>` : ''}</div></div>`,
  });
  $('#go').onclick = () => {
    const n = picked.size;
    RF.modal({
      title: `${n} ${n === 1 ? 'kind' : 'kinderen'} sponsoren`, submitLabel: `Sponsor voor ${euro(n * cfg.amount_cents)} per maand`,
      body: `<p>Je sponsort <b>${esc([...picked].map((id) => kids.find((k) => k.id === id).first_name).join(', '))}</b>. Elke maand betaal je:</p>${breakdownHtml(cfg, n)}
        <p class="small muted" style="margin-top:12px">Het noodfondsdeel gaat naar een gezamenlijke pot voor als een orkaan of overstroming de gezinnen treft.</p>`,
      onSubmit: async () => {
        try {
          const r = await api('/api/portal/sponsor', { method: 'POST', body: { child_ids: [...picked] } });
          if (r.checkout_url) { location.href = r.checkout_url; return false; }
          toast('Welkom als sponsor! De eerste maand is geboekt.');
          location.hash = '#/kinderen';
        } catch (ex) {
          if (ex.status === 409) setTimeout(() => renderSponsor(), 1500);
          throw ex;
        }
      },
    });
  };
}

// ======================================================================= BERICHTEN
async function renderMessages() {
  const msgs = await api('/api/portal/messages');
  view().innerHTML = `
    <div class="page-head"><div><h1>Berichten</h1><div class="sub">Nieuws over het Robin Noodfonds, waaraan jij meebetaalt</div></div></div>
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
    </article>`).join('') || `<div class="card">${RF.emptyState({ icon: 'mail-open', title: 'Nog geen berichten', text: 'Wordt het noodfonds ingezet na een orkaan of overstroming, dan lees je hier wat er met jouw bijdrage is gedaan.' })}</div>`}</div>`;
  // Markeer als gelezen zodra het bericht in beeld komt.
  const io = new IntersectionObserver((entries) => {
    entries.forEach(async (e) => {
      if (!e.isIntersecting || e.target.dataset.read === '1' || me.impersonated_by) return;
      e.target.dataset.read = '1';
      io.unobserve(e.target);
      await api(`/api/portal/messages/${e.target.dataset.id}/read`, { method: 'POST', body: {} });
      setTimeout(() => { const dot = e.target.querySelector('.unread-dot'); if (dot) dot.remove(); refreshUnread(); }, 1200);
    });
  }, { threshold: 0.6 });
  view().querySelectorAll('[data-read="0"]').forEach((el) => io.observe(el));
}

// ======================================================================= CHAT
async function renderChat(openId) {
  const convs = await api('/api/portal/conversations');
  const selected = openId ? Number(openId) : null;
  view().innerHTML = `
    <div class="page-head"><div><h1>Chat</h1><div class="sub">Praat met de gezinnen van je sponsorkinderen. Berichten worden automatisch vertaald.</div></div></div>
    <div class="callout neutral">${RF.icon(me.anonymous ? 'eye-off' : 'user')}<span>${me.anonymous ? 'Je bent anoniem: ontvangers zien je als “Anonieme donateur”.' : `Ontvangers zien je als <b>${esc(me.public_name)}</b>.`} <a href="#/profiel">Wijzigen</a></span></div>
    <div class="chat-layout ${selected ? 'has-open' : ''}">
      <div class="card chat-list">
        ${convs.map((c) => `<button data-id="${c.id}" class="${c.id === selected ? 'active' : ''}">
          ${c.photo_url ? `<img src="${esc(c.photo_url)}" alt="">` : `<div class="avatar">${esc(c.name.slice(0, 1))}</div>`}
          <div style="min-width:0"><div class="who">${esc(c.name)}</div>
          <div class="last">${esc(c.last_message || [c.location, c.country].filter(Boolean).join(', '))}</div></div>
          ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}</button>`).join('')
          || `<p class="muted" style="padding:10px">Er is nog niemand om mee te chatten. Zodra je een kind sponsort, kun je hier met het gezin chatten.
            <a href="#/sponsoren">Kies een kind →</a></p>`}
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
    <div class="page-head"><div><h1>Leaderboard</h1><div class="sub">Wie sponsort de meeste kinderen?</div></div></div>
    <p class="muted">Je verschijnt hier als <b>${esc(me.anonymous ? 'Anonieme donateur' : me.public_name)}</b>. <a href="#/profiel">Wijzig in je privacy-instellingen</a>.</p>
    <div class="card" id="lb"></div>`;
  const rows = await api('/api/portal/leaderboard?limit=100');
  $('#lb').innerHTML = leaderboardRows(rows);
  const mine = $('#lb .me');
  if (mine) mine.scrollIntoView({ block: 'nearest' });
}

function leaderboardRows(rows) {
  if (!rows.length) return '<p class="empty">Nog geen sponsors.</p>';
  return rows.map((r) => `<div class="lb-row ${r.rank <= 3 ? `top${r.rank}` : ''} ${r.is_me ? 'me' : ''}">
    <div class="lb-rank">${r.rank <= 3 ? `<span class="medal m${r.rank}">${r.rank}</span>` : r.rank}</div>
    <div><div class="lb-name">${r.anonymous ? `<span class="anon">${RF.icon('eye-off', 'icon-sm')}${esc(r.name)}</span>` : esc(r.name)} ${r.is_me ? '<span class="badge badge-admin">jij</span>' : ''}</div>
      <div class="lb-meta">${r.months} ${r.months === 1 ? 'maand' : 'maanden'} gesponsord${r.city ? ` · ${esc(r.city)}` : ''}</div></div>
    <div class="lb-amount">${r.children} ${r.children === 1 ? 'kind' : 'kinderen'}</div></div>`).join('');
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
    <div class="page-head"><div><h1>Profiel & privacy</h1><div class="sub">Je gegevens, je taal en hoe je zichtbaar bent op het leaderboard · <a href="/privacy" target="_blank" rel="noopener">Privacyverklaring</a></div></div></div>
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

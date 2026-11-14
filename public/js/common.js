// Gedeelde hulpfuncties voor beheer, portaal en leaderboard.
'use strict';

const RF = (() => {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      if (res.status === 401 && sessionExpired(path)) return new Promise(() => {}); // we gaan naar de inlogpagina
      const err = new Error((data && data.error) || `Fout ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Sessie verlopen (bv. na een update waarbij de database opnieuw is opgebouwd) terwijl je op een
  // ingelogde pagina zat: stuur naar de inlogpagina en daarna terug naar dezelfde plek.
  const ROLE_BY_PAGE = { '/portal': 'donateur', '/ontvanger': 'ontvanger', '/admin': 'medewerker' };
  let redirecting = false;
  function sessionExpired(path) {
    const role = ROLE_BY_PAGE[location.pathname.replace(/\/$/, '')];
    if (!role || /\/(login|register|logout)$/.test(path) || !wasLoggedIn) return false;
    if (!redirecting) {
      redirecting = true;
      try { sessionStorage.setItem('rf_session_expired', '1'); } catch { /* geen opslag */ }
      location.replace(`/login?rol=${role}&terug=${encodeURIComponent(location.pathname + location.hash)}`);
    }
    return true;
  }
  // Pas na een geslaagde "wie ben ik"-check weten we dat er een sessie was die nu verlopen is.
  let wasLoggedIn = false;
  const markLoggedIn = () => { wasLoggedIn = true; };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const euroFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
  const euroShort = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const euro = (cents) => euroFmt.format((cents || 0) / 100);
  const euro0 = (cents) => euroShort.format(Math.round((cents || 0) / 100));
  const num = (n, digits = 0) => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: digits }).format(n || 0);
  const date = (s) => {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T') + (String(s).length <= 10 ? 'T00:00:00' : ''));
    return isNaN(d) ? s : d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const dateTime = (s) => {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const toCents = (v) => Math.round(parseFloat(String(v).replace(/\./g, '').replace(',', '.')) * 100);
  const centsToInput = (c) => ((c || 0) / 100).toFixed(2).replace('.', ',');
  const monthName = (m) => new Date(2000, Number(m) - 1, 1).toLocaleDateString('nl-NL', { month: 'short' });

  const LABELS = {
    cell: { wachtend: 'Wachtend', deels_besteed: 'Deels besteed', besteed: 'Besteed', vervallen: 'Vervallen' },
    donation: { ontvangen: 'Ontvangen', in_afwachting: 'In afwachting', geannuleerd: 'Geannuleerd' },
    donor: { prospect: 'Prospect', actief: 'Actief', inactief: 'Inactief' },
    type: { particulier: 'Particulier', bedrijf: 'Bedrijf', stichting: 'Stichting' },
    method: { ideal: 'iDEAL', incasso: 'Incasso', overboeking: 'Overboeking', creditcard: 'Creditcard', contant: 'Contant', paypal: 'PayPal' },
    frequency: { eenmalig: 'Eenmalig', maandelijks: 'Maandelijks', kwartaal: 'Per kwartaal', jaarlijks: 'Jaarlijks' },
    message: { brief: 'Brief', video: 'Filmpje', foto: 'Foto', tekst: 'Bericht' },
    recipient: { kind: 'Kind', gezin: 'Gezin', school: 'School', gemeenschap: 'Gemeenschap', organisatie: 'Organisatie' },
    interaction: { notitie: 'Notitie', telefoon: 'Telefoon', email: 'E-mail', afspraak: 'Afspraak', brief: 'Brief', evenement: 'Evenement' },
  };
  const MESSAGE_ICONS = { brief: 'mail-open', video: 'video', foto: 'image', tekst: 'message-circle' };
  const INTERACTION_ICONS = { notitie: 'file-text', telefoon: 'phone', email: 'mail', afspraak: 'users', brief: 'mail-open', evenement: 'calendar' };

  // ---------- iconen (Lucide, zie icons.js) ----------
  function icon(name, cls = '') {
    const body = (typeof RF_ICONS !== 'undefined' && RF_ICONS[name]) || '';
    return `<svg class="icon ${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }
  // Bestemmingen krijgen een vast icoon + kleur (de emoji in de database blijft de terugval).
  const CAT_ICONS = { schoolmaaltijd: 'utensils', schoolgeld: 'graduation-cap', noodfonds: 'cloud-lightning', gezondheidspakket: 'heart-pulse' };
  const CAT_COLORS = { schoolmaaltijd: '#d9730d', schoolgeld: '#2f6fd8', noodfonds: '#7a4fd6', gezondheidspakket: '#1f9d63' };
  function catIcon(c, size = '') {
    const key = c && (c.category_key || c.key);
    const color = (key && CAT_COLORS[key]) || (c && c.color) || 'var(--accent)';
    const inner = CAT_ICONS[key] ? icon(CAT_ICONS[key]) : `<span style="font-size:13px">${esc((c && c.icon) || '•')}</span>`;
    return `<span class="cat-ico ${size}" style="--c:${esc(color)}" aria-hidden="true">${inner}</span>`;
  }
  const catColor = (c) => CAT_COLORS[c && (c.category_key || c.key)] || (c && c.color) || 'var(--accent)';
  // "Icoon + naam" van een bestemming
  const catLabel = (c, name) => `<span class="cat-name">${catIcon(c, 'sm')}<span>${esc(name ?? c.category_name ?? c.name ?? '')}</span></span>`;

  // Avatar met initialen en een vaste kleur per naam
  function avatar(name, size = '') {
    const ini = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
    let h = 0; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="avatar ${size}" data-tone="${(h % 6) + 1}" aria-hidden="true">${esc(ini)}</span>`;
  }

  // ---------- laad- en lege staten ----------
  function skeleton(kind = 'page') {
    const line = (w, h = 12, mt = 0) => `<div class="skel" style="width:${w};height:${h}px;margin-top:${mt}px"></div>`;
    const rows = (n) => Array.from({ length: n }, () => `<div style="display:flex;gap:14px;align-items:center;padding:12px 0;border-top:1px solid var(--border)">
      ${line('28px', 28)}<div style="flex:1">${line('38%')}${line('22%', 10, 8)}</div>${line('70px')}</div>`).join('');
    if (kind === 'rows') return rows(6);
    return `<div aria-busy="true" aria-label="Laden">
      <div style="margin-bottom:24px">${line('200px', 22)}${line('320px', 12, 10)}</div>
      <div class="kpis">${Array.from({ length: 4 }, () => `<div class="kpi">${line('60%', 10)}${line('50%', 22, 12)}</div>`).join('')}</div>
      <div class="card" style="margin-top:16px">${rows(6)}</div></div>`;
  }
  function emptyState({ icon: ic = 'inbox', title = 'Nog niets hier', text = '', action = '' } = {}) {
    return `<div class="empty-state"><div class="es-icon">${icon(ic)}</div><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${action}</div>`;
  }

  // ---------- dropdownmenu ----------
  // items: [{ label, icon, onClick, danger, href }] of '-' voor scheiding of { heading }
  function menu(anchor, items, { align = 'end' } = {}) {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : it.heading ? `<div class="menu-label">${esc(it.heading)}</div>`
      : it.href ? `<a role="menuitem" href="${esc(it.href)}" ${it.external ? 'target="_blank" rel="noopener"' : ''} data-i="${i}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.external ? `<span style="margin-left:auto">${icon('arrow-up-right', 'icon-sm')}</span>` : ''}</a>`
        : `<button type="button" role="menuitem" class="${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`)).join('');
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth; const h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    const close = () => { el.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey); };
    const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    const btns = () => [...el.querySelectorAll('button,a')];
    const onKey = (e) => {
      if (e.key === 'Escape') { close(); anchor.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = btns(); const i = list.indexOf(document.activeElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
      }
    };
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', onKey); }, 0);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const it = items[Number(b.dataset.i)];
      if (!it.href) { close(); it.onClick && it.onClick(); } else close();
    });
    const first = btns()[0]; if (first) first.focus({ preventScroll: true });
    return close;
  }
  const label = (group, key) => (LABELS[group] && LABELS[group][key]) || key || '';
  const badge = (group, key) => `<span class="badge badge-${esc(key)}">${esc(label(group, key))}</span>`;

  function toast(message, type = 'ok') {
    let host = document.getElementById('toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(type === 'error' ? 'circle-alert' : 'circle-check')}<span></span>`;
    el.querySelector('span').textContent = message;
    host.appendChild(el);
    setTimeout(() => el.classList.add('hide'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  // Modal met formulier. onSubmit(formDataObject) -> resolve sluit modal.
  function modal({ title, body, submitLabel = 'Opslaan', onSubmit, wide = false, onOpen }) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <form>
          <header class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Sluiten">${icon('x')}</button></header>
          <div class="modal-body">${body}</div>
          <p class="form-error" hidden></p>
          ${onSubmit ? `<footer class="modal-foot"><button type="button" class="btn btn-ghost" data-close>Annuleren</button>
            <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button></footer>` : ''}
        </form>
      </div>`;
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    const form = wrap.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return;
      const btn = form.querySelector('[type=submit]');
      const errEl = form.querySelector('.form-error');
      btn.disabled = true;
      errEl.hidden = true;
      try {
        const result = await onSubmit(formData(form), form);
        if (result !== false) close();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    document.body.appendChild(wrap);
    const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=file]), select, textarea');
    if (first && matchMedia('(min-width: 701px)').matches) first.focus();
    if (onOpen) onOpen(form, close);
    return { close, form };
  }

  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else if (el.type === 'file') continue;
      else out[el.name] = el.value;
    }
    return out;
  }

  async function confirmDialog(message, okLabel = 'Bevestigen') {
    return new Promise((resolve) => {
      let done = false;
      const m = modal({
        title: 'Weet je het zeker?', body: `<p style="color:var(--text-2)">${esc(message)}</p>`, submitLabel: okLabel,
        onSubmit: () => { done = true; resolve(true); },
      });
      const observer = new MutationObserver(() => {
        if (!document.body.contains(m.form)) { observer.disconnect(); if (!done) resolve(false); }
      });
      observer.observe(document.body, { childList: true });
    });
  }

  // Simpel staafdiagram in SVG. series: [{label, values:[...], color}]
  function barChart(labels, series, { height = 220, format = euro0, legend: showLegend = true } = {}) {
    const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
    // "Mooie" bovengrens voor de as
    const mag = 10 ** Math.floor(Math.log10(rawMax));
    const max = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= rawMax) || rawMax;
    const w = 640;
    const pad = { l: 52, r: 4, t: 8, b: 24 };
    const innerW = w - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const groupW = innerW / Math.max(1, labels.length);
    const barW = Math.max(4, Math.min(14, (groupW * 0.62) / series.length));
    let svg = `<svg viewBox="0 0 ${w} ${height}" class="chart" role="img" aria-label="Staafdiagram">`;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + innerH - (innerH * i) / 4;
      svg += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" class="grid"/>`;
      svg += `<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" class="axis">${esc(format((max * i) / 4))}</text>`;
    }
    labels.forEach((lab, i) => {
      const gx = pad.l + groupW * i + (groupW - (barW + 3) * series.length + 3) / 2;
      series.forEach((s, j) => {
        const v = s.values[i] || 0;
        const h = (innerH * v) / max;
        svg += `<rect x="${gx + j * (barW + 3)}" y="${pad.t + innerH - h}" width="${barW}" height="${Math.max(h, v ? 2 : 0)}" rx="3" fill="${s.color}">
          <title>${esc(s.label)} ${esc(lab)}: ${esc(format(v))}</title></rect>`;
      });
      svg += `<text x="${pad.l + groupW * i + groupW / 2}" y="${height - 8}" text-anchor="middle" class="axis">${esc(lab)}</text>`;
    });
    svg += '</svg>';
    const legend = series.length > 1 && showLegend
      ? `<div class="legend" style="margin-top:10px">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';
    return svg + legend;
  }

  // Voortgangsbalk: wachtend vs besteed.
  function splitBar(spent, waiting) {
    const total = spent + waiting || 1;
    return `<div class="splitbar" title="Besteed ${euro(spent)} · In cel ${euro(waiting)}">
      <span class="spent" style="width:${(spent / total) * 100}%"></span><span class="waiting" style="width:${(waiting / total) * 100}%"></span></div>`;
  }

  function mediaHtml(type, url, title = '') {
    if (!url) {
      return type === 'video' ? `<div class="media-placeholder">${icon('video', 'icon-lg')}<span>Filmpje wordt binnenkort toegevoegd</span></div>` : '';
    }
    const safe = esc(url);
    if (/\.(mp4|webm|mov)$/i.test(url)) return `<video controls preload="metadata" src="${safe}"></video>`;
    if (/youtube\.com\/embed\/|player\.vimeo\.com\//.test(url) && /^https:\/\//.test(url)) {
      return `<div class="video-embed"><iframe src="${safe}" title="${esc(title)}" allowfullscreen loading="lazy"></iframe></div>`;
    }
    if (/\.pdf$/i.test(url)) return `<a class="btn btn-ghost" href="${safe}" target="_blank" rel="noopener">${icon('file-text')} Brief openen (PDF)</a>`;
    if (/^(\/|https:\/\/)/.test(url)) return `<img src="${safe}" alt="${esc(title)}" loading="lazy">`;
    return '';
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function debounce(fn, ms = 250) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  const unitsText = (cat, units) => {
    if (!cat.unit_cost_cents || units == null) return '';
    const n = Number(units);
    const rounded = n >= 10 ? Math.floor(n) : Math.round(n * 10) / 10;
    return `${num(rounded, 1)} ${rounded === 1 ? cat.unit_label : cat.unit_label_plural}`;
  };


  let translationInfo = null;
  const getTranslationInfo = () => (translationInfo ||= api('/api/public/translation').catch(() => ({ enabled: false, languages: {} })));

  // Chatvenster. opts: { load(): Promise<{messages, my_language, their_language, translate_error}>,
  //   send(body), setLanguage(code), notice, otherName }
  // Je kiest één taal ("Mijn taal") om in te lezen en te schrijven; de taal van berichten wordt automatisch herkend.
  async function chatBox(container, opts) {
    const info = await getTranslationInfo();
    container.innerHTML = `
      <div class="chat">
        ${opts.notice ? `<div class="chat-notice">${icon('shield-check')}<span>${opts.notice}</span></div>` : ''}
        <div class="chat-tools">
          <label class="lang-pick">${icon('languages')} Mijn taal
            <select class="translate-lang" aria-label="Mijn taal (lezen en schrijven)">
              ${Object.entries(info.languages).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select></label>
          <span class="translate-status small muted"></span>
        </div>
        <div class="chat-log" aria-live="polite"></div>
        <form class="chat-form">
          <textarea name="body" rows="2" maxlength="2000" placeholder="Schrijf een bericht…" aria-label="Bericht"></textarea>
          <button class="btn btn-primary" aria-label="Verstuur">${icon('send')}<span class="desktop-only">Verstuur</span></button>
        </form>
        <p class="form-error" hidden style="margin:8px 0 0"></p>
      </div>`;
    const log = container.querySelector('.chat-log');
    const langSel = container.querySelector('.translate-lang');
    const status = container.querySelector('.translate-status');
    const textarea = container.querySelector('textarea');
    // Concept bewaren, zodat een half getypt bericht niet verloren gaat (bv. als je opnieuw moet inloggen).
    const draftKey = `rf_concept_${location.pathname}${location.hash}`;
    try { textarea.value = sessionStorage.getItem(draftKey) || ''; } catch { /* geen opslag */ }
    textarea.addEventListener('input', () => { try { sessionStorage.setItem(draftKey, textarea.value); } catch { /* geen opslag */ } });
    const showOriginal = new Set();
    const langName = (code) => info.languages[code] || code;
    langSel.addEventListener('change', async () => {
      langSel.disabled = true;
      try { await opts.setLanguage(langSel.value); toast(`Mijn taal: ${langName(langSel.value)}`); }
      catch (ex) { toast(ex.message, 'error'); }
      finally { langSel.disabled = false; }
      lastSig = '';
      refresh();
    });
    log.addEventListener('click', (e) => {
      const b = e.target.closest('[data-orig]');
      if (!b) return;
      const id = Number(b.dataset.orig);
      if (showOriginal.has(id)) showOriginal.delete(id); else showOriginal.add(id);
      lastSig = '';
      refresh();
    });
    const form = container.querySelector('.chat-form');
    const err = container.querySelector('.form-error');
    let lastSig = '';
    const statusText = (m) => (!m.mine ? '' : m.status === 'in_behandeling'
      ? '<span class="chat-status">wacht op controle</span>'
      : m.status === 'afgewezen' ? `<span class="chat-status bad">niet verstuurd${m.reject_reason ? `: ${esc(m.reject_reason)}` : ''}</span>`
        : m.read_at ? '<span class="chat-status">· gelezen</span>' : '<span class="chat-status">· verstuurd</span>');
    async function refresh() {
      if (!lastSig && info.enabled) status.textContent = 'Berichten laden…';
      const res = await opts.load();
      const msgs = Array.isArray(res) ? res : res.messages;
      if (res.my_language && document.activeElement !== langSel) langSel.value = res.my_language;
      const other = opts.otherName || 'De ander';
      if (!info.enabled) status.textContent = 'Automatisch vertalen is nog niet ingesteld.';
      else if (res.translate_error) status.textContent = `⚠️ ${res.translate_error}`;
      else if (res.their_language && res.my_language && res.their_language !== res.my_language) {
        status.textContent = `Jij leest en schrijft in: ${langName(res.my_language)} · ${other} leest jouw berichten in: ${langName(res.their_language)}`;
      } else status.textContent = 'Berichten in een andere taal worden automatisch vertaald.';
      if (res.my_language) textarea.placeholder = `Schrijf een bericht (${langName(res.my_language)})…`;
      const sig = (res.my_language || '') + msgs.map((m) => `${m.id}:${m.status}:${m.read_at || ''}:${m.translation ? 1 : 0}:${showOriginal.has(m.id) ? 1 : 0}`).join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      const bodyHtml = (m) => {
        if (!m.translation) return `<div class="bubble-body">${esc(m.body)}</div>`;
        const orig = showOriginal.has(m.id);
        return `<div class="bubble-body">${esc(orig ? m.body : m.translation)}</div>
          <button type="button" class="link-btn" data-orig="${m.id}">${orig ? 'Vertaling tonen' : `Vertaald uit ${esc(langName(m.source_lang))} · origineel tonen`}</button>`;
      };
      log.innerHTML = msgs.length ? msgs.map((m) => `<div class="bubble ${m.mine ? 'mine' : 'theirs'} ${m.status !== 'goedgekeurd' ? 'pending' : ''}">
          ${bodyHtml(m)}
          <div class="bubble-meta">${dateTime(m.created_at)} ${statusText(m)}</div></div>`).join('')
        : `<p class="muted" style="text-align:center;margin:auto">Nog geen berichten. Stuur ${esc(opts.otherName || '')} als eerste een berichtje!</p>`;
      if (atBottom || !log.dataset.init) { log.scrollTop = log.scrollHeight; log.dataset.init = '1'; }
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = form.elements.body.value.trim();
      if (!body) return;
      err.hidden = true;
      form.querySelector('button').disabled = true;
      try {
        await opts.send(body);
        form.elements.body.value = '';
        try { sessionStorage.removeItem(draftKey); } catch { /* geen opslag */ }
        lastSig = '';
        await refresh();
        log.scrollTop = log.scrollHeight;
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      finally { form.querySelector('button').disabled = false; }
    });
    form.elements.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    const timer = setInterval(() => { if (!document.body.contains(container) || !container.querySelector('.chat')) clearInterval(timer); else refresh().catch(() => {}); }, 8000);
    return refresh();
  }

  // Balk bovenaan wanneer een medewerker meekijkt ("inloggen als").
  function impersonationBanner(me, logoutPath) {
    if (!me || !me.impersonated_by) return;
    document.body.classList.add('impersonating');
    const bar = document.createElement('div');
    bar.className = 'impersonation-bar';
    bar.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px">${icon("eye")} Je kijkt mee als <b>${esc(me.full_name || me.name)}</b> — ingelogd door ${esc(me.impersonated_by)} · alleen-lezen</span>
      <button type="button" class="btn btn-sm">Stoppen</button>`;
    bar.querySelector('button').onclick = async () => {
      await api(logoutPath, { method: 'POST', body: {} });
      if (window.opener) window.close();
      location.href = '/admin';  // beheerder is nog ingelogd als medewerker
    };
    document.body.prepend(bar);
  }

  return {
    icon, catIcon, catColor, catLabel, avatar, skeleton, emptyState, menu, MESSAGE_ICONS, INTERACTION_ICONS, CAT_COLORS,
    markLoggedIn,
    impersonationBanner,
    chatBox,
    api, esc, euro, euro0, num, date, dateTime, today, toCents, centsToInput, monthName, label, badge, LABELS,
    toast, modal, formData, confirmDialog, barChart, splitBar, mediaHtml, readFileBase64, debounce, unitsText,
  };
})();

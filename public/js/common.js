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
      const err = new Error((data && data.error) || `Fout ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

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
    message: { brief: '✉️ Brief', video: '🎬 Filmpje', foto: '📷 Foto', tekst: '💬 Bericht' },
    recipient: { kind: 'Kind', gezin: 'Gezin', school: 'School', gemeenschap: 'Gemeenschap', organisatie: 'Organisatie' },
    interaction: { notitie: '📝 Notitie', telefoon: '📞 Telefoon', email: '📧 E-mail', afspraak: '🤝 Afspraak', brief: '✉️ Brief', evenement: '🎉 Evenement' },
  };
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
    el.textContent = message;
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
          <header class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Sluiten">✕</button></header>
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
    const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
    if (first) first.focus();
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
        title: 'Weet je het zeker?', body: `<p>${esc(message)}</p>`, submitLabel: okLabel,
        onSubmit: () => { done = true; resolve(true); },
      });
      const observer = new MutationObserver(() => {
        if (!document.body.contains(m.form)) { observer.disconnect(); if (!done) resolve(false); }
      });
      observer.observe(document.body, { childList: true });
    });
  }

  // Simpel staafdiagram in SVG. series: [{label, values:[...], color}]
  function barChart(labels, series, { height = 200, format = euro0 } = {}) {
    const max = Math.max(1, ...series.flatMap((s) => s.values));
    const w = 640;
    const pad = { l: 56, r: 8, t: 10, b: 26 };
    const innerW = w - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const groupW = innerW / Math.max(1, labels.length);
    const barW = Math.max(4, Math.min(28, (groupW - 6) / series.length));
    let svg = `<svg viewBox="0 0 ${w} ${height}" class="chart" role="img" aria-label="Staafdiagram">`;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + innerH - (innerH * i) / 4;
      svg += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" class="grid"/>`;
      svg += `<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" class="axis">${esc(format((max * i) / 4))}</text>`;
    }
    labels.forEach((lab, i) => {
      const gx = pad.l + groupW * i + (groupW - barW * series.length) / 2;
      series.forEach((s, j) => {
        const v = s.values[i] || 0;
        const h = (innerH * v) / max;
        svg += `<rect x="${gx + j * barW}" y="${pad.t + innerH - h}" width="${barW - 2}" height="${h}" rx="3" fill="${s.color}">
          <title>${esc(s.label)} ${esc(lab)}: ${esc(format(v))}</title></rect>`;
      });
      svg += `<text x="${pad.l + groupW * i + groupW / 2}" y="${height - 8}" text-anchor="middle" class="axis">${esc(lab)}</text>`;
    });
    svg += '</svg>';
    const legend = series.length > 1
      ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';
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
      return type === 'video' ? `<div class="media-placeholder">🎬<span>Filmpje wordt binnenkort toegevoegd</span></div>` : '';
    }
    const safe = esc(url);
    if (/\.(mp4|webm|mov)$/i.test(url)) return `<video controls preload="metadata" src="${safe}"></video>`;
    if (/youtube\.com\/embed\/|player\.vimeo\.com\//.test(url) && /^https:\/\//.test(url)) {
      return `<div class="video-embed"><iframe src="${safe}" title="${esc(title)}" allowfullscreen loading="lazy"></iframe></div>`;
    }
    if (/\.pdf$/i.test(url)) return `<a class="btn btn-ghost" href="${safe}" target="_blank" rel="noopener">📄 Brief openen (PDF)</a>`;
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


  // Vertaalinstellingen (per apparaat): { on, lang }
  let translationInfo = null;
  const getTranslationInfo = () => (translationInfo ||= api('/api/public/translation').catch(() => ({ enabled: false, languages: {} })));
  const prefKey = (scope) => `rf_vertalen_${scope}`;
  const loadPref = (scope, fallback) => {
    try { return { on: false, lang: fallback, ...JSON.parse(localStorage.getItem(prefKey(scope)) || '{}') }; }
    catch { return { on: false, lang: fallback }; }
  };
  const savePref = (scope, pref) => { try { localStorage.setItem(prefKey(scope), JSON.stringify(pref)); } catch { /* geen opslag */ } };
  const browserLang = () => (navigator.language || 'nl').slice(0, 2).toLowerCase();

  // Chatvenster. opts: { load(lang): Promise<msgs | {messages, translate_error}>, send(body), notice, otherName, scope, defaultLang }
  async function chatBox(container, opts) {
    const info = await getTranslationInfo();
    const scope = opts.scope || 'chat';
    const pref = loadPref(scope, info.languages[browserLang()] ? browserLang() : (opts.defaultLang || 'nl'));
    container.innerHTML = `
      <div class="chat">
        ${opts.notice ? `<div class="chat-notice">${opts.notice}</div>` : ''}
        <div class="chat-tools">
          <button type="button" class="btn btn-ghost btn-sm translate-toggle" aria-pressed="${pref.on && info.enabled}"
            ${info.enabled ? '' : 'disabled title="Vertalen is nog niet ingesteld door Robin Foundation"'}>🌐 Automatisch vertalen: <b>${pref.on && info.enabled ? 'aan' : 'uit'}</b></button>
          <select class="translate-lang" aria-label="Vertaal naar" ${pref.on && info.enabled ? '' : 'hidden'}>
            ${Object.entries(info.languages).map(([k, v]) => `<option value="${k}" ${k === pref.lang ? 'selected' : ''}>naar ${esc(v)}</option>`).join('')}
          </select>
          <span class="translate-status small muted"></span>
        </div>
        <div class="chat-log" aria-live="polite"></div>
        <form class="chat-form">
          <textarea name="body" rows="2" maxlength="2000" placeholder="Schrijf een bericht…" aria-label="Bericht"></textarea>
          <button class="btn btn-primary">Verstuur</button>
        </form>
        <p class="form-error" hidden style="margin:8px 0 0"></p>
      </div>`;
    const log = container.querySelector('.chat-log');
    const toggle = container.querySelector('.translate-toggle');
    const langSel = container.querySelector('.translate-lang');
    const status = container.querySelector('.translate-status');
    const showOriginal = new Set();
    const translating = () => pref.on && info.enabled;
    toggle.addEventListener('click', () => {
      pref.on = !pref.on;
      savePref(scope, pref);
      toggle.setAttribute('aria-pressed', translating());
      toggle.querySelector('b').textContent = translating() ? 'aan' : 'uit';
      langSel.hidden = !translating();
      lastSig = '';
      refresh();
    });
    langSel.addEventListener('change', () => { pref.lang = langSel.value; savePref(scope, pref); lastSig = ''; refresh(); });
    log.addEventListener('click', (e) => {
      const b = e.target.closest('[data-orig]');
      if (!b) return;
      const id = Number(b.dataset.orig);
      if (showOriginal.has(id)) showOriginal.delete(id); else showOriginal.add(id);
      lastSig = '';
      refresh();
    });
    const langName = (code) => info.languages[code] || code;
    const form = container.querySelector('.chat-form');
    const err = container.querySelector('.form-error');
    let lastSig = '';
    const statusText = (m) => (!m.mine ? '' : m.status === 'in_behandeling'
      ? '<span class="chat-status">⏳ wacht op controle</span>'
      : m.status === 'afgewezen' ? `<span class="chat-status bad">✗ niet verstuurd${m.reject_reason ? `: ${esc(m.reject_reason)}` : ''}</span>`
        : m.read_at ? '<span class="chat-status">✓✓ gelezen</span>' : '<span class="chat-status">✓ verstuurd</span>');
    async function refresh() {
      const lang = translating() ? pref.lang : '';
      if (lang && !lastSig) status.textContent = 'Vertalen…';
      const res = await opts.load(lang);
      const msgs = Array.isArray(res) ? res : res.messages;
      status.textContent = res.translate_error ? `⚠️ ${res.translate_error}` : '';
      const sig = lang + msgs.map((m) => `${m.id}:${m.status}:${m.read_at || ''}:${m.translation ? 1 : 0}:${showOriginal.has(m.id) ? 1 : 0}`).join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      const bodyHtml = (m) => {
        if (!m.translation) return `<div class="bubble-body">${esc(m.body)}</div>`;
        const orig = showOriginal.has(m.id);
        return `<div class="bubble-body">${esc(orig ? m.body : m.translation)}</div>
          <button type="button" class="link-btn" data-orig="${m.id}">${orig ? '🌐 Vertaling tonen' : `🌐 Vertaald uit ${esc(langName(m.source_lang))} · origineel`}</button>`;
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
    bar.innerHTML = `<span>👁️ Je kijkt mee als <b>${esc(me.full_name || me.name)}</b> — ingelogd door ${esc(me.impersonated_by)} · je handelt namens deze persoon</span>
      <button type="button" class="btn btn-sm">Stoppen</button>`;
    bar.querySelector('button').onclick = async () => {
      await api(logoutPath, { method: 'POST', body: {} });
      if (window.opener) window.close();
      location.href = '/admin';  // beheerder is nog ingelogd als medewerker
    };
    document.body.prepend(bar);
  }

  return {
    impersonationBanner,
    chatBox,
    api, esc, euro, euro0, num, date, dateTime, today, toCents, centsToInput, monthName, label, badge, LABELS,
    toast, modal, formData, confirmDialog, barChart, splitBar, mediaHtml, readFileBase64, debounce, unitsText,
  };
})();

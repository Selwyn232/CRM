// Aanmelden als sponsor: kind kiezen → gegevens → beveiligen (Face ID of wachtwoord) → betalen.
// Zo min mogelijk velden, automatisch invullen, en het account pas aanmaken nadat iemand een kind heeft gekozen.
'use strict';

const { api, esc, euro, toast } = RF;
const $ = (s, r = document) => r.querySelector(s);
const view = () => $('#view');
const STEPS = ['Kies een kind', 'Jouw gegevens', 'Beveiligen', 'Betalen'];
const store = {
  get: () => { try { return JSON.parse(sessionStorage.getItem('rf_signup') || '{}'); } catch { return {}; } },
  set: (v) => { try { sessionStorage.setItem('rf_signup', JSON.stringify({ ...store.get(), ...v })); } catch { /* geen opslag */ } },
};
let cfg = null; let kids = []; let me = null; let payInfo = {};
const P = RF.passkeys;
const faceName = P.label();
const childMeta = (c) => [c.age != null ? `${c.age} jaar` : '', c.grade, c.province].filter(Boolean).join(' · ');
const photo = (c, cls = '') => (c.photo_url ? `<img class="child-photo ${cls}" src="${esc(c.photo_url)}" alt="${esc(c.first_name)}" loading="lazy">`
  : `<div class="child-photo ${cls} ph">${esc(c.first_name.slice(0, 1))}</div>`);
const picked = () => (store.get().picked || []).filter((id) => kids.some((k) => k.id === id));

function drawSteps(i) {
  $('#steps').innerHTML = STEPS.map((s, n) => `<li class="${n < i ? 'done' : n === i ? 'active' : ''}"><span class="n">${n < i ? RF.icon('check', 'icon-sm') : n + 1}</span><span class="t">${esc(s)}</span></li>`).join('');
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ 1. kind kiezen
function stepChoose() {
  drawSteps(0);
  const sel = new Set(picked());
  view().innerHTML = `
    <div class="signup-head"><h1>Kies een kind om te sponsoren</h1>
      <p class="muted">Voor ${euro(cfg.amount_cents)} per maand krijgt een kind op de Filipijnen elke schooldag een maaltijd, schoolgeld en basisverzorging. Je ontvangt elke maand een update en kunt berichten sturen naar de ouders.</p></div>
    ${kids.length ? `<div class="child-grid" id="kids">${kids.map((c) => `<div class="card child-card pick" data-id="${c.id}" role="checkbox" tabindex="0" aria-checked="false">
        ${photo(c)}<span class="pick-check">${RF.icon('check', 'icon-sm')}</span>
        <div class="child-body"><div class="child-name">${esc(c.first_name)}</div><div class="small muted">${esc(childMeta(c))}</div>
          ${c.story ? `<p class="small story">${esc(c.story)}</p>` : ''}</div></div>`).join('')}</div>
      <div class="sponsor-bar" id="bar" hidden><div class="grow"><b id="bar-n"></b><div class="small muted" id="bar-t"></div></div>
        <button class="btn btn-primary" id="next"><span>Verder</span>${RF.icon('arrow-right')}</button></div>`
      : `<div class="card">${RF.emptyState({ icon: 'party-popper', title: 'Alle kinderen hebben op dit moment een sponsor', text: 'Nieuwe kinderen worden steeds toegevoegd. Kijk binnenkort nog eens.' })}</div>`}`;
  if (!kids.length) return;
  const draw = () => {
    view().querySelectorAll('.child-card.pick').forEach((el) => {
      const on = sel.has(Number(el.dataset.id));
      el.classList.toggle('selected', on); el.setAttribute('aria-checked', on);
    });
    const n = sel.size;
    $('#bar').hidden = !n;
    $('#bar-n').textContent = `${n} ${n === 1 ? 'kind' : 'kinderen'} · ${euro(n * cfg.amount_cents)} per maand`;
    $('#bar-t').textContent = [...sel].map((id) => kids.find((k) => k.id === id).first_name).join(', ');
    store.set({ picked: [...sel] });
  };
  const toggle = (el) => { const id = Number(el.dataset.id); if (sel.has(id)) sel.delete(id); else sel.add(id); draw(); };
  $('#kids').addEventListener('click', (e) => { const el = e.target.closest('.child-card.pick'); if (el) toggle(el); });
  $('#kids').addEventListener('keydown', (e) => { const el = e.target.closest('.child-card.pick'); if (el && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(el); } });
  $('#next').onclick = () => next();
  draw();
}

// ------------------------------------------------------------------ 2. gegevens
function stepDetails() {
  drawSteps(1);
  const d = store.get().details || { donor_type: 'particulier', newsletter: true };
  view().innerHTML = `
    <div class="signup-narrow">
      <div class="signup-head"><h1>Jouw gegevens</h1><p class="muted">Dit kost een halve minuut. Je adres hebben we niet nodig.</p></div>
      <form class="card" id="f" autocomplete="on" novalidate>
        <div class="field"><label>Ik sponsor als</label>
          <div class="seg seg-block" id="type"><button type="button" data-v="particulier">Particulier</button><button type="button" data-v="bedrijf">Bedrijf</button></div></div>
        <div class="field" id="company-field" hidden><label for="company">Naam van het bedrijf</label>
          <input id="company" name="company_name" type="text" autocomplete="organization" value="${esc(d.company_name || '')}"></div>
        <div class="field-row">
          <div class="field"><label for="fn">Voornaam</label><input id="fn" name="first_name" type="text" autocomplete="given-name" required value="${esc(d.first_name || '')}"></div>
          <div class="field"><label for="ln">Achternaam</label><input id="ln" name="last_name" type="text" autocomplete="family-name" value="${esc(d.last_name || '')}"></div>
        </div>
        <div class="field"><label for="em">E-mailadres</label><input id="em" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required value="${esc(d.email || '')}">
          <div class="hint">Hier ontvang je de maandelijkse updates over je sponsorkind.</div></div>
        <label class="check"><input type="checkbox" name="show_on_leaderboard" ${d.show_on_leaderboard ? 'checked' : ''}> <span>Toon mijn naam op de erelijst <span class="muted">(anders sta je er anoniem op)</span></span></label>
        <label class="check"><input type="checkbox" name="newsletter" ${d.newsletter !== false ? 'checked' : ''}> <span>Houd me op de hoogte via de nieuwsbrief</span></label>
        <label class="check"><input type="checkbox" name="privacy" required> <span>Ik ga akkoord met de <a href="/privacy" target="_blank" rel="noopener">privacyverklaring</a></span></label>
        <p class="form-error" hidden style="margin:12px 0 0"></p>
        <div class="signup-actions"><button type="button" class="btn btn-ghost" id="back">${RF.icon('arrow-left')}<span>Terug</span></button>
          <button class="btn btn-primary btn-lg" type="submit"><span>Verder</span>${RF.icon('arrow-right')}</button></div>
      </form>
      <p class="small muted" style="text-align:center">Heb je al een account? <a href="/login?rol=donateur&amp;terug=${encodeURIComponent('/aanmelden')}">Log in</a></p>
    </div>`;
  const form = $('#f');
  let type = d.donor_type === 'bedrijf' ? 'bedrijf' : 'particulier';
  const drawType = () => {
    form.querySelectorAll('#type button').forEach((b) => b.classList.toggle('active', b.dataset.v === type));
    $('#company-field').hidden = type !== 'bedrijf';
  };
  $('#type').onclick = (e) => { const b = e.target.closest('button'); if (b) { type = b.dataset.v; drawType(); if (type === 'bedrijf') $('#company').focus(); } };
  drawType();
  if (matchMedia('(min-width: 701px)').matches) (type === 'bedrijf' ? $('#company') : $('#fn')).focus();
  $('#back').onclick = () => go(0);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error'); err.hidden = true;
    const f = RF.formData(form);
    const body = { ...f, donor_type: type, privacy: !!f.privacy, show_on_leaderboard: !!f.show_on_leaderboard, newsletter: !!f.newsletter };
    store.set({ details: { ...body, privacy: undefined } });
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      me = await api('/api/donor/signup', { method: 'POST', body });
      next();
    } catch (ex) {
      err.innerHTML = ex.status === 409 && /Log in/.test(ex.message)
        ? `${esc(ex.message)} <a href="/login?rol=donateur&amp;terug=${encodeURIComponent('/aanmelden')}">Inloggen</a>` : esc(ex.message);
      err.hidden = false;
    } finally { btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ 3. beveiligen
async function stepSecure() {
  drawSteps(2);
  const canFace = P.supported() && await P.platform();
  view().innerHTML = `
    <div class="signup-narrow">
      <div class="signup-head"><h1>Beveilig je account</h1><p class="muted">Zo kun je later weer inloggen om je sponsorkind te volgen.</p></div>
      <div class="card">
        ${P.supported() ? `<div class="faceid-offer" style="padding:4px 0 0">
          <div class="faceid-icon">${RF.icon('scan-face')}</div>
          <h2>Inloggen met ${esc(faceName)}</h2>
          <p class="muted small">Geen wachtwoord onthouden: je logt in met je gezicht of vinger. Je gezicht of vingerafdruk verlaat je toestel nooit.</p>
          <button type="button" class="btn btn-primary btn-lg btn-block" id="face">${RF.icon('scan-face')}<span>${esc(faceName)} gebruiken${canFace ? ' (aanbevolen)' : ''}</span></button>
          <p class="form-error" id="face-err" hidden style="margin-top:10px"></p></div>
          <div class="or-sep"><span>of</span></div>` : ''}
        <details ${P.supported() ? '' : 'open'} id="pw-box"><summary class="link" style="margin:0">Liever een wachtwoord</summary>
          <form id="pw" style="margin-top:12px">
            <input type="email" autocomplete="username" value="${esc(me.email || '')}" hidden aria-hidden="true">
            <div class="field"><label for="pw1">Kies een wachtwoord</label><input id="pw1" name="password" type="password" minlength="8" required autocomplete="new-password">
              <div class="hint">Minimaal 8 tekens. Je iPhone kan er automatisch een sterk wachtwoord voor maken.</div></div>
            <p class="form-error" hidden style="margin:0 0 10px"></p>
            <button class="btn btn-primary btn-block" type="submit">Wachtwoord opslaan</button>
          </form></details>
      </div>
    </div>`;
  if ($('#face')) $('#face').onclick = async () => {
    const b = $('#face'); const err = $('#face-err'); err.hidden = true; b.disabled = true;
    try { await P.register('donor'); me.needs_credential = false; toast(`${faceName} is ingesteld`); next(); }
    catch (ex) { if (ex.message !== 'Geannuleerd.') { err.textContent = ex.message; err.hidden = false; } b.disabled = false; }
  };
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#pw .form-error'); err.hidden = true;
    try { me = await api('/api/portal/set-password', { method: 'POST', body: { password: $('#pw1').value } }); next(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

// ------------------------------------------------------------------ 4. betalen
function stepPay() {
  drawSteps(3);
  const ids = picked();
  const chosen = ids.map((id) => kids.find((k) => k.id === id));
  const n = chosen.length;
  view().innerHTML = `
    <div class="signup-narrow">
      <div class="signup-head"><h1>${esc(me.first_name || 'Bijna klaar')}${me.first_name ? ', bijna klaar' : ''}!</h1><p class="muted">Controleer je keuze en rond je eerste maand af.</p></div>
      <div class="card">
        <div class="signup-kids">${chosen.map((c) => `<div class="signup-kid">${photo(c, 'sm')}<div><b>${esc(c.first_name)}</b><div class="small muted">${esc(childMeta(c))}</div></div></div>`).join('')}</div>
        <div class="breakdown" style="margin-top:12px">${cfg.parts.map((p) => `<div class="bd-row"><span class="bd-ico">${RF.icon(p.icon || 'circle')}</span>
          <div class="grow"><div class="t">${esc(p.label)}</div><div class="small muted">${esc(p.description)}</div></div></div>`).join('')}</div>
        <div class="signup-total"><span>${n} ${n === 1 ? 'kind' : 'kinderen'} × ${euro(cfg.amount_cents)}</span><b>${euro(n * cfg.amount_cents)} per maand</b></div>
        <p class="form-error" hidden style="margin:0 0 10px"></p>
        <button class="btn btn-primary btn-lg btn-block" id="pay">${RF.icon('heart')}<span>${payInfo.payments ? `Betaal ${euro(n * cfg.amount_cents)} en start` : 'Start sponsoring'}</span></button>
        <p class="hint" style="text-align:center;margin-top:10px">${!payInfo.payments ? 'Demo-omgeving: er wordt niet echt betaald.'
          : payInfo.payments_mode === 'test' ? 'Testmodus: je gaat naar een testbetaling, er wordt niets afgeschreven.'
            : `${RF.icon('lock', 'icon-sm')} Veilig betalen met iDEAL, Apple Pay of creditcard via Mollie. Daarna wordt elke maand automatisch afgeschreven; stoppen kan altijd.`}</p>
        <button type="button" class="btn btn-quiet btn-sm btn-block" id="change">Ander kind kiezen</button>
      </div>
    </div>`;
  $('#change').onclick = () => go(0);
  $('#pay').onclick = async () => {
    const b = $('#pay'); const err = view().querySelector('.form-error'); err.hidden = true; b.disabled = true;
    try {
      const r = await api('/api/portal/sponsor', { method: 'POST', body: { child_ids: ids } });
      store.set({ picked: [] });
      if (r.checkout_url) { location.href = r.checkout_url; return; }
      location.replace('/portal#/kinderen');
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; b.disabled = false;
      if (ex.status === 409) { kids = await api('/api/public/children'); setTimeout(() => go(0), 1800); }
    }
  };
}

// ------------------------------------------------------------------ navigatie
// Altijd de eerste stap die nog niet klaar is (ingelogde sponsoren slaan gegevens en beveiligen over).
function next() {
  if (!picked().length) return go(0);
  if (!me) return go(1);
  if (me.needs_credential) return go(2);
  return go(3);
}
function go(i) { [stepChoose, stepDetails, stepSecure, stepPay][i](); }

(async () => {
  try {
    const [sp, children, conf] = await Promise.all([api('/api/public/sponsor'), api('/api/public/children'), api('/api/public/config').catch(() => ({}))]);
    cfg = sp.config; kids = children; payInfo = conf;
    try { me = await api('/api/donor/me'); if (me.impersonated_by) me = null; } catch { me = null; }
    if (me) { $('#login-link').textContent = 'Mijn portaal'; $('#login-link').href = '/portal'; }
    const pre = Number(new URLSearchParams(location.search).get('kind'));
    if (pre && kids.some((k) => k.id === pre) && !picked().includes(pre)) store.set({ picked: [...picked(), pre] });
    if (picked().length && me) next(); else go(0);
  } catch (ex) {
    view().innerHTML = `<div class="card">${RF.emptyState({ icon: 'circle-alert', title: 'Er ging iets mis', text: esc(ex.message) })}</div>`;
  }
})();

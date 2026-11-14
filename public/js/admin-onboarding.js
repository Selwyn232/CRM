// Onboarding: veldmedewerker meldt een gezin met kinderen aan (stappenplan, mobiel), medewerker beoordeelt.
// Draait na admin.js en gebruikt diens helpers.
'use strict';

const OB_STEPS = [
  { key: 'gezin', label: 'Gezin', icon: 'house' },
  { key: 'ouder', label: 'Ouder & ID', icon: 'scan-face' },
  { key: 'kinderen', label: 'Kinderen', icon: 'smile' },
  { key: 'documenten', label: 'Documenten', icon: 'file-text' },
  { key: 'toestemming', label: 'Toestemming', icon: 'pencil' },
  { key: 'overzicht', label: 'Indienen', icon: 'send' },
];
const ID_TYPE_LABELS = { paspoort: 'Paspoort', philsys: 'PhilSys (nationale ID)', rijbewijs: 'Rijbewijs', umid: 'UMID', postal_id: 'Postal ID', voter_id: 'Voter’s ID', anders: 'Anders' };
let obConfig = null;
const obCfg = async () => (obConfig = obConfig || await api('/api/onboarding/config'));
const fileUrl = (f) => `/api/onboarding/files/${f.id}`;

// Foto's verkleinen op het toestel (scheelt veel data in het veld). Pdf's gaan ongewijzigd.
async function prepareFile(file) {
  if (!file.type.startsWith('image/') || /heic|heif/i.test(file.type)) {
    return { filename: file.name || 'document', data: await RF.readFileBase64(file) };
  }
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return { filename: 'foto.jpg', data: c.toDataURL('image/jpeg', 0.85) };
}

// ======================================================================= LIJST
async function renderOnboarding(param) {
  if (param && /^\d+$/.test(param)) return renderOnboardingItem(Number(param));
  const status = param || '';
  const rows = await api(`/api/onboarding${status ? `?status=${status}` : ''}`);
  view().innerHTML = `
    ${pageHead('Onboarding', {
    sub: isField() ? 'Meld een gezin met kinderen aan. Een medewerker op kantoor controleert de aanmelding voordat de kinderen zichtbaar worden voor sponsors.'
      : 'Aanmeldingen van veldmedewerkers. Na goedkeuring worden gezin en kinderen aangemaakt en zijn de kinderen te kiezen door sponsors.',
    actions: btn('new', 'Nieuwe aanmelding', { icon: 'plus', kind: 'primary' }),
  })}
    <div class="toolbar" style="margin-bottom:12px"><select id="f-status">${opt('', 'Alle', status)}${Object.entries(RF.LABELS.onboarding).map(([k, v]) => opt(k, v, status)).join('')}</select></div>
    ${rows.length ? `<div class="card flush">${table([
      { label: 'Gezin', render: (o) => `<b>${esc(o.family_name || 'Nog geen naam')}</b><span class="sub">${esc([o.city, o.province].filter(Boolean).join(', '))}</span>` },
      { label: 'Kinderen', render: (o) => `<span class="muted">${esc(o.children.join(', ') || '—')}</span>` },
      { label: 'Status', render: (o) => badge('onboarding', o.status) + (o.status === 'concept' || o.status === 'aanvulling_nodig' ? `<span class="sub muted">${o.done} van ${o.total} klaar</span>` : '') },
      { label: 'Veldmedewerker', render: (o) => `<span class="muted">${esc(o.created_by_name || '')}</span>` },
      { label: 'Bijgewerkt', render: (o) => `<span class="muted">${dateTime(o.updated_at)}</span>` },
    ], rows, { onRow: true })}</div>`
      : `<div class="card">${RF.emptyState({ icon: 'badge-check', title: status ? 'Geen aanmeldingen met deze status' : 'Nog geen aanmeldingen', text: 'Start een aanmelding bij een gezin thuis: gegevens, ID-controle, documenten en toestemming.' })}</div>`}`;
  if (rows.length) bindRows(view(), rows, (o) => go(`#/onboarding/${o.id}`));
  $('#f-status').onchange = () => { location.hash = $('#f-status').value ? `#/onboarding/${$('#f-status').value}` : '#/onboarding'; };
  $('#new').onclick = async () => { const o = await api('/api/onboarding', { method: 'POST', body: { data: {} } }); go(`#/onboarding/${o.id}`); };
}

async function renderOnboardingItem(id, step) {
  const [o, cfg] = await Promise.all([api(`/api/onboarding/${id}`), obCfg()]);
  const editable = ['concept', 'aanvulling_nodig'].includes(o.status) && (isField() || o.created_by === state.user.id);
  if (editable) return renderWizard(o, cfg, step);
  return renderReview(o, cfg);
}

// ======================================================================= STAPPENPLAN
function renderWizard(o, cfg, stepKey) {
  const d = o.data;
  if (!d.children.length) d.children.push({});
  let step = Math.max(0, OB_STEPS.findIndex((s) => s.key === (stepKey || sessionStorage.getItem(`rf-ob-${o.id}`) || 'gezin')));
  const fileOf = (kind, idx = null) => o.files.find((f) => f.kind === kind && (idx === null ? f.child_index == null : f.child_index === idx));
  const val = (v) => esc(v || '');

  const docTile = (kind, label, idx = null, { capture = 'environment', accept = 'image/*,application/pdf' } = {}) => {
    const f = fileOf(kind, idx);
    return `<div class="doc ${f ? 'has' : ''}" data-kind="${kind}" data-idx="${idx ?? ''}">
      <div class="doc-label">${esc(label)}</div>
      <div class="doc-prev">${f ? (f.mime.startsWith('image/') && f.mime !== 'image/heic' ? `<img src="${fileUrl(f)}" alt="">` : `${RF.icon('file-text', 'icon-lg')}`) : `${RF.icon('camera', 'icon-lg')}`}</div>
      <div class="small ${f ? '' : 'muted'}">${f ? `${RF.icon('check', 'icon-sm')} Toegevoegd` : 'Tik om een foto te maken of te kiezen'}</div>
      <input type="file" accept="${accept}" ${capture ? `capture="${capture}"` : ''} aria-label="${esc(label)}">
      ${f ? `<button type="button" class="icon-btn doc-del" data-del="${f.id}" aria-label="Verwijderen">${RF.icon('trash-2')}</button>` : ''}</div>`;
  };

  const bodies = {
    gezin: () => `<h2>Het gezin</h2>
      <div class="field"><label>Naam van het gezin</label><input type="text" data-f="family.name" value="${val(d.family.name)}" placeholder="bv. Familie Santos" required></div>
      <div class="field"><label>Adres (straat, purok, huisnummer)</label><input type="text" data-f="family.street" value="${val(d.family.street)}"></div>
      <div class="field-row"><div class="field"><label>Barangay</label><input type="text" data-f="family.barangay" value="${val(d.family.barangay)}" required></div>
        <div class="field"><label>Plaats / gemeente</label><input type="text" data-f="family.city" value="${val(d.family.city)}" required></div></div>
      <div class="field-row"><div class="field"><label>Provincie</label><input type="text" data-f="family.province" value="${val(d.family.province)}" required></div>
        <div class="field"><label>Telefoon gezin</label><input type="tel" data-f="family.phone" value="${val(d.family.phone)}"></div></div>
      <div class="field"><label>Gezinsleden</label><input type="text" data-f="family.members" value="${val(d.family.members)}" placeholder="bv. moeder, oma, 3 kinderen"></div>
      <div class="field"><label>Inkomen en werk</label><input type="text" data-f="family.income" value="${val(d.family.income)}" placeholder="bv. vader visser, ca. ₱ 4.000 per maand"></div>
      <div class="field"><label>Verhaal van het gezin</label><textarea data-f="family.story" rows="5" placeholder="Hoe leeft het gezin, wat is de situatie, waarom is hulp nodig?">${val(d.family.story)}</textarea>
        <div class="hint">Sponsors lezen dit verhaal (zonder achternaam en adres). Minimaal een paar zinnen.</div></div>
      <p class="hint">Adres, telefoon en inkomen zijn alleen voor Robin Foundation en worden nooit met sponsors gedeeld.</p>`,
    ouder: () => `<h2>Ouder of voogd</h2>
      <div class="field-row"><div class="field"><label>Voornaam</label><input type="text" data-f="guardian.first_name" value="${val(d.guardian.first_name)}"></div>
        <div class="field"><label>Achternaam</label><input type="text" data-f="guardian.last_name" value="${val(d.guardian.last_name)}"></div></div>
      <div class="field-row"><div class="field"><label>Relatie tot de kinderen</label><select data-f="guardian.relation">${['', 'moeder', 'vader', 'oma', 'opa', 'tante', 'oom', 'voogd'].map((r) => opt(r, r ? r[0].toUpperCase() + r.slice(1) : '— kies —', d.guardian.relation)).join('')}</select></div>
        <div class="field"><label>Geboortedatum</label><input type="date" data-f="guardian.birth_date" value="${val(d.guardian.birth_date)}"></div>
        <div class="field"><label>Telefoon</label><input type="tel" data-f="guardian.phone" value="${val(d.guardian.phone)}"></div></div>
      <h3 style="margin-top:20px">Identiteitscontrole</h3>
      ${cfg.veriff ? `<div class="seg" id="id-method" style="margin-bottom:12px"><button type="button" data-m="veriff" class="${o.id_method === 'veriff' ? 'active' : ''}">Veriff (paspoort + Face ID)</button><button type="button" data-m="handmatig" class="${o.id_method === 'handmatig' ? 'active' : ''}">Handmatig</button></div>` : ''}
      ${o.id_method === 'veriff' ? `<div class="callout neutral">${RF.icon('scan-face')}<span>De ouder scant het paspoort of ID en daarna het gezicht met de camera. Veriff controleert of het document echt is en of het gezicht overeenkomt (met live-detectie).
          <br>Status: ${badge('idcheck', o.id_status)}${o.id_result && o.id_result.reason ? ` · ${esc(o.id_result.reason)}` : ''}</span></div>
        <div class="toolbar">${o.id_status !== 'goedgekeurd' ? `<button type="button" class="btn btn-primary" id="veriff-start">${RF.icon('scan-face')}<span>${o.id_status === 'open' ? 'Start controle' : 'Opnieuw starten'}</span></button>` : ''}
          <button type="button" class="btn btn-ghost" id="veriff-refresh">${RF.icon('refresh-cw')}<span>Status vernieuwen</span></button></div>`
      : `<p class="small muted">Maak een duidelijke foto van het identiteitsbewijs (fotopagina) en daarna een selfie van de ouder. Een medewerker op kantoor vergelijkt beide. ${cfg.veriff ? '' : 'Koppel Veriff in Instellingen → Integraties voor automatische controle met gezichtsherkenning.'}</p>
        <div class="field-row"><div class="field"><label>Soort identiteitsbewijs</label><select data-f="guardian.id_type">${opt('', '— kies —', d.guardian.id_type)}${Object.entries(ID_TYPE_LABELS).map(([k, v]) => opt(k, v, d.guardian.id_type)).join('')}</select></div>
          <div class="field"><label>Laatste 4 tekens documentnummer</label><input type="text" data-f="guardian.id_last4" maxlength="4" value="${val(d.guardian.id_last4)}" autocomplete="off"></div></div>
        <div class="doc-grid">${docTile('id_document', 'Foto van paspoort of ID')}${docTile('selfie', 'Selfie van de ouder', null, { capture: 'user', accept: 'image/*' })}</div>
        <p class="hint">We bewaren alleen de laatste 4 tekens van het nummer. De foto’s van het ID en de selfie worden na de controle verwijderd.</p>`}`,
    kinderen: () => `<h2>Kinderen</h2>
      ${d.children.map((k, i) => `<div class="child-block" data-child="${i}">
        <div class="card-head" style="margin-bottom:8px"><h3 style="margin:0">Kind ${i + 1}${k.first_name ? `: ${esc(k.first_name)}` : ''}</h3>
          ${d.children.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-rm-child="${i}">${RF.icon('trash-2')}<span>Verwijderen</span></button>` : ''}</div>
        <div class="field-row"><div class="field"><label>Voornaam</label><input type="text" data-c="first_name" value="${val(k.first_name)}"></div>
          <div class="field"><label>Achternaam</label><input type="text" data-c="last_name" value="${val(k.last_name)}"></div></div>
        <div class="field-row"><div class="field"><label>Geboortedatum</label><input type="date" data-c="birth_date" value="${val(k.birth_date)}"></div>
          <div class="field"><label>Geslacht</label><select data-c="gender">${opt('', '—', k.gender)}${opt('meisje', 'Meisje', k.gender)}${opt('jongen', 'Jongen', k.gender)}</select></div></div>
        <div class="field-row"><div class="field"><label>School</label><input type="text" data-c="school" value="${val(k.school)}"></div>
          <div class="field"><label>Klas</label><input type="text" data-c="grade" value="${val(k.grade)}" placeholder="bv. Grade 3"></div></div>
        <div class="field"><label>Verhaal van het kind</label><textarea data-c="story" rows="4" placeholder="Wat vindt het kind leuk, wat wil het later worden, hoe gaat het op school?">${val(k.story)}</textarea></div>
        <div class="doc-grid">${docTile('foto_kind', 'Foto van het kind', i, { accept: 'image/*' })}${docTile('geboorteakte', 'Geboorteakte (PSA)', i)}${docTile('inschrijving', 'Inschrijfbewijs school', i)}</div>
      </div>`).join('')}
      <button type="button" class="btn btn-ghost" id="add-child">${RF.icon('plus')}<span>Nog een kind</span></button>`,
    documenten: () => `<h2>Documenten van het gezin</h2>
      <div class="doc-grid">${docTile('foto_gezin', 'Foto van het gezin', null, { accept: 'image/*' })}${docTile('adres', 'Bewijs van adres (Barangay certificate)')}</div>
      <p class="hint" style="margin-top:12px">De documenten zijn alleen zichtbaar voor medewerkers van Robin Foundation. Elke keer dat iemand een document opent, wordt dat vastgelegd.</p>`,
    toestemming: () => `<h2>Toestemming</h2>
      <div class="letter" style="white-space:pre-line;margin-bottom:12px">${esc(cfg.consent_text)}</div>
      <p class="small muted">Lees dit voor in de taal van de ouder (Tagalog of Waray) en controleer of het begrepen is.</p>
      <label class="check"><input type="checkbox" data-f="consent.share_photos" ${d.consent.share_photos ? 'checked' : ''}> <span>De ouder geeft toestemming om <b>foto’s</b> van het kind en het gezin met de sponsor te delen</span></label>
      <label class="check"><input type="checkbox" data-f="consent.agreed" ${d.consent.agreed ? 'checked' : ''}> <span><b>De ouder/voogd gaat akkoord</b> met bovenstaande verklaring</span></label>
      <div class="field" style="margin-top:12px"><label>Naam van wie tekent</label><input type="text" data-f="consent.signed_by" value="${val(d.consent.signed_by || [d.guardian.first_name, d.guardian.last_name].filter(Boolean).join(' '))}"></div>
      <label class="small muted" style="display:block;margin-bottom:6px">Handtekening (met de vinger)</label>
      ${fileOf('handtekening') ? `<div class="doc has" style="min-height:0"><div class="doc-prev" style="background:#fff"><img src="${fileUrl(fileOf('handtekening'))}" alt="Handtekening" style="object-fit:contain"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="sig-redo">Opnieuw tekenen</button></div>`
        : `<div class="sig-wrap"><canvas id="sig" aria-label="Tekenvak voor handtekening"></canvas></div>
          <div class="toolbar" style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" id="sig-clear">Wissen</button><button type="button" class="btn btn-primary btn-sm" id="sig-save">Handtekening opslaan</button></div>`}
      <details style="margin-top:14px"><summary class="small">Liever een getekend papieren formulier? Fotografeer het hier.</summary>
        <div class="doc-grid" style="margin-top:10px">${docTile('toestemming', 'Getekende toestemmingsverklaring')}</div></details>`,
    overzicht: () => {
      const open = o.checklist.filter((x) => !x.ok);
      return `<h2>Controleren en indienen</h2>
        ${o.status === 'aanvulling_nodig' && o.review_note ? `<div class="callout warn">${RF.icon('circle-alert')}<span><b>Aanvulling gevraagd:</b> ${esc(o.review_note)}</span></div>` : ''}
        <div class="checklist">${o.checklist.map((x) => `<div class="item"><span class="${x.ok ? 'ok' : 'no'}">${RF.icon(x.ok ? 'circle-check' : 'circle')}</span>
          <span style="flex:1">${esc(x.label)}</span>${x.ok ? '' : `<button type="button" class="link small" data-goto="${x.step}" style="margin:0">Aanvullen</button>`}</div>`).join('')}</div>
        <p class="small muted" style="margin-top:12px">${open.length ? `Nog ${open.length} ${open.length === 1 ? 'punt' : 'punten'} open.` : 'Alles is compleet. Na indienen controleert een medewerker op kantoor de aanmelding.'}</p>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="submit" ${open.length ? 'disabled' : ''}>${RF.icon('send')}<span>Indienen ter beoordeling</span></button>
        ${o.status === 'concept' ? `<button type="button" class="btn btn-quiet btn-sm" id="discard" style="margin-top:12px">Concept verwijderen</button>` : ''}`;
    },
  };

  const draw = () => {
    const s = OB_STEPS[step];
    sessionStorage.setItem(`rf-ob-${o.id}`, s.key);
    const doneSteps = new Set(OB_STEPS.filter((st) => o.checklist.some((x) => x.step === st.key) && o.checklist.filter((x) => x.step === st.key).every((x) => x.ok)).map((st) => st.key));
    view().innerHTML = `<div class="wizard">
      <div class="crumbs"><a href="#/onboarding">Onboarding</a>${RF.icon('chevron-right', 'icon-sm')}<span>${esc(d.family.name || 'Nieuwe aanmelding')}</span></div>
      <div class="steps" role="tablist">${OB_STEPS.map((st, i) => `<button type="button" data-step="${i}" class="${i === step ? 'active' : ''} ${doneSteps.has(st.key) ? 'done' : ''}" role="tab" aria-selected="${i === step}">
        ${RF.icon(doneSteps.has(st.key) ? 'check' : st.icon, 'icon-sm')}${esc(st.label)}</button>`).join('')}</div>
      <form class="card" id="wz" autocomplete="off">${bodies[s.key]()}</form>
      <div class="wizard-foot">
        <button type="button" class="btn btn-ghost" id="prev" ${step === 0 ? 'disabled' : ''}>${RF.icon('arrow-left')}<span>Vorige</span></button>
        <span class="small muted" id="saved" style="align-self:center"></span>
        ${step < OB_STEPS.length - 1 ? `<button type="button" class="btn btn-primary" id="next"><span>Opslaan en verder</span>${RF.icon('arrow-right')}</button>` : '<span></span>'}
      </div></div>`;
    bind();
    const sel = document.querySelector('.steps .active');
    if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  };

  // Formulier → data
  const collect = () => {
    const form = $('#wz');
    if (!form) return;
    form.querySelectorAll('[data-f]').forEach((el) => {
      const [grp, key] = el.dataset.f.split('.');
      d[grp][key] = el.type === 'checkbox' ? el.checked : el.value;
    });
    form.querySelectorAll('[data-child]').forEach((blk) => {
      const k = d.children[Number(blk.dataset.child)];
      blk.querySelectorAll('[data-c]').forEach((el) => { k[el.dataset.c] = el.value; });
    });
  };
  const save = async (extra = {}) => {
    collect();
    const r = await api(`/api/onboarding/${o.id}`, { method: 'PUT', body: { data: d, ...extra } });
    Object.assign(o, r, { data: d });
    if ($('#saved')) $('#saved').textContent = `Opgeslagen ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
  };
  const goStep = async (i) => {
    try { await save(); } catch (ex) { toast(ex.message, 'error'); return; }
    step = Math.max(0, Math.min(OB_STEPS.length - 1, i)); draw(); window.scrollTo(0, 0);
  };
  const reload = async () => { const r = await api(`/api/onboarding/${o.id}`); Object.assign(o, r); Object.assign(d, r.data); if (!d.children.length) d.children.push({}); draw(); };

  function bind() {
    view().querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.step))));
    view().querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => goStep(OB_STEPS.findIndex((s) => s.key === b.dataset.goto))));
    $('#prev').onclick = () => goStep(step - 1);
    if ($('#next')) $('#next').onclick = () => goStep(step + 1);
    // Automatisch opslaan na typen
    $('#wz').addEventListener('input', RF.debounce(() => save().catch(() => {}), 1500));
    // Uploads
    view().querySelectorAll('.doc input[type=file]').forEach((input) => input.addEventListener('change', async () => {
      const file = input.files[0]; if (!file) return;
      const tile = input.closest('.doc');
      tile.classList.add('busy'); tile.querySelector('.small').textContent = 'Uploaden…';
      try {
        await save();
        const prep = await prepareFile(file);
        await api(`/api/onboarding/${o.id}/files`, { method: 'POST', body: { kind: tile.dataset.kind, child_index: tile.dataset.idx === '' ? null : Number(tile.dataset.idx), ...prep } });
        await reload();
      } catch (ex) { toast(ex.message, 'error'); tile.classList.remove('busy'); tile.querySelector('.small').textContent = 'Mislukt, probeer opnieuw'; }
    }));
    view().querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!await confirmDialog('Dit document verwijderen?', 'Verwijderen')) return;
      await api(`/api/onboarding/${o.id}/files/${b.dataset.del}`, { method: 'DELETE' }); reload();
    }));
    if ($('#add-child')) $('#add-child').onclick = () => { collect(); d.children.push({}); save().then(draw); };
    view().querySelectorAll('[data-rm-child]').forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmDialog('Dit kind uit de aanmelding halen? Geüploade documenten van latere kinderen moeten dan mogelijk opnieuw.', 'Verwijderen')) return;
      collect(); d.children.splice(Number(b.dataset.rmChild), 1); await save(); draw();
    }));
    // Veriff
    view().querySelectorAll('#id-method [data-m]').forEach((b) => b.addEventListener('click', async () => {
      try { await save({ id_method: b.dataset.m }); draw(); } catch (ex) { toast(ex.message, 'error'); }
    }));
    if ($('#veriff-start')) $('#veriff-start').onclick = async () => {
      const win = window.open('about:blank', '_blank');
      try { await save(); const r = await api(`/api/onboarding/${o.id}/veriff`, { method: 'POST', body: {} }); if (win) win.location = r.url; else location.href = r.url; await reload(); }
      catch (ex) { if (win) win.close(); toast(ex.message, 'error'); }
    };
    if ($('#veriff-refresh')) $('#veriff-refresh').onclick = reload;
    // Handtekening
    if ($('#sig')) signaturePad($('#sig'));
    if ($('#sig-redo')) $('#sig-redo').onclick = async () => { await api(`/api/onboarding/${o.id}/files/${fileOf('handtekening').id}`, { method: 'DELETE' }); reload(); };
    // Indienen
    if ($('#submit')) $('#submit').onclick = async () => {
      try { await save(); await api(`/api/onboarding/${o.id}/submit`, { method: 'POST', body: {} }); sessionStorage.removeItem(`rf-ob-${o.id}`); toast('Ingediend. Dank je wel!'); go('#/onboarding'); }
      catch (ex) { toast(ex.message, 'error'); }
    };
    if ($('#discard')) $('#discard').onclick = async () => {
      if (!await confirmDialog('Dit concept en alle documenten verwijderen?', 'Verwijderen')) return;
      await api(`/api/onboarding/${o.id}`, { method: 'DELETE' }); go('#/onboarding');
    };
  }

  function signaturePad(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    let drawing = false; let dirty = false;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', (e) => { drawing = true; dirty = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    $('#sig-clear').onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; };
    $('#sig-save').onclick = async () => {
      if (!dirty) return toast('Laat de ouder eerst tekenen', 'error');
      try {
        collect();
        if (!d.consent.agreed) return toast('Vink eerst aan dat de ouder akkoord gaat', 'error');
        d.consent.signed_at = new Date().toISOString();
        await save();
        await api(`/api/onboarding/${o.id}/files`, { method: 'POST', body: { kind: 'handtekening', filename: 'handtekening.png', data: canvas.toDataURL('image/png') } });
        await reload();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  }

  draw();
}

// ======================================================================= BEOORDELEN
function renderReview(o, cfg) {
  const d = o.data;
  const canReview = !isField() && o.status === 'ingediend';
  const own = o.created_by === state.user.id;
  const kindLabel = (f) => `${cfg.file_kinds[f.kind] ? cfg.file_kinds[f.kind].label : f.kind}${f.child_index != null && d.children[f.child_index] ? ` · ${d.children[f.child_index].first_name}` : ''}`;
  const tile = (f) => `<a href="${fileUrl(f)}" target="_blank" rel="noopener">${f.mime.startsWith('image/') && f.mime !== 'image/heic'
    ? `<img src="${fileUrl(f)}" alt="">` : `<div class="pdf">${RF.icon('file-text', 'icon-lg')}</div>`}<div class="cap">${esc(kindLabel(f))}</div></a>`;
  const r = o.id_result;
  const prop = (k, v) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="muted">—</span>'}</dd>`;
  view().innerHTML = `
    <div class="crumbs"><a href="#/onboarding">Onboarding</a>${RF.icon('chevron-right', 'icon-sm')}<span>${esc(d.family.name)}</span></div>
    ${pageHead(esc(d.family.name || 'Aanmelding'), { sub: `${badge('onboarding', o.status)} · door ${esc(o.created_by_name)} · ${o.submitted_at ? `ingediend ${dateTime(o.submitted_at)}` : `gestart ${dateTime(o.created_at)}`}${o.reviewed_by_name ? ` · beoordeeld door ${esc(o.reviewed_by_name)}` : ''}` })}
    ${o.review_note ? `<div class="callout ${o.status === 'goedgekeurd' ? 'neutral' : 'warn'}">${RF.icon('info')}<span>${esc(o.review_note)}</span></div>` : ''}
    ${o.status === 'goedgekeurd' && o.family_id ? `<div class="callout neutral">${RF.icon('circle-check')}<span>Gezin en kinderen zijn aangemaakt. <a href="#/kinderen">Naar Kinderen</a></span></div>` : ''}
    <div class="grid grid-2-1">
      <div class="stack">
        <div class="card"><h2>Gezin</h2><dl class="props">
          ${prop('Adres', d.family.street)}${prop('Barangay', d.family.barangay)}${prop('Plaats', d.family.city)}${prop('Provincie', d.family.province)}
          ${prop('Telefoon', d.family.phone)}${prop('Gezinsleden', d.family.members)}${prop('Inkomen', d.family.income)}</dl>
          <p style="white-space:pre-line;margin:12px 0 0">${esc(d.family.story)}</p></div>
        ${d.children.map((k, i) => `<div class="card"><h2>${esc(k.first_name)} ${esc(k.last_name)}</h2><dl class="props">
          ${prop('Geboren', k.birth_date ? date(k.birth_date) : '')}${prop('Geslacht', k.gender)}${prop('School', [k.school, k.grade].filter(Boolean).join(' · '))}</dl>
          <p style="white-space:pre-line;margin:12px 0">${esc(k.story)}</p>
          <div class="review-grid">${o.files.filter((f) => f.child_index === i).map(tile).join('') || '<span class="muted small">Geen documenten</span>'}</div></div>`).join('')}
        <div class="card"><h2>Documenten gezin</h2><div class="review-grid">${o.files.filter((f) => f.child_index == null).map(tile).join('') || '<span class="muted small">Geen documenten (ID-foto’s worden na beoordeling verwijderd)</span>'}</div>
          <p class="hint" style="margin-top:10px">Het openen van documenten wordt vastgelegd in het audit log.</p></div>
      </div>
      <div class="stack">
        <div class="card"><h2>Ouder / voogd</h2><dl class="props">
          ${prop('Naam', `${d.guardian.first_name} ${d.guardian.last_name}`)}${prop('Relatie', d.guardian.relation)}${prop('Geboren', d.guardian.birth_date ? date(d.guardian.birth_date) : '')}
          ${prop('Telefoon', d.guardian.phone)}${prop('ID', [ID_TYPE_LABELS[d.guardian.id_type], d.guardian.id_last4 ? `…${d.guardian.id_last4}` : ''].filter(Boolean).join(' '))}</dl></div>
        <div class="card"><h2>Identiteitscontrole</h2>
          <p>${o.id_method === 'veriff' ? 'Veriff (document + gezicht)' : 'Handmatig: foto van ID + selfie'} · ${o.id_method === 'veriff' ? badge('idcheck', o.id_status)
            : r ? badge('idcheck', 'goedgekeurd') : o.status === 'ingediend' ? '<span class="badge badge-in_behandeling">Te vergelijken</span>' : badge('idcheck', 'open')}</p>
          ${r ? `<dl class="props">${prop('Uitslag', ({ approved: 'Goedgekeurd', declined: 'Afgewezen', resubmission_requested: 'Opnieuw nodig', expired: 'Verlopen', abandoned: 'Niet afgerond' })[r.decision] || r.decision)}${prop('Document', [r.document_type, r.document_country, r.document_last4 ? `…${r.document_last4}` : ''].filter(Boolean).join(' '))}
            ${prop('Naam op document', r.name)}${prop('Gecontroleerd door', r.checked_by || r.provider)}${r.reason ? prop('Reden', r.reason) : ''}</dl>` : ''}
          ${o.id_method === 'handmatig' && canReview ? '<p class="small muted">Vergelijk de selfie met de foto op het ID, en de naam en geboortedatum met wat is ingevuld.</p>' : ''}</div>
        <div class="card"><h2>Toestemming</h2>
          <p>${d.consent.agreed ? `${RF.icon('circle-check', 'icon-sm')} Getekend door <b>${esc(d.consent.signed_by)}</b>${d.consent.signed_at ? ` op ${esc(new Date(d.consent.signed_at).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}` : 'Niet getekend'}</p>
          <p class="small">${d.consent.share_photos ? 'Foto’s mogen met de sponsor worden gedeeld.' : '<b>Geen</b> toestemming om foto’s te delen: kinderen krijgen geen foto in het portaal.'}</p></div>
        ${canReview ? `<form class="card" id="review"><h2>Beoordelen</h2>
          ${own ? `<div class="callout warn">${RF.icon('circle-alert')}<span>Je hebt deze aanmelding zelf gemaakt. Een collega moet hem beoordelen (vier-ogenprincipe).</span></div>` : ''}
          ${o.id_method === 'handmatig' ? '<label class="check"><input type="checkbox" name="id_checked"> Selfie en ID komen overeen, gegevens kloppen</label>' : ''}
          <label class="check"><input type="checkbox" name="docs_checked"> Geboorteakte, inschrijfbewijs en bewijs van adres zijn gecontroleerd</label>
          <label class="check"><input type="checkbox" name="create_login" checked> Inlog voor het gezin aanmaken (chat met de sponsor)</label>
          <div class="field" style="margin-top:10px"><label>Toelichting (verplicht bij aanvullen of afkeuren)</label><textarea name="note" rows="3"></textarea></div>
          <div class="toolbar wrap"><button type="button" class="btn btn-primary" data-d="goedkeuren" ${own ? 'disabled' : ''}>${RF.icon('circle-check')}<span>Goedkeuren</span></button>
            <button type="button" class="btn btn-ghost" data-d="aanvulling" ${own ? 'disabled' : ''}>Aanvulling vragen</button>
            <button type="button" class="btn btn-ghost" data-d="afkeuren" ${own ? 'disabled' : ''} style="color:var(--bad)">Afkeuren</button></div></form>` : ''}
        ${o.status === 'goedgekeurd' ? '' : `<div class="card"><h2>Checklist</h2><div class="checklist">${o.checklist.map((x) => `<div class="item"><span class="${x.ok ? 'ok' : 'no'}">${RF.icon(x.ok ? 'circle-check' : 'circle')}</span><span>${esc(x.label)}</span></div>`).join('')}</div></div>`}
      </div>
    </div>`;
  view().querySelectorAll('#review [data-d]').forEach((b) => b.addEventListener('click', async () => {
    const f = RF.formData($('#review'));
    const decision = b.dataset.d;
    if (decision === 'afkeuren' && !await confirmDialog('Deze aanmelding afkeuren? De ID-foto’s worden direct verwijderd.', 'Afkeuren')) return;
    try {
      const res = await api(`/api/onboarding/${o.id}/review`, { method: 'POST', body: { ...f, decision } });
      if (res.login) {
        modal({ title: 'Goedgekeurd: inlog voor het gezin', body: `<p>Gezin en ${res.child_ids.length} ${res.child_ids.length === 1 ? 'kind zijn' : 'kinderen zijn'} aangemaakt en nu te kiezen door sponsors.</p>
          <p>Geef deze inlog aan de veldmedewerker voor het gezin. <b>Het wachtwoord wordt maar één keer getoond.</b></p>
          <div class="callout neutral" style="font-family:var(--mono);font-size:15px;flex-direction:column;gap:4px"><span>Pagina: ${esc(location.origin)}/ontvanger</span><span>Gebruikersnaam: ${esc(res.login.username)}</span><span>Wachtwoord: ${esc(res.login.password)}</span></div>` });
      } else toast(decision === 'goedkeuren' ? 'Goedgekeurd' : decision === 'aanvulling' ? 'Teruggestuurd voor aanvulling' : 'Afgekeurd');
      renderOnboardingItem(o.id);
      refreshNavCounts();
    } catch (ex) { toast(ex.message, 'error'); }
  }));
}

ROUTES.onboarding = renderOnboarding;

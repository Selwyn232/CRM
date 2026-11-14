// Robin Foundation · homepage (zonder afhankelijkheden)
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const euro = (cents) => `€ ${(cents / 100).toLocaleString('nl-NL', { maximumFractionDigits: cents % 100 ? 2 : 0, minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
  const getJSON = (url) => fetch(url, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Kopregel krijgt een lijntje zodra je scrolt
  const head = $('.site-head');
  const onScroll = () => head.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // Rustig infaden (8 tot 12 px, max 400 ms); niets bij 'minder beweging'
  const reveal = (root = document) => {
    const els = root.querySelectorAll('.reveal:not(.in)');
    if (reduced || !('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach((el) => io.observe(el));
  };
  reveal();

  // De kop-knop pas tonen als de grote knop uit beeld is: één hoofdactie per scherm
  const heroBtn = $('.hero .btn');
  if (heroBtn && 'IntersectionObserver' in window) {
    head.classList.add('cta-off');
    new IntersectionObserver(([e]) => head.classList.toggle('cta-off', e.isIntersecting || e.boundingClientRect.top > 0)).observe(heroBtn);
  }

  // Getekende verbindingslijn langs de drie stapnummers (alleen breed scherm)
  const line = $('.steps-line'); const wrap = $('.steps-wrap');
  const drawLine = () => {
    if (!line || getComputedStyle(line).display === 'none') return;
    const base = wrap.getBoundingClientRect();
    const pts = [...wrap.querySelectorAll('.num')].map((n) => { const r = n.getBoundingClientRect(); return [r.left - base.left + r.width / 2, r.top - base.top + r.height / 2]; });
    if (pts.length < 3) return;
    const [[x1, y1], [x2, y2], [x3, y3]] = pts; const off = 34; // net naast de cirkels beginnen en eindigen
    line.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    line.style.width = `${base.width}px`; line.style.height = `${base.height}px`;
    const c = (ax, ay, bx, by) => `C${ax + (bx - ax) * .45} ${ay - 26} ${ax + (bx - ax) * .55} ${by + 22} ${bx - off} ${by}`;
    line.querySelector('path').setAttribute('d', `M${x1 + off} ${y1} ${c(x1 + off, y1, x2, y2)} M${x2 + off} ${y2} ${c(x2 + off, y2, x3, y3)}`);
  };
  window.addEventListener('resize', drawLine); window.addEventListener('load', drawLine); drawLine();

  // Uitlegvideo: eigen afspeelknop over de poster, daarna de gewone bediening
  (() => {
    const v = $('#explainer'); const b = $('#explainer-play'); const err = $('#explainer-error');
    if (!v || !b) return;
    v.controls = false;
    const fail = () => { b.hidden = true; v.controls = true; err.hidden = false; };
    const NO_SOURCE = 3;
    b.addEventListener('click', () => {
      if (v.networkState === NO_SOURCE) return fail();
      b.hidden = true; v.controls = true;
      const p = v.play();
      if (p && p.catch) p.catch((e) => { if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') fail(); });
    });
    v.addEventListener('error', fail, true);
    const src = v.querySelector('source'); if (src) src.addEventListener('error', fail);
    if (v.networkState === NO_SOURCE) fail();
    v.addEventListener('play', () => { b.hidden = true; v.controls = true; });
    v.addEventListener('ended', () => { try { v.currentTime = 0; } catch { /* */ } v.controls = false; b.hidden = false; });
  })();

  // Verdeling van het maandbedrag (uit de instellingen, zodat het altijd klopt)
  const IMG = { maaltijden: 'maaltijd', school: 'school', verzorging: 'verzorging', noodfonds: 'noodfonds' };
  const SHADES = ['#2E5A3B', '#8FA27C', '#E8601C', '#3B2A20'];
  const renderMoney = (cfg) => {
    if (!cfg || !Array.isArray(cfg.parts)) return;
    const total = cfg.amount_cents;
    $('.big-amount').textContent = euro(total);
    const ratio = $('#ratio');
    ratio.innerHTML = cfg.parts.map((p, i) => `<span style="flex:${p.cents} 1 0;background:${SHADES[i % SHADES.length]}"></span>`).join('');
    ratio.setAttribute('aria-label', `Verdeling van ${euro(total)}: ${cfg.parts.map((p) => `${euro(p.cents)} ${p.label.toLowerCase()}`).join(', ')}`);
    const list = $('#parts');
    const sameAsStatic = cfg.parts.length === list.children.length && cfg.parts.every((p, i) => IMG[p.key] && list.children[i].querySelector('img').src.includes(IMG[p.key]));
    if (sameAsStatic) {
      cfg.parts.forEach((p, i) => { list.children[i].querySelector('.amt').textContent = euro(p.cents); });
    } else {
      list.innerHTML = cfg.parts.map((p) => `<li class="reveal">${IMG[p.key] ? `<img src="/img/home/deel-${IMG[p.key]}.webp" alt="" width="120" height="120" loading="lazy">` : '<span></span>'}
        <span class="amt">${euro(p.cents)}</span><div><h3>${esc(p.label)}</h3><p>${esc(p.description || '')}</p></div></li>`).join('');
      reveal(list);
    }
  };

  // Live aantallen
  const renderCounts = (counts) => {
    if (!counts) return;
    document.querySelectorAll('#figures dd').forEach((dd) => {
      const n = Number(counts[dd.dataset.k] || 0);
      dd.textContent = n.toLocaleString('nl-NL');
    });
    // Een getal 0 bij "gesponsord" zegt niets: dan tonen we alleen wie er wacht.
    if (!Number(counts.sponsored)) document.querySelectorAll('#figures > div').forEach((d) => { if (d.querySelector('dd').dataset.k !== 'available') d.hidden = true; });
  };

  // Kinderen die wachten (4 tot 8) + polaroid in de hero
  const kidAge = (c) => (c.age != null ? `${c.age} jaar` : '');
  const renderKids = (kids) => {
    const ul = $('#kids');
    const n = kids.length >= 8 ? 8 : kids.length >= 6 ? 6 : Math.min(kids.length, 4);
    const pick = kids.slice(0, n);
    if (!pick.length) { ul.innerHTML = '<li class="kids-empty">Op dit moment heeft elk kind een sponsor. Dank je wel.</li>'; return; }
    ul.innerHTML = pick.map((c) => `<li class="kid reveal"><a href="/aanmelden?kind=${encodeURIComponent(c.id)}" aria-label="Kies ${esc(c.first_name)}, ${esc(kidAge(c))}, ${esc(c.province || c.country || '')}">
      <div class="photo">${c.photo_url ? `<img src="${esc(c.photo_url)}" alt="" loading="lazy" width="400" height="500">` : `<span class="initial" aria-hidden="true">${esc(c.first_name.slice(0, 1))}</span>`}
      <span class="choose" aria-hidden="true">Kies ${esc(c.first_name)}</span></div>
      <div class="name">${esc(c.first_name)}</div>
      <div class="meta">${[kidAge(c), c.province || c.country].filter(Boolean).map(esc).join(' · ')}</div></a></li>`).join('');
    reveal(ul);

    const first = kids.find((c) => c.photo_url);
    const pol = $('#polaroid');
    if (first && pol) {
      const img = pol.querySelector('img');
      img.src = first.photo_url; img.alt = `${first.first_name}${first.age != null ? `, ${first.age} jaar` : ''}, wacht op een sponsor`;
      img.loading = 'eager';
      pol.querySelector('figcaption').textContent = `${first.first_name}${first.age != null ? `, ${first.age}` : ''} · ${first.province || first.country || ''}`;
      img.addEventListener('load', () => { pol.hidden = false; }, { once: true });
      if (img.complete && img.naturalWidth) pol.hidden = false;
    }
  };

  getJSON('/api/public/sponsor').then((s) => { renderMoney(s.config); renderCounts(s.counts); }).catch(() => {
    document.querySelectorAll('#figures dd').forEach((dd) => { dd.closest('div').hidden = true; });
  });
  getJSON('/api/public/children').then(renderKids).catch(() => getJSON('/api/public/sponsor').then((s) => renderKids(s.available || [])).catch(() => {
    $('#kids').innerHTML = '<li class="kids-empty"><a href="/aanmelden">Bekijk de kinderen die op een sponsor wachten</a></li>';
  }));
})();

// Taalkeuze (Nederlands / English) voor elke pagina.
// De server zet dit script bovenaan elke pagina, met de standaardtaal uit Instellingen (data-default).
// Een bezoeker kan zelf wisselen met de knop; die keuze bewaren we in deze browser en gaat vóór de standaard.
(function () {
  'use strict';
  var KEY = 'rf_lang';
  var me = document.currentScript;
  var def = (me && me.getAttribute('data-default')) === 'en' ? 'en' : 'nl';
  var version = ((me && me.src) || '').split('?')[1] || '';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* privémodus */ }
  var lang = stored === 'en' || stored === 'nl' ? stored : def;

  document.documentElement.lang = lang;
  window.RF_LANG = lang;
  window.RF_LOCALE = lang === 'en' ? 'en-GB' : 'nl-NL';
  window.RF_LANG_SET = function (l) {
    try { localStorage.setItem(KEY, l); } catch (e) { /* */ }
    location.reload();
  };

  if (lang === 'en') {
    // Pagina even verbergen tot de vertaling klaar is, zodat je geen Nederlands ziet flitsen (max. 1,5 s).
    document.documentElement.className += ' i18n-pending';
    var st = document.createElement('style');
    st.textContent = 'html.i18n-pending body{visibility:hidden}';
    document.head.appendChild(st);
    setTimeout(function () { document.documentElement.classList.remove('i18n-pending'); }, 1500);
    var q = version ? '?' + version : '';
    document.write('<script src="/js/i18n-dict-en.js' + q + '"><\/script><script src="/js/i18n-en.js' + q + '"><\/script>');
  }

  // ---------------------------------------------------------------- de knop
  function button(extraClass) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lang-switch' + (extraClass ? ' ' + extraClass : '');
    b.setAttribute('translate', 'no');
    b.setAttribute('data-i18n-skip', '');
    var other = lang === 'en' ? 'nl' : 'en';
    b.setAttribute('aria-label', other === 'en' ? 'Switch to English' : 'Schakel naar Nederlands');
    b.title = b.getAttribute('aria-label');
    b.innerHTML = '<span class="' + (lang === 'nl' ? 'on' : '') + '">NL</span><span class="' + (lang === 'en' ? 'on' : '') + '">EN</span>';
    b.addEventListener('click', function () { window.RF_LANG_SET(other); });
    return b;
  }
  function place() {
    if (document.querySelector('.lang-switch')) return;
    var done = false;
    var top = document.querySelector('.topbar-inner');
    if (top) {
      var last = top.lastElementChild;
      // vóór de laatste knop (bijv. Inloggen / Uitloggen), anders achteraan
      if (last && last !== top.firstElementChild && !last.matches('nav')) top.insertBefore(button(), last); else top.appendChild(button());
      done = true;
    }
    var foot = document.querySelector('.sidebar-foot');
    if (foot) { foot.insertBefore(button('in-sidebar'), foot.firstChild); done = true; }
    var mbar = document.querySelector('.mobile-bar .right-tools');
    if (mbar) { mbar.insertBefore(button(), mbar.firstChild); done = true; }
    if (!done) document.body.appendChild(button('floating'));
  }
  var css = document.createElement('style');
  css.textContent = '.lang-switch{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:999px;border:1px solid rgba(0,0,0,.12);'
    + 'background:rgba(255,255,255,.7);font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.04em;cursor:pointer;color:inherit;flex:none}'
    + '.lang-switch span{padding:5px 7px;border-radius:999px;opacity:.55}'
    + '.lang-switch span.on{background:#1f2937;color:#fff;opacity:1}'
    + '.lang-switch:focus-visible{outline:2px solid currentColor;outline-offset:2px}'
    + '.lang-switch.in-sidebar{margin:0 0 10px 4px}'
    + '.lang-switch.floating{position:fixed;top:12px;right:12px;z-index:1000;box-shadow:0 2px 10px rgba(0,0,0,.08)}'
    + '.topbar-inner .lang-switch{margin-left:auto;margin-right:10px}'
    + '.topbar-inner .lang-switch + *{margin-left:0}';
  document.head.appendChild(css);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place); else place();
}());

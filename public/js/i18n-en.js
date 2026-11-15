// Vertaalmachine Nederlands → Engels voor de hele applicatie.
// Werkt op de pagina zelf: elke tekst en elk zichtbaar attribuut wordt opgezocht in het woordenboek
// (i18n-dict-en.js), ook alles wat later verschijnt (MutationObserver). Wat niet in het woordenboek staat,
// blijft zoals het is. Chatberichten en invoervelden worden nooit aangeraakt.
(function () {
  'use strict';
  var D = window.RF_DICT_EN || { e: {}, p: [] };
  var exact = D.e;
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tip', 'label'];
  var SKIP = 'script,style,textarea,code,pre,[translate="no"],.notranslate,[contenteditable=""],[contenteditable="true"],[data-i18n-skip]';
  var LETTER = /[A-Za-zÀ-ÿ]/;

  // Patronen met {0}, {1} → reguliere expressies
  var patterns = (D.p || []).map(function (pair) {
    var src = pair[0];
    var order = [];
    var re = src.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\d+)\}/g, function (_, n) { order.push(Number(n)); return '([\\s\\S]+?)'; });
    // letterlijke accolades die na escapen nog over zijn
    re = re.replace(/(^|[^\\])([{}])/g, '$1\\$2');
    try { return { re: new RegExp('^' + re + '$'), order: order, out: pair[1] }; } catch (e) { return null; }
  }).filter(Boolean);

  var cache = new Map();
  var has = function (k) { return Object.prototype.hasOwnProperty.call(exact, k); };
  function lookup(core, depth) {
    depth = depth || 0;
    if (has(core)) return exact[core];
    if (depth > 2) return null;
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      var r = p.re.exec(core);
      if (!r) continue;
      var vals = {};
      for (var j = 0; j < p.order.length; j++) {
        var v = r[j + 1];
        var tv = v.trim(); var lv = tv && /[A-Za-zÀ-ÿ]/.test(tv) ? lookup(tv, depth + 1) : null;
        vals[p.order[j]] = lv != null ? v.replace(tv, lv) : v;
      }
      return p.out.replace(/\{(\d+)\}/g, function (_, n) { return vals[n] != null ? vals[n] : ''; });
    }
    // "12 kinderen", "€ 50 per maand": getal vooraan, rest uit het woordenboek
    var num = core.match(/^([€+\-]?\s?[\d.,]+%?)\s+([\s\S]+)$/);
    if (num) {
      var rest = lookup(num[2], depth + 1);
      if (rest != null) {
        if (num[1] === '1' && /^[a-z]+s$/.test(rest)) rest = rest.slice(0, -1); // "1 jaar" → "1 year"
        return num[1] + ' ' + rest;
      }
    }
    // losse scheidingstekens aan het begin of eind (· , : —)
    var m = core.match(/^([·,:;—–-]\s*)?([\s\S]*?)(\s*[·,:—–-])?$/);
    if (m && (m[1] || m[3]) && m[2]) { var inner = lookup(m[2], depth + 1); if (inner != null) return (m[1] || '') + inner + (m[3] || ''); }
    // "8 jaar · Samar": losse delen tussen middenpunten apart vertalen
    if (core.indexOf(' · ') > 0) {
      var changed = false;
      var parts = core.split(' · ').map(function (x) { var t = lookup(x, depth + 1); if (t != null) { changed = true; return t; } return x; });
      if (changed) return parts.join(' · ');
    }
    return null;
  }
  function tr(s) {
    if (!s || !LETTER.test(s)) return null;
    if (cache.has(s)) return cache.get(s);
    var m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    var core = m[2].replace(/\s+/g, ' ');
    var t = lookup(core);
    var res = t == null || t === core ? null : m[1] + t + m[3];
    cache.set(s, res);
    return res;
  }
  window.RF_T = function (s) { return tr(s) || s; };

  function skipped(el) { return !el || (el.closest && el.closest(SKIP)); }
  function doText(node) {
    var v = node.nodeValue;
    if (node.__rfOut === v) return;
    if (skipped(node.parentElement)) return;
    var t = tr(v);
    if (t != null) { node.__rfOut = t; node.nodeValue = t; }
  }
  function doAttr(el, a) {
    var v = el.getAttribute(a);
    if (v == null || (el.__rfA && el.__rfA[a] === v)) return;
    var t = tr(v);
    if (t != null) { (el.__rfA = el.__rfA || {})[a] = t; el.setAttribute(a, t); }
  }
  function doEl(el) {
    if (skipped(el)) return;
    for (var i = 0; i < ATTRS.length; i++) if (el.hasAttribute(ATTRS[i])) doAttr(el, ATTRS[i]);
    if (el.tagName === 'INPUT' && /^(submit|button)$/i.test(el.type)) doAttr(el, 'value');
    // <option> zonder value: de tekst is de waarde, dus eerst de originele waarde vastzetten
    if (el.tagName === 'OPTION' && !el.hasAttribute('value')) el.setAttribute('value', el.textContent);
  }
  function walk(root) {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) { if (skipped(root)) return; doEl(root); }
    var w = document.createTreeWalker(root, 5 /* elementen + tekst */, {
      acceptNode: function (n) { return n.nodeType === 1 && n.matches(SKIP) ? 2 /* REJECT: ook kinderen overslaan */ : 1; },
    });
    var n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doEl(n); }
  }

  // Dialogen van de browser
  ['alert', 'confirm', 'prompt'].forEach(function (k) {
    var orig = window[k];
    if (!orig) return;
    window[k] = function (msg) { var a = Array.prototype.slice.call(arguments); if (typeof msg === 'string') a[0] = window.RF_T(msg); return orig.apply(window, a); };
  });

  function start() {
    walk(document.documentElement);
    document.documentElement.classList.remove('i18n-pending');
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
        else if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes' && !skipped(m.target)) doAttr(m.target, m.attributeName);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  // <head> (titel) meteen, de rest zodra de pagina er staat
  if (document.title) { var t = tr(document.title); if (t) document.title = t; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());

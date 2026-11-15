// Haalt alle (vermoedelijk) zichtbare Nederlandse teksten uit de code.
const fs = require('fs'); const path = require('path');
const acorn = require('acorn'); const walk = require('acorn-walk');
const ROOT = path.resolve(process.argv[2] || '.');
const PH = '\u0001';
const out = new Map(); // key -> {kind:'exact'|'pattern', ctx}
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&middot;': '·', '&hellip;': '…', '&rsquo;': '’', '&euro;': '€', '&mdash;': '—', '&ndash;': '–' };
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENT[m] ?? m);
const letters = (s) => (s.replace(new RegExp(PH, 'g'), '').match(/[A-Za-zÀ-ÿ]/g) || []).length;
const ATTRS = /\b(title|placeholder|aria-label|alt|data-tip|label|data-confirm)\s*=\s*"([^"]*)"/g;
function add(text, ctx) {
  text = decode(text).replace(/\s+/g, ' ').trim();
  if (letters(text) < 2) return;
  if (/^[\w$.]+\(/.test(text)) return;
  const n = (text.match(new RegExp(PH, 'g')) || []).length;
  if (n) {
    let i = 0; const key = text.replace(new RegExp(PH, 'g'), () => `{${i++}}`);
    if (!out.has(key)) out.set(key, { kind: 'pattern', ctx });
    for (const piece of text.split(PH)) addExact(piece, ctx + ' | uit: ' + key);
  } else addExact(text, ctx);
}
function addExact(t, ctx) {
  t = t.replace(/\s+/g, ' ').trim().replace(/^[·,:;—–-]\s*/, '').replace(/\s*[·,—–-]$/, '').trim();
  if (letters(t) < 2) return;
  if (!out.has(t)) out.set(t, { kind: 'exact', ctx });
}
function segHtml(s, ctx) {
  // attributen
  s.replace(/<[^>]*>/g, (tag) => { tag.replace(ATTRS, (_, a, v) => add(v, ctx + ' [' + a + ']')); return ''; });
  // tekst tussen tags
  s.split(/<[^>]*>/).forEach((t) => add(t, ctx));
}
const looksCode = (s) => {
  const t = s.trim();
  if (!t) return true;
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|PRAGMA|BEGIN|COMMIT)\b/i.test(t)) return true;
  if (/\b(FROM|WHERE|JOIN|VALUES)\b/.test(t) && /[A-Z]{4}/.test(t)) return true;
  if (/^[#./]|^https?:|^(application|text|image|video)\//.test(t)) return true;
  if (/^[a-z0-9_\-:.\/?=&%]+$/.test(t)) return true; // sleutels, ids, klassen
  if (/^[a-z][\w-]*(\s+[a-z][\w-]*)*$/.test(t) && /[-_]/.test(t)) return true; // css-klassen
  if (/^[\w-]+\s*:\s*[^ ]+;?$/.test(t) && !/ /.test(t.replace(/:\s*/, ''))) return true;
  if (/^\[?[\w-]+(=|\])/.test(t) && !/ /.test(t)) return true;
  if (/^(GET|POST|PUT|DELETE|PATCH)$/.test(t)) return true;
  return false;
};
function handleString(str, ctx, isTpl) {
  if (/[<>]/.test(str)) return segHtml(str, ctx);
  if (looksCode(str.replace(new RegExp(PH, 'g'), 'x'))) return;
  // los woord in kleine letters zonder spatie: alleen als het geen sleutel lijkt (heeft accent of is in een template)
  const t = str.trim();
  if (!/\s/.test(t) && /^[a-z]/.test(t) && !isTpl) return;
  add(str, ctx);
}
function scanJs(code, file, mode) {
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }); }
  catch (e) { console.error('parse', file, e.message); return; }
  const skip = new Set();
  walk.fullAncestor(ast, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 2];
    // argumenten van querySelector, require, addEventListener, classList, api-paden, sql
    if (parent && parent.type === 'CallExpression' && parent.callee && parent.arguments.includes(node) && (node.type === 'Literal' || node.type === 'TemplateLiteral')) {
      const c = parent.callee; const name = c.property ? c.property.name : c.name;
      if (/^(querySelector|querySelectorAll|getElementById|require|addEventListener|removeEventListener|toggle|add|remove|contains|setAttribute|getAttribute|closest|matches|get|all|run|prepare|exec|startsWith|endsWith|includes|split|join|replace|test|match|getItem|setItem|removeItem|audit|setting|icon|createElement|toLocaleDateString|toLocaleString|Intl|NumberFormat|fetch|api|getJSON|open|postMessage|send|setHeader|writeHead|hasOwnProperty|indexOf|padStart|toFixed|cookie|parse|stringify|log|error|warn|info|digest|createHash|createHmac|update)$/.test(name || '')) {
        if (!(name === 'icon' || name === 'api') || node.type !== 'TemplateLiteral') { skip.add(node); }
      }
    }
    if (parent && parent.type === 'MemberExpression' && parent.property === node) skip.add(node);
    if (parent && parent.type === 'Property' && parent.key === node) skip.add(node);
    if (parent && (parent.type === 'BinaryExpression') && ['===', '!==', '==', '!='].includes(parent.operator)) skip.add(node);
    if (parent && parent.type === 'SwitchCase') skip.add(node);
    if (parent && parent.type === 'ImportDeclaration') skip.add(node);
  });
  walk.fullAncestor(ast, (node, ancestors) => {
    if (skip.has(node)) return;
    if (ancestors.some((a) => skip.has(a))) return;
    if (mode === 'server') {
      // alleen meldingen: new AppError(.., 'tekst'), { error: 'tekst' }, message:
      const inErr = ancestors.some((a) => (a.type === 'NewExpression' && a.callee.name === 'AppError') || (a.type === 'Property' && a.key && /^(error|message|reason|label|title)$/.test(a.key.name || a.key.value || '')));
      if (!inErr) return;
    }
    const line = code.slice(0, node.start).split('\n').length;
    const ctx = `${file}:${line}`;
    if (node.type === 'Literal' && typeof node.value === 'string') handleString(node.value, ctx, false);
    if (node.type === 'TemplateLiteral') handleString(node.quasis.map((q) => q.value.cooked).join(PH), ctx, true);
  });
}
// JS
for (const f of fs.readdirSync(path.join(ROOT, 'public/js'))) {
  if (!f.endsWith('.js') || /^(icons|i18n)/.test(f)) continue;
  scanJs(fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8'), 'public/js/' + f, 'client');
}
for (const f of ['api.js', 'api-sponsor.js', 'api-onboarding.js', 'onboarding.js', 'sponsoring.js', 'services.js', 'passkeys.js', 'payments.js', 'idcheck.js', 'translate.js']) {
  const p = path.join(ROOT, 'src', f); if (fs.existsSync(p)) scanJs(fs.readFileSync(p, 'utf8'), 'src/' + f, 'server');
}
// HTML
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
  if (!f.endsWith('.html')) continue;
  let html = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
  html = html.replace(/<script>([\s\S]*?)<\/script>/g, (_, js) => { scanJs(js, 'public/' + f + '<script>', 'client'); return ''; });
  html = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1]; if (title) add(title, 'public/' + f + ' <title>');
  html.replace(/<meta name="description" content="([^"]*)"/, (_, d) => add(d, f + ' meta'));
  segHtml(html.replace(/<head>[\s\S]*<\/head>/, ''), 'public/' + f);
}
const arr = [...out].map(([k, v]) => ({ nl: k, kind: v.kind, ctx: v.ctx }));
fs.writeFileSync(process.argv[3], JSON.stringify(arr, null, 1));
console.log('totaal', arr.length, 'exact', arr.filter((x) => x.kind === 'exact').length, 'patronen', arr.filter((x) => x.kind === 'pattern').length,
  'tekens', arr.reduce((s, x) => s + x.nl.length, 0));

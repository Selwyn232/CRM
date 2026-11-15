'use strict';
// Bouwt public/js/i18n-dict-en.js uit i18n/en.json (Nederlands → Engels).
// Gebruik: node scripts/i18n-build.js
// Nieuwe teksten vinden: npm i --no-save acorn acorn-walk && node scripts/i18n-extract.js . /tmp/strings.json
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = JSON.parse(fs.readFileSync(path.join(root, 'i18n/en.json'), 'utf8'));
const e = {}; const p = [];
for (const [nl, en] of Object.entries(src)) {
  if (typeof en !== 'string' || !en || en === nl) continue;
  if (/\{\d+\}/.test(nl)) {
    const fixed = nl.replace(/\{\d+\}/g, '');
    if ((fixed.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 3) p.push([nl, en]);
  } else e[nl] = en;
}
// specifiekste patronen eerst
p.sort((a, b) => b[0].replace(/\{\d+\}/g, '').length - a[0].replace(/\{\d+\}/g, '').length);
const out = `// Gegenereerd door scripts/i18n-build.js uit i18n/en.json. Niet met de hand wijzigen.\nwindow.RF_DICT_EN = ${JSON.stringify({ e, p })};\n`;
fs.writeFileSync(path.join(root, 'public/js/i18n-dict-en.js'), out);
console.log(`woordenboek: ${Object.keys(e).length} teksten, ${p.length} patronen`);

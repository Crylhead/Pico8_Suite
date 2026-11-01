// Static checks for index.html: unique element IDs and existing local script/style/link targets.
// Run: node tests/check-static.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const errors = [];
const ids = new Map();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) || 0) + 1);
for (const [id, count] of ids) if (count > 1) errors.push(`duplicate id "${id}" (${count}x)`);
let refs = 0;
for (const m of html.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(?:[a-z]+:|\/\/|#)/i.test(ref)) continue;
  refs++;
  if (!fs.existsSync(path.join(root, ref.split(/[?#]/)[0]))) errors.push(`missing local reference ${ref}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`index.html: ${ids.size} unique IDs, ${refs} local script/style references exist`);

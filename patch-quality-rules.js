const fs = require('fs');
const path = 'server.js';
let s = fs.readFileSync(path, 'utf8');
let changes = 0;

function replaceOnce(pattern, replacement, label) {
  if (pattern.test(s)) {
    s = s.replace(pattern, replacement);
    changes += 1;
    console.log('QUALITY PATCH', label);
    return true;
  }
  return false;
}

// Final belt-and-suspenders cleanup: visible product titles must never contain emojis.
replaceOnce(
  /title:String\(x\.title\|\|product\.title\)\.slice\(0,255\)/,
  "title:autopilotStripEmoji(x.title||product.title).slice(0,255)",
  'emoji-free product title'
);

// Make the visible description materially useful, not just a short sentence or two.
replaceOnce(
  /autopilotPlainText\(product\.description\)\.length<500/g,
  'autopilotPlainText(product.description).length<900',
  'minimum description length 900'
);

// Ask the model for a fuller product description on every future repair/new pass.
replaceOnce(
  /Zielumfang der Beschreibung: etwa 180 bis 260 Wörter\./,
  'Zielumfang der Beschreibung: etwa 220 bis 320 Wörter.',
  '220-320 word description target'
);

// Normalize supplier-style bundle labels into natural German customer-facing names.
replaceOnce(
  /base:'Ausführung '\+letter\+' – '\+count\+'er Set'/,
  "base:count+'er Set – Variante '+letter",
  'natural variant naming'
);

fs.writeFileSync(path, s, 'utf8');
console.log('QUALITY PATCH DONE', { changes });
if (!changes) {
  console.log('QUALITY PATCH WARNING: no matching server.js patterns found');
}

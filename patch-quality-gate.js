const fs = require('fs');
const path = 'server.js';
let s = fs.readFileSync(path, 'utf8');
let changes = 0;

function patch(re, replacement, label) {
  if (!re.test(s)) {
    console.warn('QUALITY V4 PATCH NOT FOUND', label);
    return false;
  }
  s = s.replace(re, replacement);
  changes++;
  console.log('QUALITY V4 PATCH', label);
  return true;
}

// SAFETY: only DRAFT products are ever eligible. This is a second hard guard even if
// the candidate expression is changed elsewhere later.
patch(
  /const token=await getClientToken\(\),products=await autopilotListProducts\(token\);/,
  "const token=await getClientToken(),productsAll=await autopilotListProducts(token),products=productsAll.filter(p=>String(p?.status||'')==='DRAFT'); console.log('CATALOG V4 DRAFT-ONLY',productsAll.length,'->',products.length);",
  'draft-only-filter'
);
patch(
  /for\(const product of candidates\.slice\(0,autopilotMaxPerCycle\(\)\)\)\{try\{/,
  "for(const product of candidates.slice(0,autopilotMaxPerCycle())){if(String(product?.status||'')!=='DRAFT'){console.warn('CATALOG V4 SKIP NON-DRAFT',product?.id,product?.status);continue;}try{",
  'draft-only-loop-guard'
);

// The quality gate is 900 plain-text characters. A short result is retried before any
// Shopify write and before homestro-ai-processed can be added.
s = s.replace(/autopilotPlainText\(product\.description\)\.length<500/g, 'autopilotPlainText(product.description).length<900');
s = s.replace(/desc\.length<500/g, 'desc.length<900');
changes++;
console.log('QUALITY V4 PATCH description thresholds -> 900');

// Stronger AI requirements: long German sales copy, no emoji, no supplier codes.
patch(
  /const system='Du bist der deutsche E-Commerce-Redakteur von Homestro\.de\.[^']*';const user=/,
  "const system='Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Erstelle professionelle, verkaufsstarke und ehrliche Produktdaten ausschließlich auf Deutsch. Keine Emojis, keine Symbol-Emoticons und keine dekorativen Unicode-Symbole in sichtbaren Texten. Das Zeichen TM darf als ™ verwendet werden. Keine Lieferanten-SKU, internen Codes, Rohbezeichnungen wie Style A-2PCS, G17 A, L007 Set A oder China-Mainland im sichtbaren Text. Erfinde keine technischen Daten, Materialien, Maße, Zertifikate, Garantien, Bewertungen, Verkaufszahlen oder Lieferzeiten. Schreibe die Produktbeschreibung als vollständiges HTML mit 3 bis 5 aussagekräftigen Absätzen und einer Aufzählung mit 5 bis 7 konkreten Vorteilen. Die Beschreibung muss mindestens 900 Zeichen Fließtext enthalten und idealerweise 1200 bis 1800 Zeichen lang sein. Vermeide Füllsätze und Wiederholungen. Erstelle außerdem einen natürlichen SEO-Titel, eine SEO-Beschreibung und 5 bis 10 sachliche deutsche Tags. Die Ausgabe muss ausschließlich gültiges JSON sein mit title,description,seoTitle,seoDescription,handle,tags,category. Variantennamen werden separat normalisiert.';const user=",
  'strong-ai-system-prompt'
);

// Install a retry wrapper around the existing AI function. patch-autopilot created the
// original function on every fresh start, so this is safe to install here.
if (s.includes('async function autopilotAiProduct(input){') && !s.includes('HOMESTRO_QUALITY_V4_WRAPPER')) {
  s = s.replace('async function autopilotAiProduct(input){', 'async function autopilotAiProductBase(input){', 1);
  const insertAt = s.indexOf('async function autopilotRun');
  if (insertAt < 0) throw new Error('autopilotRun marker not found');
  const wrapper = `// HOMESTRO_QUALITY_V4_WRAPPER\nasync function autopilotAiProduct(input){\n  try {\n    return await autopilotAiProductBase(input);\n  } catch(e) {\n    if(!/description|900|too short|unvollständig/i.test(String(e?.message||''))) throw e;\n    const retry=JSON.parse(JSON.stringify(input));\n    retry.qualityRetry=true;\n    retry.qualityInstruction='QUALITÄTS-RETRY: Die erste Fassung war zu kurz oder unvollständig. Erzeuge jetzt zwingend mindestens 900 Zeichen deutsche Produktbeschreibung, 3 bis 5 Absätze und 5 bis 7 konkrete Vorteile. Keine Emojis und keine Lieferantencodes. Verwende ausschließlich belegbare Angaben aus den Produktdaten.';\n    return await autopilotAiProductBase(retry);\n  }\n}\n`;
  s = s.slice(0, insertAt) + wrapper + s.slice(insertAt);
  changes++;
  console.log('QUALITY V4 PATCH', 'AI retry wrapper');
}

// Deterministic customer-facing variant cleanup. This changes Shopify option values,
// which is the correct way to change variant labels for products with option-based variants.
if (!s.includes('HOMESTRO_VARIANT_V4')) {
  const helper = `// HOMESTRO_VARIANT_V4\nasync function autopilotNormalizeCustomerFacingVariants(product,token){\n  const colors={white:'Weiß',red:'Rot',green:'Grün',grey:'Grau',gray:'Grau',black:'Schwarz',blue:'Blau',navy:'Marineblau',pink:'Rosa',rose:'Rosa',beige:'Beige',brown:'Braun',orange:'Orange',yellow:'Gelb',purple:'Lila',violet:'Violett',silver:'Silber',gold:'Gold'};\n  const ord=n=>n===2?'zweite Variante':n===3?'dritte Variante':n===4?'vierte Variante':'Variante '+n;\n  const usedGlobal={};\n  function cleanValue(raw){\n    const value=autopilotStripEmoji(String(raw||'').trim());\n    let m=value.match(/^Style\\s*([A-Z])\\s*[-–— ]\\s*(\\d+)\\s*(?:PC|PCS)\\s*(\\d+)?$/i);\n    if(m){const base=m[2]+'er-Set – Ausführung '+m[1].toUpperCase();if(m[3])return base+' ('+ord(Number(m[3]))+')';return base;}\n    m=value.match(/^Style\\s*([A-Z])$/i);\n    if(m)return 'Ausführung '+m[1].toUpperCase();\n    m=value.match(/^(?:[A-Z]\\d{2,5})\\s*([A-Z])$/i);\n    if(m)return 'Ausführung '+m[1].toUpperCase();\n    m=value.match(/^L\\d{2,5}\\s*Set\\s*([A-Z])$/i);\n    if(m)return 'Ausführung '+m[1].toUpperCase();\n    m=value.match(/^Set\\s+([A-Z])$/i);\n    if(m)return 'Set '+m[1].toUpperCase();\n    return colors[value.toLowerCase()]||value;\n  }\n  for(const option of (product.options||[])){\n    const oldName=String(option.name||'').trim();\n    const low=oldName.toLowerCase();\n    const newName=low==='color'?'Farbe':low==='size'?'Größe':low==='style'?'Ausführung':oldName;\n    const updates=[];\n    for(const v of (option.optionValues||[])){\n      let next=cleanValue(v.name);\n      if(!next)continue;\n      if(next!==v.name){\n        const key=next.toLowerCase();\n        usedGlobal[key]=(usedGlobal[key]||0)+1;\n        if(usedGlobal[key]>1) next=next+' ('+ord(usedGlobal[key])+')';\n        updates.push({id:v.id,name:next});\n      }\n    }\n    if(!updates.length && newName===oldName)continue;\n    const q=await shopifyGraphQL('mutation($productId:ID!,$option:OptionUpdateInput!,$values:[OptionValueUpdateInput!]){productOptionUpdate(productId:$productId,option:$option,optionValuesToUpdate:$values){product{id options{id name position optionValues{id name}}}userErrors{field message}}}',{productId:product.id,option:{id:option.id,name:newName,position:option.position},values:updates},token);\n    if(q.productOptionUpdate.userErrors?.length)throw new Error('Variant normalization failed: '+q.productOptionUpdate.userErrors.map(e=>e.message).join('; '));\n  }\n}\n`;
  const insertAt = s.indexOf('async function autopilotRun');
  if (insertAt < 0) throw new Error('autopilotRun marker not found for variants');
  s = s.slice(0, insertAt) + helper + s.slice(insertAt);
  changes++;
  console.log('QUALITY V4 PATCH', 'customer-facing variants');
}

patch(
  /await autopilotNormalizeVariants\(product,token\);/,
  'await autopilotNormalizeVariants(product,token); await autopilotNormalizeCustomerFacingVariants(product,token);',
  'invoke-variant-normalizer'
);

// Route the processing call through the quality-aware AI wrapper.
patch(
  /const ai=await autopilotAiProduct\(input\);/,
  'const ai=await autopilotAiProduct(input); ai.product.title=autopilotStripEmoji(ai.product.title||input.title); ai.product.description=autopilotEnsureHtml(ai.product.description||\"\"); ai.product.seoTitle=autopilotStripEmoji(ai.product.seoTitle||ai.product.title); ai.product.seoDescription=autopilotStripEmoji(ai.product.seoDescription||autopilotPlainText(ai.product.description)); ai.product.tags=[...new Set((ai.product.tags||[]).map(autopilotStripEmoji).filter(Boolean))];',
  'sanitize-ai-output'
);

// Final verification must reject short descriptions, emoji and supplier-style variant labels.
patch(
  /const checked=verify\.find\(p=>p\.id===product\.id\);if\(!checked\|\|autopilotNeedsQualityRepair\(checked\)\)throw new Error\('Post-update quality verification failed'\);/,
  "const checked=verify.find(p=>p.id===product.id);const checkedDesc=autopilotPlainText(checked?.descriptionHtml||'');const checkedTitle=String(checked?.title||'');const checkedSeoTitle=String(checked?.seo?.title||'');const checkedSeoDesc=String(checked?.seo?.description||'');const badVariant=(checked?.options||[]).some(o=>(o.optionValues||[]).some(v=>/Style\\s*[A-Z]|(?:^|\\s)(?:G\\d+|L\\d{2,5})\\s*[A-Z]$|\\d+\\s*PCS?|China-Mainland/i.test(String(v.name||''))));if(!checked||String(checked.status||'')!=='DRAFT'||checkedDesc.length<900||autopilotStripEmoji(checkedTitle)!==checkedTitle||autopilotStripEmoji(checkedSeoTitle)!==checkedSeoTitle||autopilotStripEmoji(checkedSeoDesc)!==checkedSeoDesc||badVariant||autopilotNeedsQualityRepair(checked))throw new Error('Post-update quality verification failed');",
  'hard-post-verification'
);

fs.writeFileSync(path,s,'utf8');
console.log('QUALITY GATE V4 DONE',{changes});

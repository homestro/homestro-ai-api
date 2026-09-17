const fs = require('fs');
const path = 'server.js';
let s = fs.readFileSync(path, 'utf8');
let changes = 0;

function patch(re, replacement, label) {
  if (!re.test(s)) {
    console.warn('QUALITY PATCH NOT FOUND', label);
    return false;
  }
  s = s.replace(re, replacement);
  changes++;
  console.log('QUALITY PATCH', label);
  return true;
}

// Visible titles must never contain emoji, including on products already processed once.
patch(
  /title:String\\(x\\.title\\|\\|product\\.title\\)\\.slice\\(0,255\\)/,
  'title:autopilotStripEmoji(x.title||product.title).slice(0,255)',
  'emoji-free-title'
);

// Short AI descriptions are never acceptable for a processed product.
patch(
  /autopilotPlainText\\(product\\.description\\)\\.length<500/g,
  'autopilotPlainText(product.description).length<900',
  'min-description-900'
);
patch(/desc\.length<500/g, 'desc.length<900', 'ai-description-900');
patch(
  /Zielumfang der Beschreibung: etwa 180 bis 260 Wörter\\./,
  'Zielumfang der Beschreibung: etwa 220 bis 320 Wörter.',
  'long-description-prompt'
);

const marker = '// HOMESTRO_QUALITY_GATE_V3';
const qualitySection = `${marker}\nfunction autopilotGermanVariantValue(value){\n  const map={white:'Weiß',red:'Rot',green:'Grün',grey:'Grau',gray:'Grau',black:'Schwarz',blue:'Blau',navy:'Marineblau',pink:'Rosa',rose:'Rosa',beige:'Beige',brown:'Braun',orange:'Orange',yellow:'Gelb',purple:'Lila',violet:'Violett',silver:'Silber',gold:'Gold'};\n  const raw=autopilotStripEmoji(String(value||'').trim());\n  return map[raw.toLowerCase()]||raw;\n}\nasync function autopilotNormalizeGermanOptions(product,token){\n  for(const option of (product.options||[])){\n    const oldName=String(option.name||'').trim();\n    const lower=oldName.toLowerCase();\n    const newName=lower==='color'?'Farbe':lower==='size'?'Größe':(lower==='style'||lower==='ausführung'?'Ausführung':oldName);\n    const updates=[];\n    for(const v of (option.optionValues||[])){\n      const next=autopilotGermanVariantValue(v.name);\n      if(next && next!==v.name) updates.push({id:v.id,name:next});\n    }\n    if(!updates.length && newName===oldName) continue;\n    const optionInput={id:option.id,name:newName,position:option.position};\n    const q=await shopifyGraphQL('mutation($productId:ID!,$option:OptionUpdateInput!,$values:[OptionValueUpdateInput!]){productOptionUpdate(productId:$productId,option:$option,optionValuesToUpdate:$values){product{id options{id name position optionValues{id name}} variants(first:100){nodes{id title selectedOptions{name value}}}}userErrors{field message}}}',{productId:product.id,option:optionInput,values:updates},token);\n    if(q.productOptionUpdate.userErrors?.length) throw new Error('Shopify German option update: '+q.productOptionUpdate.userErrors.map(e=>e.message).join('; '));\n  }\n}\nasync function autopilotSecondPassDescription(input){\n  const retry=JSON.parse(JSON.stringify(input));\n  retry.qualityRetry=true;\n  retry.qualityInstruction='Die erste Fassung war zu kurz. Schreibe die sichtbare deutsche Produktbeschreibung jetzt neu mit mindestens 900 Zeichen Fließtext, 4 bis 6 konkreten Vorteilen und nur belegbaren Angaben. Keine Emojis.';\n  return autopilotAiProductBase(retry);\n}\nasync function autopilotAiProduct(input){\n  const first=await autopilotAiProductBase(input);\n  if(autopilotPlainText(first.product?.description||'').length>=900) return first;\n  console.warn('AUTOPILOT QUALITY RETRY description too short');\n  const second=await autopilotSecondPassDescription(input);\n  if(autopilotPlainText(second.product?.description||'').length<900) throw new Error('AI description too short after quality retry');\n  return second;\n}\n`;

// Patch or install the quality section on every container start. This is intentional:
// Railway redeploys start from a fresh image, while patch-autopilot rewrites server.js at runtime.
if (s.includes(marker)) {
  const sectionRe = new RegExp('\\/\\/ HOMESTRO_QUALITY_GATE_V3[\\s\\S]*?(?=async function autopilotNormalizeVariants)');
  if (sectionRe.test(s)) {
    s = s.replace(sectionRe, qualitySection);
    changes++;
    console.log('QUALITY PATCH', 'refresh-quality-section');
  }
} else {
  // The base function must exist exactly once before installing the wrapper.
  if (s.includes('async function autopilotAiProduct(input){')) {
    s = s.replace('async function autopilotAiProduct(input){', 'async function autopilotAiProductBase(input){', 1);
    changes++;
    console.log('QUALITY PATCH', 'rename-ai-base');
    const insertAt = s.indexOf('async function autopilotNormalizeVariants');
    if (insertAt >= 0) {
      s = s.slice(0, insertAt) + qualitySection + s.slice(insertAt);
      changes++;
      console.log('QUALITY PATCH', 'install-quality-section');
    } else {
      console.warn('QUALITY PATCH NOT FOUND', 'autopilotNormalizeVariants');
    }
  } else {
    console.warn('QUALITY PATCH NOT FOUND', 'autopilotAiProduct');
  }
}

// The existing supplier-style cleanup runs first; the German pass then translates common English option values.
patch(
  /await autopilotNormalizeVariants\\(product,token\\);/,
  'await autopilotNormalizeVariants(product,token); await autopilotNormalizeGermanOptions(product,token);',
  'german-variant-normalization'
);

// Only mark a product processed after a fresh read confirms the hard quality criteria.
patch(
  /const checked=verify\.find\\(p=>p\.id===product\.id\\);if\\(!checked\\|\\|autopilotNeedsQualityRepair\\(checked\\)\\)throw new Error\\('Post-update quality verification failed'\\);/,
  "const checked=verify.find(p=>p.id===product.id);const checkedDesc=autopilotPlainText(checked?.descriptionHtml||'');const checkedTitle=String(checked?.title||'');const checkedSeoTitle=String(checked?.seo?.title||'');const checkedSeoDesc=String(checked?.seo?.description||'');if(!checked||checkedDesc.length<900||autopilotStripEmoji(checkedTitle)!==checkedTitle||autopilotStripEmoji(checkedSeoTitle)!==checkedSeoTitle||autopilotStripEmoji(checkedSeoDesc)!==checkedSeoDesc||autopilotNeedsQualityRepair(checked))throw new Error('Post-update quality verification failed');",
  'hard-post-update-quality-verification'
);

fs.writeFileSync(path, s, 'utf8');
console.log('QUALITY GATE V3 DONE', {changes});

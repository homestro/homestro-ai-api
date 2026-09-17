const fs = require('fs');
const path = 'server.js';
let s = fs.readFileSync(path, 'utf8');

if (s.includes('HOMESTRO_CATALOG_GUARD_V4')) {
  console.log('CATALOG GUARD V4 already installed');
  process.exit(0);
}

let changes = 0;
function replaceOnce(re, replacement, label) {
  if (re.test(s)) {
    s = s.replace(re, replacement);
    changes++;
    console.log('CATALOG V4 PATCH', label);
    return true;
  }
  console.warn('CATALOG V4 PATCH NOT FOUND', label);
  return false;
}

// Hard safety guard: the catalog autopilot may NEVER modify ACTIVE or ARCHIVED products.
replaceOnce(
  /const token=await getClientToken\(\),products=await autopilotListProducts\(token\);/,
  "const token=await getClientToken(),productsAll=await autopilotListProducts(token),products=productsAll.filter(p=>String(p?.status||'')==='DRAFT'); console.log('CATALOG V4 hard-filter DRAFT-only',productsAll.length,'->',products.length);",
  'draft-only-product-filter'
);

// Defense in depth inside the processing loop.
replaceOnce(
  /for\(const product of candidates\.slice\(0,autopilotMaxPerCycle\(\)\)\)\{try\{/,
  "for(const product of candidates.slice(0,autopilotMaxPerCycle())){if(String(product?.status||'')!=='DRAFT'){console.warn('CATALOG V4 SKIP NON-DRAFT',product?.id,product?.status);continue;}try{",
  'non-draft-loop-guard'
);

// Deterministic emoji cleanup and a hard 900-character description gate on the existing selector.
replaceOnce(
  /desc\.length<500/g,
  'desc.length<900',
  'description-gate-900'
);
replaceOnce(
  /autopilotPlainText\(product\.description\)\.length<500/g,
  'autopilotPlainText(product.description).length<900',
  'description-repair-gate-900'
);
replaceOnce(
  /Zielumfang der Beschreibung: etwa 180 bis 260 Wörter\./,
  'Zielumfang der Beschreibung: etwa 220 bis 320 Wörter.',
  'long-description-prompt'
);

// A dedicated AI pass with a retry makes the 900-character requirement an actual pre-write gate.
const marker = '// HOMESTRO_CATALOG_GUARD_V4';
const helper = `\n${marker}\nasync function autopilotQualityAi(input){\n  if(!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY is not configured.'),{status:503});\n  const model=process.env.OPENAI_MODEL||'gpt-5-mini';\n  const call=async(extra)=>{\n    const system='Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Erstelle professionelle, verkaufsstarke, ehrliche Produktdaten ausschließlich auf Deutsch. KEINE Emojis und keine Symbol-Emoticons in sichtbaren Texten. Keine Lieferanten-SKU, internen Codes oder Rohbezeichnungen wie Style A-2PCS, G17 A oder China-Mainland im sichtbaren Text. Das Zeichen ™ ist erlaubt. Erfinde keine technischen Daten, Maße, Materialien, Zertifikate, Garantien, Bewertungen, Verkaufszahlen, Lieferzeiten oder andere nicht belegte Angaben. Schreibe die Produktbeschreibung als vollständiges HTML mit 3 bis 5 aussagekräftigen Absätzen und einer Aufzählung mit 5 bis 7 konkreten, belegbaren Vorteilen. Die Beschreibung muss mindestens 900 Zeichen Fließtext/HTML-Inhalt enthalten und idealerweise 1.200 bis 1.800 Zeichen lang sein. Vermeide Füllsätze und Wiederholungen. Erstelle außerdem einen natürlichen SEO-Titel, eine SEO-Beschreibung und 5 bis 10 sachliche deutsche Tags. Die Ausgabe muss ausschließlich gültiges JSON sein: {title,description,seoTitle,seoDescription,handle,tags,category}. Variantennamen werden separat normalisiert.';\n    const user='Verarbeite dieses bestehende Produkt für den deutschen Homestro-Shop. Nutze nur belegbare Angaben aus den gelieferten Daten. Entferne Emojis aus allen sichtbaren Texten. '+(extra||'')+'\\n\\n'+JSON.stringify(input,null,2);\n    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:user}]}],max_output_tokens:2600})});\n    const d=await r.json();\n    if(!r.ok) throw Object.assign(new Error(d?.error?.message||'OpenAI request failed'),{status:r.status===429?429:502,code:r.status===429?'AI_RATE_LIMITED':undefined,retryAfter:Number(r.headers?.get?.('retry-after')||0)});\n    const raw=String(d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'').trim().replace(/^\\x60\\x60\\x60(?:json)?\\s*/i,'').replace(/\\s*\\x60\\x60\\x60$/i,'').trim();\n    const out=JSON.parse(raw);\n    out.title=autopilotStripEmoji(out.title||input.title||'Produkt');\n    out.description=autopilotEnsureHtml(out.description||'');\n    out.seoTitle=autopilotStripEmoji(out.seoTitle||out.title||'').slice(0,70);\n    out.seoDescription=autopilotStripEmoji(out.seoDescription||autopilotPlainText(out.description)).slice(0,320);\n    out.handle=autopilotCleanHandle(out.handle,out.title);\n    out.tags=[...new Set((Array.isArray(out.tags)?out.tags:[]).map(autopilotStripEmoji).filter(Boolean))];\n    out.category=autopilotStripEmoji(out.category||input.productType||'');\n    if(!out.description||autopilotPlainText(out.description).length<900) throw new Error('AI description shorter than 900 characters');\n    return {model,product:out};\n  };\n  try {\n    return await call('Die Beschreibung muss lang genug für einen vollständigen Produkttext sein. Prüfe vor der Antwort selbst die Länge.');\n  } catch(e) {\n    if(e?.code==='AI_RATE_LIMITED'||e?.status===429) throw e;\n    console.warn('CATALOG V4 QUALITY RETRY',e.message);\n    return await call('QUALITÄTS-RETRY: Die vorige Fassung war zu kurz oder unvollständig. Erzeuge jetzt zwingend mindestens 900 Zeichen Beschreibung, 3 bis 5 Absätze plus 5 bis 7 Vorteile, ohne Emojis oder Lieferantencodes.');\n  }\n}\n`;
const insertAt = s.indexOf('async function autopilotRun');
if (insertAt >= 0) {
  s = s.slice(0, insertAt) + helper + s.slice(insertAt);
  changes++;
  console.log('CATALOG V4 PATCH', 'quality-ai-wrapper');
} else {
  throw new Error('autopilotRun marker not found');
}

// Use the dedicated quality AI pass before writing anything to Shopify.
replaceOnce(
  /const ai=await autopilotAiProduct\(input\);/,
  'const ai=await autopilotQualityAi(input);',
  'quality-ai-before-shopify-write'
);

// Deterministically strip emojis from the AI result before the existing update function receives it.
replaceOnce(
  /const ai=await autopilotQualityAi\(input\);/,
  'const ai=await autopilotQualityAi(input); ai.product.title=autopilotStripEmoji(ai.product.title); ai.product.description=autopilotEnsureHtml(ai.product.description); ai.product.seoTitle=autopilotStripEmoji(ai.product.seoTitle||ai.product.title); ai.product.seoDescription=autopilotStripEmoji(ai.product.seoDescription||autopilotPlainText(ai.product.description)); ai.product.tags=[...new Set((ai.product.tags||[]).map(autopilotStripEmoji).filter(Boolean))];',
  'sanitize-ai-output'
);

// Normalize common supplier-style option values into customer-facing German labels.
const variantHelper = `\nasync function autopilotNormalizeCustomerFacingOptions(product,token){\n  const colors={white:'Weiß',red:'Rot',green:'Grün',grey:'Grau',gray:'Grau',black:'Schwarz',blue:'Blau',navy:'Marineblau',pink:'Rosa',rose:'Rosa',beige:'Beige',brown:'Braun',orange:'Orange',yellow:'Gelb',purple:'Lila',violet:'Violett',silver:'Silber',gold:'Gold'};\n  const clean=(value,index)=>{\n    const raw=autopilotStripEmoji(String(value||'').trim());\n    let m=raw.match(/^Style\\s*([A-Z])\\s*[-–— ]\\s*(\\d+)\\s*(?:PC|PCS)\\s*(\\d+)?$/i);\n    if(m) return m[2]+'er-Set – Ausführung '+m[1].toUpperCase()+(m[3]?' '+autopilotOrdinal(Number(m[3])):'');\n    m=raw.match(/^Style\\s*([A-Z])$/i);\n    if(m) return 'Ausführung '+m[1].toUpperCase();\n    m=raw.match(/^(?:[A-Z]\\d{2,5}|L\\d{2,5})\\s*(?:Set\\s*)?([A-Z])$/i);\n    if(m) return 'Ausführung '+m[1].toUpperCase();\n    m=raw.match(/^L\\d{2,5}\\s*Set\\s*([A-Z])$/i);\n    if(m) return 'Set '+m[1].toUpperCase();\n    const lc=raw.toLowerCase();\n    if(colors[lc]) return colors[lc];\n    return raw;\n  };\n  for(const option of (product.options||[])){\n    const oldName=String(option.name||'').trim();\n    const lower=oldName.toLowerCase();\n    const newName=lower==='color'?'Farbe':lower==='size'?'Größe':lower==='style'?'Ausführung':oldName;\n    const updates=[];\n    for(let i=0;i<(option.optionValues||[]).length;i++){\n      const v=option.optionValues[i];\n      const next=clean(v.name,i);\n      if(next && next!==v.name) updates.push({id:v.id,name:next});\n    }\n    if(!updates.length && newName===oldName) continue;\n    const q=await shopifyGraphQL('mutation($productId:ID!,$option:OptionUpdateInput!,$values:[OptionValueUpdateInput!]){productOptionUpdate(productId:$productId,option:$option,optionValuesToUpdate:$values){product{id options{id name position optionValues{id name}}}userErrors{field message}}}',{productId:product.id,option:{id:option.id,name:newName,position:option.position},values:updates},token);\n    if(q.productOptionUpdate.userErrors?.length) throw new Error('Customer-facing option update: '+q.productOptionUpdate.userErrors.map(e=>e.message).join('; '));\n  }\n}\n`;
const optionInsert = s.indexOf('async function autopilotRun');
if(optionInsert>=0){
  s=s.slice(0,optionInsert)+variantHelper+s.slice(optionInsert);
  changes++;
}
replaceOnce(
  /await autopilotNormalizeVariants\(product,token\);/,
  'await autopilotNormalizeVariants(product,token); await autopilotNormalizeCustomerFacingOptions(product,token);',
  'customer-facing-variant-options'
);

// Final write gate: refuse to mark a product processed if it is not still a draft.
replaceOnce(
  /const checked=verify\.find\(p=>p\.id===product\.id\);/,
  "const checked=verify.find(p=>p.id===product.id);if(!checked||String(checked.status||'')!=='DRAFT')throw new Error('CATALOG V4 write guard: product is no longer DRAFT');",
  'post-write-draft-verification'
);

fs.writeFileSync(path,'utf8'?s:s,'utf8');
console.log('CATALOG GUARD V4 DONE', {changes});

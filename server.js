const {summarizeAutopilotResults}=require('./autopilot-results');
const {fulfillmentCostEvidence}=require('./fulfillment-cost-evidence');
const {supplierReferenceMetafields}=require('./supplier-reference');
const {normalizeSelectedDraftId}=require('./selected-draft');
// Railway sync: DSers-imported Shopify DRAFTs are eligible for Homestro autopilot.
const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const {getProductRules,validateProductEconomics}=require('./homestro-rules');
const {catalogCandidateRejection,externalCandidateRejection,targetSellingPrice,candidateProfitEvidence}=require('./product-hunter');
const {detectEuWarehouse}=require('./sourcing-evidence');
const {selectAmazonMatch}=require('./amazon-market');
const {aliExpressReference,aliExpressReferenceFromProduct}=require('./aliexpress-reference');
const {supplierProcessingState}=require('./supplier-processing-state');
const {collectionAssignmentRequest,optionNameUpdateRequest}=require('./shopify-draft-operations');
const {extractOpenAiResponseText}=require('./openai-response');
const {assertDraftProduct,isDraftProduct}=require('./shopify-safety');
const {registerSidekickApi}=require('./sidekick-api');
const {normalizeOptionName,normalizeVariantValue,priceForCost,categoryKey,variantMediaAssociations,qaProduct}=require('./autopilot-core');
const app=express();
const PORT=Number(process.env.PORT||8080);
app.use(cors({origin:true}));
app.use(express.json({limit:'4mb'}));
function cfg(){const domain=String(process.env.SHOPIFY_STORE_DOMAIN||'').trim().replace(/^https?:\/\//,'').replace(/\/$/,'');return{domain,token:String(process.env.SHOPIFY_ACCESS_TOKEN||'').trim(),clientId:String(process.env.SHOPIFY_CLIENT_ID||'').trim(),clientSecret:String(process.env.SHOPIFY_CLIENT_SECRET||'').trim()};}
let cached={token:'',expires:0};
async function getClientToken(){const c=cfg();if(!c.domain)throw Object.assign(new Error('Shopify is not configured.'),{status:503});if(cached.token&&Date.now()<cached.expires-60000)return cached.token;const direct=String(process.env.SHOPIFY_ACCESS_TOKEN||process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN||'').trim();if(direct)return direct;if(!c.clientId||!c.clientSecret)throw Object.assign(new Error('Shopify credentials are not configured.'),{status:503});const body=new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'client_credentials'});const r=await fetch(`https://${c.domain}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body});const text=await r.text();let d={};try{d=JSON.parse(text);}catch{throw Object.assign(new Error(`Shopify token endpoint returned HTTP ${r.status} instead of JSON (content-type: ${r.headers.get('content-type')||'unknown'}). Check Shopify app credentials/installation.`),{status:502});}if(!r.ok||!d.access_token)throw Object.assign(new Error(d.error_description||d.error||`Shopify token request failed (HTTP ${r.status})`),{status:502});cached={token:d.access_token,expires:Date.now()+Number(d.expires_in||86400)*1000};return cached.token;}
function b64(s){return Buffer.from(s,'base64url');}
function validateIdToken(token){const c=cfg();if(!token||!c.clientSecret)throw new Error('Missing Shopify ID token configuration');const p=token.split('.');if(p.length!==3)throw new Error('Invalid ID token');const[h,payload,sig]=p;const head=JSON.parse(b64(h)),body=JSON.parse(b64(payload));if(head.alg!=='HS256')throw new Error('Unsupported ID token algorithm');const expected=crypto.createHmac('sha256',c.clientSecret).update(`${h}.${payload}`).digest(),got=b64(sig);if(got.length!==expected.length||!crypto.timingSafeEqual(got,expected))throw new Error('Invalid ID token signature');const now=Math.floor(Date.now()/1000);if(body.exp<=now||(body.nbf&&body.nbf>now))throw new Error('Expired or not-yet-valid ID token');if(body.aud!==c.clientId)throw new Error('Invalid ID token audience');if(!body.dest)throw new Error('Missing ID token destination');return body;}
async function exchangeIdToken(idToken,payload){const c=cfg(),shop=new URL(payload.dest).hostname;const r=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:idToken,subject_token_type:'urn:shopify:params:oauth:token-type:id_token',requested_token_type:'urn:shopify:params:oauth:token-type:offline-access-token',expiring:'1'})});const d=await r.json();if(!r.ok||!d.access_token)throw Object.assign(new Error('Token exchange failed'),{status:r.status===400?401:502});return{token:d.access_token,shop};}
async function getRequestToken(req){const a=req.get('authorization')||'',id=a.startsWith('Bearer ')?a.slice(7):'';const payload=validateIdToken(id);return exchangeIdToken(id,payload);}
async function shopifyGraphQL(query,variables={},overrideToken){const c=cfg();if(!c.domain)throw Object.assign(new Error('Shopify is not configured.'),{status:503});const token=overrideToken||await getClientToken();const r=await fetch(`https://${c.domain}/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables})});const raw=await r.text();let d={};try{d=JSON.parse(raw);}catch(e){throw Object.assign(new Error('Shopify GraphQL returned non-JSON HTTP '+r.status+' '+raw.slice(0,180)),{status:502});}if(!r.ok||d.errors?.length)throw Object.assign(new Error(d.errors?.map(x=>x.message).join('; ')||`Shopify HTTP ${r.status}`),{status:502});return d.data;}
function apiKey(req,res,next){const k=process.env.HOMESTRO_API_KEY,a=req.get('authorization')||'';if(!k)return res.status(503).json({ok:false,error:'API key is not configured.'});if(a==='Bearer '+k)return next();return res.status(401).json({ok:false,error:'Unauthorized'});}
async function sidekick(req,res,next){try{req.sidekick=await getRequestToken(req);next();}catch(e){res.set('X-Shopify-Retry-Invalid-Session-Request','1');res.status(e.status||401).json({ok:false,error:e.message});}}
// SHOPIFY OAUTH INSTALL FLOW
const oauthStates=new Map();
function shopifyHmacValid(query){
 const c=cfg(),h=String(query.hmac||'');if(!h||!c.clientSecret)return false;
 const pairs=Object.keys(query).filter(k=>!['hmac','signature'].includes(k)).sort().map(k=>`${k}=${Array.isArray(query[k])?query[k].join(','):query[k]}`);
 const digest=crypto.createHmac('sha256',c.clientSecret).update(pairs.join('&')).digest('hex');
 return crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(h));
}
app.get('/auth/install',(req,res)=>{
 const c=cfg(),shop=String(req.query.shop||c.domain||'').trim().toLowerCase();
 if(!c.domain||!c.clientId||!c.clientSecret)return res.status(503).send('Shopify OAuth is not configured.');
 if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))return res.status(400).send('Invalid Shopify shop.');
 const state=crypto.randomBytes(24).toString('hex');oauthStates.set(state,{shop,expires:Date.now()+600000});
 const redirect=encodeURIComponent(`https://${req.get('host')}/auth/callback`);
 const scopes=encodeURIComponent('write_products,read_products');
 res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(c.clientId)}&scope=${scopes}&redirect_uri=${redirect}&state=${state}`);
});
app.get('/auth/callback',async(req,res)=>{
 try{
  const c=cfg(),shop=String(req.query.shop||'').trim().toLowerCase(),code=String(req.query.code||''),state=String(req.query.state||'');
  const st=oauthStates.get(state);oauthStates.delete(state);
  if(!st||st.expires<Date.now()||st.shop!==shop)return res.status(400).send('Invalid or expired Shopify OAuth state.');
  if(!shopifyHmacValid(req.query))return res.status(400).send('Invalid Shopify OAuth HMAC.');
  const r=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:c.clientId,client_secret:c.clientSecret,code})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.access_token)return res.status(502).send('Shopify OAuth token exchange failed.');
  cached={token:d.access_token,expires:Date.now()+Number(d.expires_in||86400)*1000};
  res.redirect('/');
 }catch(e){res.status(500).send('Shopify OAuth callback failed.');}
});

app.get('/',(_q,res)=>res.type('html').send('<!doctype html><html lang="de"><body><h1>Homestro AI Control</h1><p>Backend online</p><p>Neue Produkte bleiben DRAFT.</p></body></html>'));
app.get('/health',(_q,res)=>res.json({ok:true,service:'homestro-ai-api',timestamp:new Date().toISOString()}));
app.get('/api/status',apiKey,(_q,res)=>res.json({ok:true,service:'homestro-ai-api',shopifyConfigured:Boolean(cfg().domain),openaiConfigured:Boolean(process.env.OPENAI_API_KEY),imageValidation:'strict-vision'}));
app.get('/api/shopify/connection',apiKey,async(_q,res)=>{try{const d=await shopifyGraphQL('{shop{name myshopifyDomain}}');res.json({ok:true,connected:true,shop:d.shop});}catch(e){res.status(e.status||502).json({ok:false,connected:false,error:e.message});}});
app.get('/api/shopify/products',apiKey,async(req,res)=>{try{const first=Math.min(Math.max(Number(req.query.limit)||20,1),50),q=String(req.query.query||'').trim();const d=await shopifyGraphQL('query($first:Int!,$query:String){products(first:$first,query:$query){nodes{id title handle status vendor productType tags totalInventory priceRangeV2{minVariantPrice{amount currencyCode}maxVariantPrice{amount currencyCode}}variants(first:100){nodes{id title price sku inventoryQuantity selectedOptions{name value}image{id url altText}}}media(first:50){nodes{mediaContentType alt}}seo{title description}}pageInfo{hasNextPage endCursor}}}',{first,query:q||null});res.json({ok:true,...d.products});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
function rules(){return getProductRules(process.env);}
function validateProduct(cost,sellingPrice,ratio){return validateProductEconomics({cost,sellingPrice,ratio},process.env);}
app.post('/api/products/validate',apiKey,(req,res)=>{const cost=Number(req.body?.cost),sellingPrice=Number(req.body?.sellingPrice),ratio=Number(req.body?.ratio);if(![cost,sellingPrice,ratio].every(Number.isFinite))return res.status(400).json({ok:false,error:'cost, sellingPrice and ratio must be numbers.'});res.json({ok:true,...validateProduct(cost,sellingPrice,ratio)});});
// HOMESTRO_EBAY_PROFIT_GATE
function ebayProfitability(input){
 const sale=Number(input?.selling_price??input?.sellingPrice);
 const landed=Number(input?.landed_cost_eur??input?.landedCostEur);
 const commission=Number(process.env.EBAY_COMMISSION_RATE||0.14);
 const orderFee=Number(process.env.EBAY_ORDER_FEE_EUR||0.45);
 const feeVat=Number(process.env.EBAY_FEE_VAT_RATE||0.19);
 const maxAd=Number(process.env.EBAY_MAX_AD_RATE||0.15);
 const minProfit=Number(process.env.MIN_NET_PROFIT_EUR||10);
 const fixed=orderFee*(1+feeVat);
 const variableBase=commission*(1+feeVat);
 const ebayBase=sale*variableBase+fixed;
 const ad=sale*maxAd;
 const profit=sale-landed-ebayBase-ad;
 const denominator=1-variableBase-maxAd;
 const minSale=denominator>0?(landed+fixed+minProfit)/denominator:Infinity;
 const valid=Number.isFinite(sale)&&sale>0&&Number.isFinite(landed)&&landed>0&&Number.isFinite(profit)&&profit>=minProfit;
 return {valid,sale,landedCostEur:landed,ebayCommissionRate:commission,ebayOrderFeeEur:orderFee,ebayFeeVatRate:feeVat,maxAdRate:maxAd,minProfitEur:minProfit,ebayBaseFeeEur:ebayBase,adFeeEur:ad,estimatedProfitEur:profit,minRequiredSellingPriceEur:minSale,marginPct:sale>0?(profit/sale)*100:NaN};
}
app.post('/api/products/profitability',apiKey,(req,res)=>{
 try{const e=ebayProfitability(req.body||{});res.json({ok:true,...e});}
 catch(err){res.status(400).json({ok:false,error:err.message});}
});
function cleanJson(t){const s=String(t||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'').trim();const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<a)throw new Error('AI returned no JSON object');return JSON.parse(s.slice(a,b+1));}
function homestroStripEmoji(v){return String(v||'').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').replace(/[ \t]{2,}/g,' ').trim();}
function homestroPlain(v){return String(v||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ').trim();}
function homestroCleanHandle(v,title){const raw=String(v||title||'homestro-produkt').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'');return raw.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'homestro-produkt';}
function homestroInferCategory(title,existing=''){
 const e=String(existing||'').trim(); if(e)return e;
 const t=String(title||'').toLowerCase();
 if(/kopfhörer|ohrhörer|headphone|earbud|bluetooth|hifiman|lenovo.*xp|headset/i.test(t))return 'Elektronik';
 if(/nagel|gel-polish|gel polish|manikür|nagelfeil/i.test(t))return 'Beauty & Pflege';
 if(/hund|katze|katz|hunde|leckerchen|haustier/i.test(t))return 'Haustiere';
 if(/küche|messer|dosenöffner|onigiri|sieb|besteck|reis|abfluss/i.test(t))return 'Küche';
 if(/sport|fitness|pilates|kurzhantel|vibrationsplatte|push.?up|trainings/i.test(t))return 'Sport & Fitness';
 if(/baby|kind|pyjama|kapuzenhandtuch/i.test(t))return 'Baby & Kinder';
 if(/garten|werkzeug|fahrrad|auto|autoreinigung/i.test(t))return 'Garten & Heimwerken';
 if(/schwamm|handtuch|reiniger|reinigung|haushalt|organizer|besteck/i.test(t))return 'Haushalt & Wohnen';
 return 'Haushalt & Wohnen';
}
function homestroSanitizeProduct(p,input){const x={...(p||{})};x.title=homestroStripEmoji(x.title||input?.title||'Produkt');x.description=String(x.description||'').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').trim();x.seoTitle=homestroStripEmoji(x.seoTitle||x.title).slice(0,70);x.seoDescription=homestroStripEmoji(x.seoDescription||homestroPlain(x.description)).slice(0,320);x.handle=homestroCleanHandle(x.handle,x.title);x.category=homestroStripEmoji(x.category||input?.category||input?.productType||'');x.tags=[...new Set((Array.isArray(x.tags)?x.tags:[]).map(homestroStripEmoji).filter(Boolean))];return x;}
function homestroVariantLabel(name){
 let v=homestroStripEmoji(name);
 // Keep the legacy translations below for descriptive labels, but handle the
 // supplier placeholders centrally and deterministically first.
 if(/^(?:[A-Z]|as\s*(?:picture|shown)|default(?:\s+title)?|elbow[- ]*\d+\s*pairs?)$/i.test(v))return normalizeVariantValue(v);
 const exact={white:'Weiß',red:'Rot',green:'Grün',grey:'Grau',gray:'Grau',black:'Schwarz',blue:'Blau',navy:'Marineblau',pink:'Rosa',rose:'Rosa',beige:'Beige',brown:'Braun',orange:'Orange',yellow:'Gelb',purple:'Lila',violet:'Violett',silver:'Silber',gold:'Gold',germany:'Deutschland',poland:'Polen',france:'Frankreich','united states':'Vereinigte Staaten','mainland china':'China (Festland)',pump:'Pumpe'};
 if(exact[v.toLowerCase()])return exact[v.toLowerCase()];
 v=v.replace(/\\bChristmas Tree\\b/gi,'Weihnachtsbaum').replace(/\\bMainland China\\b/gi,'China (Festland)').replace(/\\bSky Blue\\b/gi,'Himmelblau').replace(/\\bGrey Camo\\b/gi,'Tarnmuster Grau').replace(/\\bDefault Title\\b/gi,'Standardausführung').replace(/\\bType\\s+(\\d+)\\b/gi,'Ausführung $1').replace(/\\bStyle\\s*([A-Z])\\b/gi,'Ausführung $1').replace(/\\bWiRot\\b/gi,'Weiß/Rot').replace(/\\bFiber Rubber Base\\b/gi,'Faser-Gummibasis').replace(/\\bRubber Base\\b/gi,'Gummibasis').replace(/\\bBase\\b/gi,'Basis').replace(/\\bTop\\b/gi,'Überlack').replace(/\\bVest for Men\\b/gi,'Weste für Herren').replace(/\\bVest for Women\\b/gi,'Weste für Damen').replace(/\\bAdapter PC\\b/gi,'PC-Adapter').replace(/\\bwith lights\\b/gi,'mit Beleuchtung');
 v=v.replace(/\\b(\\d+)\\s*pcs\\b/gi,'$1 Stück').replace(/\\b(\\d+)\\s*pc\\b/gi,'$1 Stück').replace(/\\bbottles?\\b/gi,'Flaschen').replace(/\\bblue\\b/gi,'Blau').replace(/\\bblule\\b/gi,'Blau').replace(/\\bwhite\\b/gi,'Weiß').replace(/\\bblack\\b/gi,'Schwarz').replace(/\\bgrey\\b/gi,'Grau').replace(/\\bgray\\b/gi,'Grau').replace(/\\bred\\b/gi,'Rot').replace(/\\bgreen\\b/gi,'Grün').replace(/\\bpink\\b/gi,'Rosa').replace(/\\bpurple\\b/gi,'Lila').replace(/\\bviolet\\b/gi,'Violett').replace(/\\byellow\\b/gi,'Gelb').replace(/\\borange\\b/gi,'Orange').replace(/\\bbrown\\b/gi,'Braun').replace(/\\bbeige\\b/gi,'Beige').replace(/\\bsilver\\b/gi,'Silber').replace(/\\bgold\\b/gi,'Gold').replace(/\\bGermany\\b/gi,'Deutschland').replace(/\\bPoland\\b/gi,'Polen').replace(/\\bfrance\\b/gi,'Frankreich').replace(/\\bUnited States\\b/gi,'Vereinigte Staaten').replace(/\\bChina Mainland\\b/gi,'China (Festland)').replace(/\\bChina\\b/gi,'China');
 v=v.replace(/(\\d+)\\s*[xX]\\s*(\\d+)/g,'$1 × $2 cm');
 let m=v.match(/^Style\\s*([A-Z])\\s*[-–— ]\\s*(\\d+)\\s*(?:PC|PCS)/i);if(m)return m[2]+'er-Set – Ausführung '+m[1].toUpperCase();
 m=v.match(/^Style\\s*([A-Z])$/i);if(m)return 'Ausführung '+m[1].toUpperCase();
 return v.trim();
}
function homestroGermanOptionName(name){
 const v=String(name||'').trim();
 const map={color:'Farbe',colors:'Farbe',colour:'Farbe',colours:'Farbe',size:'Größe',style:'Ausführung','ships from':'Versand aus','ship from':'Versand aus','emitting color':'Lichtfarbe','outer diameter':'Außendurchmesser',series:'Serie','grit':'Körnung'};
 return map[v.toLowerCase()]||normalizeOptionName(v);
}
async function homestroUpdateOptionNames(productId,options,token){
 const updates=(options||[]).map(o=>({
  id:o.id,
  name:homestroGermanOptionName(o.name),
  oldName:String(o.name||''),
  values:(o.optionValues||[]).map(v=>({id:v.id,name:homestroVariantLabel(v.name),oldName:String(v.name||'')})).filter(v=>v.id&&v.name&&v.name!==v.oldName)
 })).filter(o=>o.id&&o.name&&(o.name!==o.oldName||o.values.length));
 if(!updates.length)return {options:0,values:0};
 let changed=0,valuesChanged=0;
 for(const u of updates){
  const request=optionNameUpdateRequest(productId,u.id,u.name,u.values.map(({id,name})=>({id,name})));
  const d=await shopifyGraphQL(request.query,request.variables,token);
  const e=d.productOptionUpdate?.userErrors||[]; if(e.length)throw new Error(e.map(x=>x.message).join('; '));
  changed++;
  valuesChanged+=u.values.length;
 }
 return {options:changed,values:valuesChanged};
}
async function aiProduct(input){
 if(!process.env.OPENAI_API_KEY)throw Object.assign(new Error('OPENAI_API_KEY is not configured.'),{status:503});
 const model=process.env.OPENAI_MODEL||'gpt-5-mini';
 const system='Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Schreibe ausschließlich natürliches, professionelles Deutsch. Nutze nur belegbare Angaben aus den gelieferten Quelldaten. Keine erfundenen technischen Daten, Materialien, Maße, Zertifikate, Garantien, Lieferzeiten, Bewertungen, Verkaufszahlen oder Varianten. Keine Emojis, keine chinesischen/japanischen/koreanischen Werbetexte und keine Lieferanten-SKUs oder Rohcodes im sichtbaren Text. Die Beschreibung muss vollständiges HTML mit 3 bis 5 Absätzen plus 5 bis 7 konkreten Vorteilen enthalten und 1100 bis 1500 Zeichen reinen Text ergeben. Erstelle natürlichen SEO-Titel, SEO-Beschreibung, sauberen Handle und 5 bis 10 deutsche Tags. Ausgabe ausschließlich JSON.';
 const payload=JSON.stringify(input,null,2);
 const request=async(messages)=>{
  const attempts=[
   {max_output_tokens:8000,reasoning:{effort:'low'}},
   {max_output_tokens:12000,reasoning:{effort:'minimal'}}
  ];
  let lastError=null;
  for(let attempt=0;attempt<attempts.length;attempt++){
   const settings=attempts[attempt];
   const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:messages,text:{format:{type:'json_object'}},...settings})});
   const raw=await r.text();let d={};try{d=JSON.parse(raw);}catch{lastError=new Error('OpenAI returned non-JSON HTTP '+r.status);if(attempt+1<attempts.length)continue;throw lastError;}
   if(!r.ok){lastError=new Error(d?.error?.message||'OpenAI request failed');if(attempt+1<attempts.length&&r.status>=500)continue;throw lastError;}
   try{
    const text=extractOpenAiResponseText(d,{httpStatus:r.status});
    return cleanJson(text);
   }catch(e){
    lastError=e;
    const incomplete=String(d?.status||'')==='incomplete';
    const malformed=/JSON|no usable assistant text|no JSON object/i.test(String(e?.message||e));
    console.warn('OPENAI PRODUCT RESPONSE RETRY','attempt='+(attempt+1),'status='+String(d?.status||'unknown'),'reason='+String(d?.incomplete_details?.reason||'unknown'),'error='+String(e?.message||e));
    if(attempt+1<attempts.length&&(incomplete||malformed))continue;
    throw e;
   }
  }
  throw lastError||new Error('OpenAI product request failed');
 };
 try{
  let p=await request([{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:'Verarbeite dieses Produkt und gib NUR gültiges JSON zurück.\n'+payload}]}]);
  p=homestroSanitizeProduct(p,input);
  const currentLength=homestroPlain(p.description).length;
  if(currentLength<900){
   console.log('AI PRODUCT DESCRIPTION RETRY','currentLength='+currentLength);
   try{
    const repairSystem=system+' Überarbeite beim folgenden Reparaturauftrag das bestehende JSON. Die Beschreibung muss mindestens 1000 Zeichen reinen Text enthalten. Bewahre ausschließlich Fakten aus den ursprünglichen Quelldaten; erfinde insbesondere keine Materialien, Maße, Zertifikate, Garantien, Lieferzeiten, Bewertungen, Verkaufszahlen, Lieferantenaussagen oder nicht belegte technische Daten.';
    const repairPayload=JSON.stringify({sourceProduct:input,firstGeneratedProduct:p,currentDescriptionLength:currentLength},null,2);
    let repaired=await request([{role:'system',content:[{type:'input_text',text:repairSystem}]},{role:'user',content:[{type:'input_text',text:'Repariere und erweitere das Produkt-JSON. Gib NUR gültiges JSON zurück.\n'+repairPayload}]}]);
    repaired=homestroSanitizeProduct(repaired,input);
    const repairedLength=homestroPlain(repaired.description).length;
    if(repairedLength<900)throw new Error('retry description shorter than 900 characters (length='+repairedLength+')');
    console.log('AI PRODUCT DESCRIPTION RETRY SUCCESS','length='+repairedLength);
    return{model,product:repaired,fallback:false,retried:true};
   }catch(retryError){
    console.error('AI PRODUCT DESCRIPTION RETRY FAILED',String(retryError?.message||retryError));
    throw retryError;
   }
  }
  return{model,product:p,fallback:false};
 }catch(e){
  console.error('AI PRODUCT FALLBACK',String(e?.message||e));
  const title=homestroStripEmoji(String(input?.title||'Produkt')).trim()||'Produkt';
  const desc=String(input?.description||'').trim();
  const plain=homestroPlain(desc);
  const fallbackDesc=desc&&plain.length>=900?desc:'<p>'+homestroStripEmoji(plain||('Praktisches Produkt für den Alltag: '+title+'.'))+'</p><p>Die Produktinformationen basieren auf den aktuell verfügbaren Quelldaten. Bitte prüfen Sie vor dem Kauf die ausgewählte Variante.</p><p>Homestro stellt die verfügbaren Angaben übersichtlich für den deutschen Markt bereit.</p>';
  const p=homestroSanitizeProduct({title,description:fallbackDesc,seoTitle:title,seoDescription:homestroPlain(fallbackDesc).slice(0,320),handle:homestroCleanHandle('',title),tags:Array.isArray(input?.tags)?input.tags:[],category:String(input?.category||input?.productType||'')},input);
  return{model:'local-fallback',product:p,fallback:true,reason:String(e?.message||e)};
}
}

app.post('/api/ai/product',apiKey,async(req,res)=>{try{res.json({ok:true,...await aiProduct(req.body?.product||req.body)});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
function absoluteUrl(u,base){try{return new URL(u,base).href;}catch{return null;}}
async function aliExpressBrowserRead(url,{waitMs=3500}={}){
 try{
  const {chromium}=require('playwright');
  const {execFileSync}=require('child_process');
  let executablePath='';
  try{
   const candidates=[process.env.CHROMIUM_PATH,'/usr/bin/chromium','/usr/bin/chromium-browser','/root/.nix-profile/bin/chromium','/nix/var/nix/profiles/default/bin/chromium'].filter(Boolean);
   executablePath=candidates.find(p=>{try{return require('fs').existsSync(p);}catch{return false;}})||'';
   if(!executablePath)executablePath=execFileSync('sh',['-lc','command -v chromium || command -v chromium-browser || true'],{encoding:'utf8'}).trim();
  }catch{}
  if(executablePath)console.log('ALIEXPRESS_CHROMIUM_PATH',executablePath);
  const launchOptions={headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']};
  if(executablePath)launchOptions.executablePath=executablePath;
  const browser=await chromium.launch(launchOptions);
  try{
   const page=await browser.newPage({
    locale:'de-DE',
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport:{width:1440,height:1000},
    extraHTTPHeaders:{'Accept-Language':'de-DE,de;q=0.9,en;q=0.8'}
   });
   const response=await page.goto(String(url),{waitUntil:'domcontentloaded',timeout:30000});
   const status=Number(response?.status()||0);
   const finalUrl=page.url();
   const redirectBlocked=/(passport\.aliexpress\.com|error\.aliexpress\.com|feedback|captcha|verify)/i.test(finalUrl);
   if(redirectBlocked){
    console.log('ALIEXPRESS_BROWSER_SOFT_BLOCK','redirect='+finalUrl);
    return {html:'',text:'',url:finalUrl,status,blocked:true,reason:'redirect'};
   }
   const selectors=['h1','[data-pl="product-title"]','[class*="product-title"]','[class*="ProductTitle"]','meta[property="og:title"]','[class*="price"]','[class*="shipping"]','[class*="Ship"]'];
   await Promise.race([
    Promise.all(selectors.map(sel=>page.waitForSelector(sel,{state:'attached',timeout:9000}).catch(()=>null))),
    page.waitForLoadState('networkidle',{timeout:12000}).catch(()=>null)
   ]).catch(()=>null);
   const html=await page.content();
   const text=await page.locator('body').innerText().catch(()=> '');
   const low=(String(text)+' '+String(html).slice(0,12000)).toLowerCase();
   const soft=/(\bcaptcha\b|verify you are human|robot check|click to feedback|something went wrong|page not found|\b404\b|access denied|security verification)/i.test(low);
   const hasProductSignal=/(buy now|add to cart|ship to|ships from|\bprice\b|\beur\b|\bus\$\b|\bsku\b|product details|\bquantity\b)/i.test(String(text));
   if(soft || !hasProductSignal){
    console.log('ALIEXPRESS_BROWSER_SOFT_BLOCK','status='+status,'url='+finalUrl,'signal='+hasProductSignal);
    return {html,text:String(text).slice(0,20000),url:finalUrl,status,blocked:true,reason:soft?'content-marker':'no-product-signal'};
   }
   return {html,text:String(text).slice(0,20000),url:finalUrl,status,blocked:false,reason:'product-signal'};
  }finally{await browser.close();}
 }catch(e){console.log('ALIEXPRESS_BROWSER_ERROR',String(e?.message||e));return {html:'',text:'',url:String(url||''),status:0,blocked:true,reason:'browser-error'};}
}

async function extractAliExpressDetails(url){
 const out={image_urls:[],variants:[],options:[],page_title:'',page_text:'',euWarehouse:false,costEur:NaN,sold:0};
 try{
  const original=String(url||'').trim(); if(!original)return out;
  const idMatch=original.match(/\/item\/(\d+)\.html/i)||original.match(/\/i\/(\d+)/i);
  const id=idMatch?.[1]||'';
  const urls=[original];
  if(id) urls.push('https://www.aliexpress.com/item/'+id+'.html?gatewayAdapt=glo2deu', 'https://www.aliexpress.com/i/item/'+id+'.html', 'https://m.aliexpress.com/item/'+id+'.html');
  let html='';
  for(const u of [...new Set(urls)]){
   try{    const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36','Accept-Language':'de-DE,de;q=0.9,en;q=0.8','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'},redirect:'follow'});
    if(r.ok){const h=await r.text(); if(h.length>5000){html=h;break;}}
   }catch{}
  }
  // AliExpress may return an unusable HTML shell to a normal HTTP request.
  // When that happens, retry the same product through rendered Chromium.
  const unusable=(h)=>/404|not found|feedback|something went wrong|captcha|verify you are human|robot check|security verification|access denied/i.test(String(h||''));
  if(process.env.ALIEXPRESS_BROWSER_ENABLED!=='false' && (!html || unusable(html) || html.length<12000)){
   const browserUrls=[original];
   if(id)browserUrls.push('https://www.aliexpress.com/item/'+id+'.html?gatewayAdapt=glo2deu','https://www.aliexpress.com/item/'+id+'.html?spm=a2g0o.productlist.0.0');
   for(const bu of [...new Set(browserUrls)]){
    const b=await aliExpressBrowserRead(bu,{waitMs:6500});
    if(!b.blocked && b.html && !unusable(b.html)){
      html=b.html;
      out.page_text=String(b.text||'').slice(0,20000);
      break;
    }
    if(b.text)out.page_text=String(b.text).slice(0,20000);
   }
  }
  if(!html)return out;
  const normalized=html.replace(/\\u002F/g,'/').replace(/\\\//g,'/').replace(/\\u0026/g,'&');
  const strip=new RegExp('<script[^>]*>[\\s\\S]*?</script>','gi'),style=new RegExp('<style[^>]*>[\\s\\S]*?</style>','gi');
  out.page_text=normalized.replace(strip,' ').replace(style,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/\\s+/g,' ').slice(0,20000);
  const titleMatch=normalized.match(new RegExp('<title[^>]*>([\\s\\S]*?)</title>','i'));
  out.page_title=String(titleMatch?.[1]||'').replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim();

  const urlsFound=[],add=u=>{try{const v=String(u).replace(/\\\\u002F/g,'/').replace(/\\\\u0026/g,'&').replace(/\\\\\\//g,'/').replace(/\\\\/g,'');if(/^https?:\/\//i.test(v))urlsFound.push(v);}catch{}};
  let m; const metaRe=new RegExp("<meta[^>]+(?:property|name)=\"(?:og:image|twitter:image)\"[^>]+content=\"([^\"]+)\"[^>]*>","gi");
  while((m=metaRe.exec(normalized))&&urlsFound.length<12)add(m[1]);
  const jsonImageRe=new RegExp('"(?:image|images|imageUrl|imageURL)"\\s*:\\s*"([^"]+)"','gi');
  while((m=jsonImageRe.exec(normalized))&&urlsFound.length<40)add(m[1]);
  const imgRe=new RegExp("(?:src|data-src|data-original)=\"(https?:[^\"]+)\"","gi");
  while((m=imgRe.exec(normalized))&&urlsFound.length<60)add(m[1]);
  out.image_urls=[...new Set(urlsFound.filter(u=>!/logo|icon|avatar|sprite/i.test(u)))].slice(0,20);

  const valueMap=new Map(),optionDefs=[];
  const optRe=new RegExp('"skuPropertyName"\\s*:\\s*"([^"]+)"[\\s\\S]{0,12000}?"skuPropertyValues"\\s*:\\s*\\[([\\s\\S]*?)\\]','gi');
  while((m=optRe.exec(normalized))&&optionDefs.length<3){const name=m[1].trim(),vals=[];let vm;const vr=new RegExp('"propertyValueId"\\s*:\\s*"?([0-9]+)"?[\\s\\S]{0,500}?"propertyValueDisplayName"\\s*:\\s*"([^"]+)"','gi');while((vm=vr.exec(m[2]))&&vals.length<100){const id=vm[1],label=vm[2].trim();if(!valueMap.has(id))valueMap.set(id,{name:label,option:name});if(!vals.some(v=>v.name===label))vals.push({name:label,id});}if(vals.length)optionDefs.push({name,values:vals.map(v=>v.name)});}
  out.options=optionDefs;  const combos=[],seen=new Set(),skuRe=new RegExp('"([0-9]+(?::[0-9]+)+)"\\s*:\\s*\\{[\\s\\S]{0,2500}?"skuId"\\s*:','g');
  while((m=skuRe.exec(normalized))&&combos.length<100){const parts=m[1].split(':').map(x=>valueMap.get(x)).filter(Boolean);if(parts.length){const combo=parts.map(v=>({optionName:v.option,name:v.name}));const key=JSON.stringify(combo);if(!seen.has(key)){seen.add(key);combos.push(combo);}}}
  out.variants=combos;

  const prices=[...normalized.matchAll(/"(?:price|salePrice|discountPrice|formattedPrice|currentPrice|productPrice|minPrice|maxPrice|skuPrice|originalPrice)"\\s*:\\s*(?:"|')?([0-9]{1,3}(?:[.,][0-9]{1,2})?)/gi)].map(m=>Number(String(m[1]).replace(',','.'))).filter(n=>Number.isFinite(n)&&n>=2&&n<=100);
  const eur=[...normalized.matchAll(/(?:€|EUR)\\s*([0-9]{1,3}(?:[.,][0-9]{1,2})?)/gi),...normalized.matchAll(/([0-9]{1,3}(?:[.,][0-9]{1,2})?)\\s*(?:€|EUR)/gi)].map(m=>Number(String(m[1]).replace(',','.'))).filter(n=>Number.isFinite(n)&&n>=2&&n<=100);
  if([...prices,...eur].length)out.costEur=Math.min(...prices,...eur);
  const sold=[...normalized.matchAll(/([0-9]+(?:[.,][0-9]+)?\\s*[kKmMbB]?)\\+?\\s*(?:orders|sold|sales|units?)/gi)].map(m=>catalogNum(m[1])).filter(Number.isFinite);
  const orders=[...normalized.matchAll(/"(?:orders|orderCount|tradeCount|sold|sales)"\\s*:\\s*"?([0-9]+(?:[.,][0-9]+)?\\s*[kKmMbB]?)"?/gi)].map(m=>catalogNum(m[1])).filter(Number.isFinite);
  out.sold=Math.max(0,...sold,...orders);

  const euNames='Germany|Deutschland|Poland|Polen|Czech(?:ia| Republic)|Tschechien|France|Frankreich|Spain|Spanien|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich|EU|European Union|Europäische Union';
  const euCodes='DE|PL|CZ|ES|FR|IT|NL|BE|AT';
  const strong=[
   new RegExp('(?:ships?\\s*from|shipsFrom|shipFrom|shippingFrom|shippingCountry|warehouse(?:Location|Name)?|deliverFrom|deliveryFrom|sendFrom|originCountry|originCountryCode|fromCountry|fromCountryCode)[^]{0,900}?(?:'+euNames+'|'+euCodes+')','i'),
   new RegExp('(?:'+euNames+'|'+euCodes+')[^]{0,450}?(?:warehouse|stock|ships?\\s*from|shipsFrom|shipFrom|shippingFrom|shippingCountry|warehouseName|deliverFrom|deliveryFrom|sendFrom|originCountry|originCountryCode|fromCountry)','i'),
   /"shipFrom(?:Country|CountryName|Code)?"\\s*:\s*"?[A-Z]{2}"?/i,
   /"shipsFrom(?:Country|CountryName|Code)?"\\s*:\s*"?[A-Z]{2}"?/i,
   /"(?:shipFrom|shipsFrom|shippingFrom|shippingCountry|warehouseName|deliveryFrom|originCountry|originCountryCode|fromCountry|fromCountryCode)"\\s*:\s*"(?:Germany|Deutschland|Poland|Polen|Czechia|Czech Republic|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich|DE|PL|CZ|ES|FR|IT|NL|BE|AT)"/i,
   /(?:Ships?\\s+From|Versand\\s+aus|Versandort|Warehouse)\\s*[:：-]?\\s*(?:Germany|Deutschland|Poland|Polen|Czechia|Czech Republic|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)/i
  ];
  out.euWarehouse=strong.some(re=>re.test(normalized)) || strong.some(re=>re.test(out.page_text));
  if(!out.euWarehouse && process.env.ALIEXPRESS_BROWSER_ENABLED!=='false'){
   const b=await aliExpressBrowserRead(original,{waitMs:4500});
   const bt=String(b.text||'');
   out.page_text=(out.page_text+' '+bt).slice(0,20000);
   out.euWarehouse=/(?:Ships?\\s+From|Versand\\s+aus|Versandort|Warehouse)\\s*[:：-]?\\s*(?:Germany|Deutschland|Poland|Polen|Czechia|Czech Republic|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)/i.test(bt)
    ||/(?:EU\\s*stock|EU\\s*warehouse)/i.test(bt);
   const btTitle=bt.match(/[^\\n]{8,220}/)?.[0];
   if(btTitle&&!out.page_title)out.page_title=btTitle.trim();
  }
 }catch{}
 return out;
}
async function discoverImages(input){
 const found=await extractAliExpressDetails(String(input?.source_url||input?.sourceUrl||''));
 const supplied=[...(Array.isArray(input?.image_urls)?input.image_urls:[]),...(Array.isArray(input?.imageUrls)?input.imageUrls:[])].map(String);
 return{urls:[...new Set([...found.image_urls,...supplied])].slice(0,20),pageContext:(found.page_title+' '+found.page_text).slice(0,4000),details:found};
}
async function imageIsRelevant(url,input,pageContext){
 if(!process.env.OPENAI_API_KEY)return false;
 const model=process.env.OPENAI_VISION_MODEL||process.env.OPENAI_MODEL||'gpt-5-mini';
 const prompt='Prüfe dieses konkrete Produktbild für Homestro extrem streng. Freigabe NUR wenn exakt das Produkt aus dem Produktnamen/der Beschreibung gezeigt wird und das Bild für einen deutschen Online-Shop geeignet ist. ABLEHNEN bei anderem Produkt, Zubehör statt Hauptprodukt, Banner, Logo, Wasserzeichen, Verpackung als Hauptmotiv, chinesischen/japanischen/koreanischen Schriftzeichen, fremdsprachigem Werbetext, irreführenden Angaben, starker Unschärfe oder schlechter Qualität. Wenn du unsicher bist, ABLEHNEN. Produkt: '+String(input?.title||'')+'. Kategorie: '+String(input?.category||input?.productType||'')+'. Beschreibung: '+homestroPlain(input?.description||'').slice(0,1500)+'. Quellkontext: '+String(pageContext||'').slice(0,3000)+'. Antworte nur JSON {"relevant":true/false,"confidence":0-1,"hasForeignText":true/false,"lowQuality":true/false}.';
 try{const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:url,detail:'high'}]}],max_output_tokens:180})});const raw=await r.text();const d=JSON.parse(raw);if(!r.ok){console.error('IMAGE VISION HTTP',r.status,raw.slice(0,500));return false;}const out=cleanJson(d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'{}');return out.relevant===true&&out.hasForeignText!==true&&out.lowQuality!==true&&Number(out.confidence)>=0.85;}catch{return false;}
}

async function generateHomestroImage(input,title,pageContext){
 if(!process.env.OPENAI_API_KEY) return null;
 const model=process.env.OPENAI_IMAGE_MODEL||'gpt-image-1';
 const prompt='Create a clean, realistic premium e-commerce product photo for Homestro.de. Show ONLY the actual product described below, centered and clearly visible, suitable for a German online shop. No text anywhere in the image, no letters, no numbers, no Chinese/Japanese/Korean characters, no English, no logos, no watermark, no labels, no packaging with writing, no UI, no collage. Neutral professional studio background, natural realistic lighting, product-focused, photorealistic. Product: '+String(title||input?.title||'').slice(0,500)+'. Category: '+String(input?.category||input?.productType||'').slice(0,300)+'. Source context: '+String(pageContext||'').slice(0,2500);
 try{
  const r=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,prompt,size:'1024x1024',n:1})});
  const raw=await r.text();let d={};try{d=JSON.parse(raw);}catch{return null;}
  if(!r.ok){console.error('IMAGE GENERATION HTTP',r.status,raw.slice(0,700));return null;} if(!d.data?.[0]?.b64_json){console.error('IMAGE GENERATION NO DATA',raw.slice(0,700));return null;}
  return 'data:image/png;base64,'+d.data[0].b64_json;
 }catch(e){console.error('IMAGE GENERATION ERROR',e.message);return null;}
}
async function uploadGeneratedImageToShopify(productId,dataUrl,title,token,index){
 const b64=String(dataUrl||'').replace(/^data:image\/png;base64,/i,'');
 if(!b64)return null;
 const filename='homestro-ai-'+Date.now()+'-'+index+'.png';
 const staged=await shopifyGraphQL('mutation($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}} userErrors{field message}}}',{input:[{filename,mimeType:'image/png',httpMethod:'POST',resource:'IMAGE'}]},token);
 const se=staged.stagedUploadsCreate.userErrors||[];
 if(se.length)throw Object.assign(new Error('Shopify staged upload failed.'),{status:400,details:se});
 const target=staged.stagedUploadsCreate.stagedTargets?.[0]; if(!target?.url||!target?.resourceUrl)throw new Error('Shopify returned no staged upload target.');
 const form=new FormData();
 for(const p of (target.parameters||[]))form.append(p.name,p.value);
 form.append('file',new Blob([Buffer.from(b64,'base64')],{type:'image/png'}),filename);
 const up=await fetch(target.url,{method:'POST',body:form}); if(!up.ok)throw new Error('Generated image upload failed (HTTP '+up.status+').');
 const mediaCreate=await shopifyGraphQL('mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{... on MediaImage{id image{url} alt} mediaContentType status}mediaUserErrors{field message}}}',{productId,media:[{mediaContentType:'IMAGE',originalSource:target.resourceUrl,alt:String(title||'Homestro Produkt')}]},token);
 const me=mediaCreate.productCreateMedia?.mediaUserErrors||[];
 if(me.length)throw Object.assign(new Error('Shopify product image creation failed.'),{status:400,details:me});
 const mediaId=mediaCreate.productCreateMedia?.media?.[0]?.id; if(!mediaId)throw new Error('Shopify did not return generated product image ID.');
 for(let i=0;i<10;i++){
  const q=await shopifyGraphQL('query($id:ID!){node(id:$id){... on MediaImage{id image{url}}}}',{id:mediaId},token);
  const url=q.node?.image?.url; if(url)return url;
  await new Promise(r=>setTimeout(r,1000));
 }
 return null;
}
async function addMedia(productId,input,title,token){
 const found=await discoverImages({...input,title});
 const candidates=found.urls.slice(0,20),accepted=[];
 for(const url of candidates){if(accepted.length>=7)break;if(await imageIsRelevant(url,{...input,title},found.pageContext||''))accepted.push(url);}
 // If source images contain foreign text, logos, watermarks or are otherwise unsuitable,
 // replace the missing visuals with freshly generated, text-free Homestro images.
 let generatedCount=0;
 for(let i=0;accepted.length<5&&i<4;i++){
  const dataUrl=await generateHomestroImage({...input,title},title,found.pageContext||'');
  if(!dataUrl)break;
  if(!(await imageIsRelevant(dataUrl,{...input,title},found.pageContext||'')))continue;
  const uploadedUrl=await uploadGeneratedImageToShopify(productId,dataUrl,title,token,i+1);
  if(uploadedUrl){accepted.push(uploadedUrl);generatedCount++;}
 }
 if(!accepted.length)throw Object.assign(new Error('No product image passed strict AI validation and no generated replacement was available.'),{status:400});
 const media=accepted.map(url=>({mediaContentType:'IMAGE',originalSource:url,alt:String(title||'Homestro Produkt')}));
 const d=await shopifyGraphQL('mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{mediaContentType status}mediaUserErrors{field message}}}',{productId,media},token);
 const errs=d.productCreateMedia.mediaUserErrors||[];if(errs.length)throw Object.assign(new Error('Shopify rejected product images.'),{status:400,details:errs});
 return{count:(d.productCreateMedia.media||[]).length,urls:accepted,rejected:Math.max(0,candidates.length-(accepted.length-generatedCount)),generated:generatedCount,validation:'strict-ai-vision-no-foreign-text'};
}
async function setSeo(productId,seo,token){if(!seo?.title&&!seo?.description)return null;const input={id:productId,seo:{title:String(seo.title||'').slice(0,70),description:String(seo.description||'').slice(0,320)}};const d=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id seo{title description}}userErrors{field message}}}',{input},token);if(d.productUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected SEO data.'),{status:400,details:d.productUpdate.userErrors});return d.productUpdate.product;}async function setProductTags(productId,tags,token){const arr=Array.isArray(tags)?tags.map(String).filter(Boolean):[];if(!arr.length)return null;const d=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id tags}userErrors{field message}}}',{input:{id:productId,tags:arr}},token);if(d.productUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected product tags.'),{status:400,details:d.productUpdate.userErrors});return d.productUpdate.product;}
async function setVariantPricing(productId,price,cost,token){if(!Number.isFinite(price)&&!Number.isFinite(cost))return null;const q='{product(id:"'+productId.replace(/"/g,'\\"')+'"){variants(first:1){nodes{id}}}}';const d0=await shopifyGraphQL(q,{},token),id=d0.product?.variants?.nodes?.[0]?.id;if(!id)return null;const variant={id};if(Number.isFinite(price))variant.price=String(price);if(Number.isFinite(cost))variant.inventoryItem={cost:Number(cost)};const d=await shopifyGraphQL('mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){product{id variants(first:1){nodes{id price inventoryItem{unitCost{amount currencyCode}}}}}userErrors{field message}}}',{productId,variants:[variant]},token);if(d.productVariantsBulkUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected price/cost.'),{status:400,details:d.productVariantsBulkUpdate.userErrors});return d.productVariantsBulkUpdate.product;}
function homestroTargetSellingPrice(cost,currentPrice,title){
 const current=Number(currentPrice)||0, landed=Number(cost);
 if(!Number.isFinite(landed)||landed<=0||!Number.isFinite(current)||current<=0)return current;
 const t=String(title||'').toLowerCase();
 const isHeadphone=/(earphone|earbuds?|headphone|headset|kopfhörer|ohrhörer|bluetooth)/i.test(t);
 const r=rules();
 const base=r.minSellingPrice;

 const target=priceForCost(landed,current,{minSellingPrice:base,minNetProfit:r.minNetProfit,commissionRate:Number(process.env.EBAY_COMMISSION_RATE||0.14),feeVatRate:Number(process.env.EBAY_FEE_VAT_RATE||0.19),adRate:Number(process.env.EBAY_MAX_AD_RATE||0.15),orderFee:Number(process.env.EBAY_ORDER_FEE_EUR||0.45)});
 return target??current;
}
async function homestroAutoPriceVariants(productId,variants,title,token,costEvidence={}){
 const source=Array.isArray(variants)?variants:[];
 const updates=[],planned=[];
 for(const v of source){
  const price=Number(v.price||0),cost=Number(costEvidence[v.id]??v.inventoryItem?.unitCost?.amount??NaN);
  if(!v.id||!Number.isFinite(price)||price<=0||!Number.isFinite(cost)||cost<=0)continue;
  const target=homestroTargetSellingPrice(cost,price,title);
  planned.push({id:v.id,currentPrice:price,cost,target});
  if(target>price+0.001)updates.push({id:v.id,price:target.toFixed(2)});
 }
 if(updates.length){
  const d=await shopifyGraphQL('mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){product{id variants(first:100){nodes{id price}}}userErrors{field message}}}',{productId,variants:updates},token);
  const errs=d.productVariantsBulkUpdate?.userErrors||[];
  if(errs.length)throw Object.assign(new Error('Shopify rejected automatic DRAFT pricing.'),{status:400,details:errs});
 }
 return {changed:updates.length,planned};
}
async function createDraft(input,token){
 if(!input?.title)throw Object.assign(new Error('Product title is required.'),{status:400});
 const cost=Number(input.cost),price=Number(input.selling_price??input.sellingPrice),landedCostEur=Number(input.landed_cost_eur??input.landedCostEur),ratio=cost>0&&Number.isFinite(price)?price/cost:NaN;
 if(!Number.isFinite(landedCostEur)||landedCostEur<=0)throw Object.assign(new Error('Product blocked: real landed cost in EUR is required before publication.'),{status:400,details:{required:'landed_cost_eur',message:'Use supplier/product cost + shipping + VAT/service charges converted to EUR; do not use product price alone.'}});
 const economics=ebayProfitability({selling_price:price,landed_cost_eur:landedCostEur});
 if(!economics.valid)throw Object.assign(new Error('Product blocked by eBay profitability gate.'),{status:400,details:economics});
 if(Number.isFinite(cost)&&Number.isFinite(price)){const v=validateProduct(cost,price,ratio);if(!v.valid)throw Object.assign(new Error('Product fails Homestro rules.'),{status:400,details:v.rules});}
 const found=await discoverImages(input),details=found.details||{};
 if(!String(input.source_url||'').trim())throw Object.assign(new Error('Source URL is required.'),{status:400});
 if(!String(input.source_product_id||'').trim())throw Object.assign(new Error('Source product ID is required.'),{status:400});
 if(!Number.isFinite(cost)||cost<=0||!Number.isFinite(price)||price<=0)throw Object.assign(new Error('Valid cost and selling price are required.'),{status:400});
 if(!found.urls.length)throw Object.assign(new Error('No source images found; product was not created.'),{status:400});
 const opts=(Array.isArray(input.options)&&input.options.length?input.options:(details.options||[])).slice(0,3).map(o=>({name:homestroStripEmoji(String(o.name||'').toLowerCase()==='color'?'Farbe':String(o.name||'').toLowerCase()==='size'?'Größe':String(o.name||'').toLowerCase()==='style'?'Ausführung':String(o.name||'')),values:[...new Set((Array.isArray(o.values)?o.values:[]).map(homestroVariantLabel).filter(Boolean))]}));
 const variantsRaw=Array.isArray(input.variants)&&input.variants.length?input.variants:(details.variants||[]);
 const baseHandle=String(input.handle||'homestro-produkt').replace(/[^a-zA-Z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'homestro-produkt'; const sourceId=String(input.source_product_id||input.sourceProductId||'produkt').replace(/[^a-zA-Z0-9-]/g,'-').slice(0,24); const uniqueHandle=baseHandle+'-'+sourceId+'-'+Date.now().toString(36);
 const product={
  title:String(input.title).trim(),
  descriptionHtml:String(input.descriptionHtml||input.description||'').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').trim(),
  handle:uniqueHandle,
  vendor:input.vendor?String(input.vendor).trim():'Homestro',
  productType:String(input.productType||input.category||'').trim()||undefined,
  status:'DRAFT',
  tags:Array.isArray(input.tags)?input.tags.map(homestroStripEmoji).filter(Boolean):[],
  seo:{title:homestroStripEmoji(String(input.seoTitle||'')).slice(0,70)||undefined,description:homestroStripEmoji(String(input.seoDescription||'')).slice(0,320)||undefined},
  productOptions:opts.slice(0,3).map((o,i)=>({name:String(o.name),position:i+1,values:(Array.isArray(o.values)?o.values:[]).slice(0,100).map(v=>({name:String(v)}))})),
  variants:variantsRaw.length?variantsRaw.slice(0,100).map((ovs,i)=>({optionValues:ovs,price:Number.isFinite(price)?String(price):undefined,inventoryItem:{cost:Number.isFinite(landedCostEur)?String(landedCostEur):undefined,sku:String(input.source_product_id||input.sourceProductId||'AE')+'-'+(i+1)}})):undefined,
  metafields:[{namespace:'homestro',key:'aliexpress_url',type:'single_line_text_field',value:String(input.source_url||'')},{namespace:'homestro',key:'aliexpress_product_id',type:'single_line_text_field',value:String(input.source_product_id||'')}]
 };
 if(!product.variants)delete product.variants;
 if(!product.seo.title&&!product.seo.description)delete product.seo;
 if(!product.productOptions.length)delete product.productOptions;
 if(!product.files)delete product.files;
 const d=await shopifyGraphQL('mutation($input:ProductSetInput!){productSet(input:$input,synchronous:true){product{id title handle status vendor productType tags seo{title description}options{name position optionValues{name}}variants(first:100){nodes{id title price sku selectedOptions{name value}image{id url altText}inventoryItem{unitCost{amount currencyCode}}}}media(first:20){nodes{mediaContentType status alt}}}userErrors{field message}}}',{input:product},token);
 const errs=d.productSet.userErrors||[];if(errs.length)throw Object.assign(new Error('Shopify rejected the product: '+errs.map(e=>e.message).join('; ')),{status:400,details:errs});
 const p=d.productSet.product;
 let media={count:0,urls:[],rejected:0,validation:'source-images'};
 media=await addMedia(p.id,input,p.title,token);
 return{...p,mediaCount:media.count,variantCount:(p.variants?.nodes||[]).length,options:p.options||[],sourceImageCount:found.urls.length,euWarehouse:Boolean(details.euWarehouse),mediaValidation:media.validation,economics};
}

app.post('/api/shopify/products/draft',apiKey,async(req,res)=>{try{res.status(201).json({ok:true,product:await createDraft(req.body?.product||req.body),status:'DRAFT'});}catch(e){res.status(e.status||502).json({ok:false,error:e.message,userErrors:e.details});}});
async function updateVariants(productId,variants,token){const safety=await shopifyGraphQL('query($id:ID!){product(id:$id){id status}}',{id:productId},token);assertDraftProduct(safety.product);const normalized=(Array.isArray(variants)?variants:[]).map(v=>({id:String(v.id||''),optionValues:(v.optionValues||[]).map(o=>({optionName:String(o.optionName||''),name:String(o.name||'')}))})).filter(v=>v.id&&v.optionValues.length&&v.optionValues.every(o=>o.optionName&&o.name));if(!productId||!normalized.length)throw Object.assign(new Error('productId and valid variants are required.'),{status:400});const d=await shopifyGraphQL('mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){product{id title options{id name optionValues{id name}}variants(first:100){nodes{id title selectedOptions{name value}image{id url altText}}}}userErrors{field message}}}',{productId,variants:normalized},token);if(d.productVariantsBulkUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected the variant update.'),{status:400,details:d.productVariantsBulkUpdate.userErrors});return d.productVariantsBulkUpdate.product;}
app.post('/api/shopify/products/variants',apiKey,async(req,res)=>{try{res.json({ok:true,product:await updateVariants(String(req.body.productId||''),req.body.variants,await getClientToken())});}catch(e){res.status(e.status||502).json({ok:false,error:e.message,userErrors:e.details});}});

// HOMESTRO_CATALOG_AUTOPILOT_V3
const catalogState={running:false,lastRun:null,lastError:null,created:0,rejected:0,failed:0,seen:new Set(),candidates:[]};
const catalogKeywords=['EU Stock kitchen tool','EU Stock kitchen gadget','EU Stock chef knife','EU Stock cleaning tool','EU Stock home cleaning','EU Stock travel accessory','EU Stock garden tools','EU Stock headphones','EU Stock bluetooth headphones','EU Stock earbuds','Poland Warehouse kitchen knife','Poland Warehouse kitchen tool','France Warehouse kitchen knife','Germany Warehouse kitchen tool','EU Warehouse cleaning tool','EU Warehouse garden tool','EU Stock wireless headphones','EU Stock noise cancelling headphones'];
function catalogInterval(){const n=Number(process.env.HOMESTRO_CATALOG_INTERVAL_MS||300000);return Number.isFinite(n)&&n>=300000?n:300000;}
function catalogNum(v){
 const raw=String(v??'').trim().replace(/\s+/g,'');
 if(!raw)return NaN;
 const suffix=(raw.match(/([kmb])\+?$/i)||[])[1]?.toLowerCase()||'';
 let s=raw.replace(/[kmb]\+?$/i,'').replace(/[^0-9.,-]/g,'');
 if(!s)return NaN;
 let x=s;
 if(s.includes(',')&&s.includes('.')) x=s.lastIndexOf(',')>s.lastIndexOf('.')?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');
 else if(s.includes(',')&&/,[0-9]{3}$/.test(s)) x=s.replace(/,/g,'');
 else x=s.replace(',','.');
 let n=Number(x); if(!Number.isFinite(n))return NaN; if(suffix==='k')n*=1000; else if(suffix==='m')n*=1000000; else if(suffix==='b')n*=1000000000;
 return Number.isFinite(n)?n:NaN;
}

async function homestroCJSearch(keyword){
  const token=String(process.env.CJ_API_KEY||'').trim();
  if(!token){ console.log('CJ_SOURCE_DISABLED','reason=no-CJ_API_KEY'); return []; }
  const endpoint=String(process.env.CJ_API_ENDPOINT||'https://developers.cjdropshipping.com/api2.0/v1/product/query').trim();
  const pageSize=Math.min(Math.max(Number(process.env.CJ_API_PAGE_SIZE||50),1),100);
  const pageNum=Math.max(Number(process.env.CJ_API_PAGE||1),1);
  const requestBody={keyWord:String(keyword||'').trim(),countryCode:String(process.env.CJ_COUNTRY_CODE||'DE').trim(),pageSize,pageNum,verifiedWarehouse:1};
  try{
    const r=await fetch(endpoint,{method:'POST',headers:{'CJ-Access-Token':token,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(requestBody)});
    const raw=await r.text(); let d={}; try{d=JSON.parse(raw);}catch{throw new Error('CJ API returned non-JSON HTTP '+r.status);}
    if(!r.ok)throw new Error('CJ API HTTP '+r.status+' '+String(d.message||d.msg||''));
    if(d?.code&&Number(d.code)!==200)throw new Error('CJ API code '+d.code+': '+String(d.message||d.msg||'unknown error'));
    const root=d?.data||d?.result||d;
    const list=root?.list||root?.records||root?.productList||root?.products||root?.content||[];
    const arr=Array.isArray(list)?list:(list?[list]:[]);
    const eu=new Set(['DE','GERMANY','DEUTSCHLAND','PL','POLAND','POLEN','CZ','CZECH','CZECHIA','CZECH REPUBLIC','ES','SPAIN','SPANIEN','FR','FRANCE','FRANKREICH','IT','ITALY','ITALIEN','NL','NETHERLANDS','NIEDERLANDE','BE','BELGIUM','BELGIEN','AT','AUSTRIA','ÖSTERREICH']);
    const euNorm=v=>{const x=String(v??'').trim().toUpperCase();return Boolean(x&&(eu.has(x)||[...eu].some(c=>x.includes(c))));};
    const firstString=(o,keys)=>{for(const k of keys){const v=o?.[k];if(v!==undefined&&v!==null&&String(v).trim())return String(v).trim();}return '';};
    const firstNumber=(o,keys)=>{for(const k of keys){const n=catalogNum(o?.[k]);if(Number.isFinite(n))return n;}return NaN;};
    const out=[];
    for(const p of arr){
      const id=firstString(p,['id','productId','product_id','pid','sku']);
      const url=firstString(p,['productUrl','product_url','url','productDetailUrl','product_detail_url','detailUrl']);
      if(!id||!url)continue;
      const title=firstString(p,['nameEn','name','productName','product_name','title'])||String(keyword||'').trim();
      const cost=firstNumber(p,['sellPrice','sell_price','salePrice','sale_price','price','discountPrice']);
      const sold=firstNumber(p,['sales','sold','orders','orderCount','ordersCount','saleNum','salesCount']);
      const direct=firstString(p,['warehouseCountry','warehouse_country','shipFromCountry','ship_from_country','countryCode','country','warehouse']);
      const warehouseValues=[direct,
        ...(Array.isArray(p.warehouseList)?p.warehouseList:[]).flatMap(x=>[x?.countryCode,x?.country,x?.warehouseCountry,x?.warehouseName]),
        ...(Array.isArray(p.warehouses)?p.warehouses:[]).flatMap(x=>[x?.countryCode,x?.country,x?.warehouseCountry,x?.warehouseName]),
        ...(Array.isArray(p.variants)?p.variants:[]).flatMap(x=>[x?.warehouseCountry,x?.warehouse_country,x?.shipFromCountry,x?.ship_from_country,x?.countryCode,x?.country])
      ].filter(Boolean);
      const euWarehouse=warehouseValues.some(euNorm);
      const warehouse=warehouseValues.find(euNorm)||direct;
      out.push({id:String(id),title,cost,sold:Number.isFinite(sold)?sold:0,source_url:url,euWarehouse,warehouse:String(warehouse||''),source_type:'cj-api',
        context:JSON.stringify({countryCode:requestBody.countryCode,warehouse:String(warehouse||''),verifiedWarehouse:1}),
        evidence:euWarehouse?'CJ Dropshipping API: explicit EU warehouse evidence '+String(warehouse):'CJ Dropshipping API: no explicit EU warehouse evidence'});
    }
    console.log('CJ_SOURCE',keyword,'items='+out.length,'euConfirmed='+out.filter(x=>x.euWarehouse===true).length);
    if(arr[0])console.log('CJ_SAMPLE_KEYS',JSON.stringify(Object.keys(arr[0]).slice(0,120)));
    return out;
  }catch(e){console.error('CJ_SOURCE_FAILED',keyword,String(e?.message||e));return [];}
}

async function homestroAffiliateApiSearch(keyword){
  const appKey=String(process.env.ALIEXPRESS_APP_KEY||'').trim();
  const appSecret=String(process.env.ALIEXPRESS_APP_SECRET||'').trim();
  if(!appKey||!appSecret)return [];
  const endpoint=String(process.env.ALIEXPRESS_API_ENDPOINT||'https://api-sg.aliexpress.com/sync').trim();
  const pageSize=Math.min(Math.max(Number(process.env.ALIEXPRESS_API_PAGE_SIZE||50),1),50);
  const timestamp=new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
  const baseParams={
    method:'aliexpress.affiliate.product.query',
    app_key:appKey,
    timestamp,
    sign_method:'sha256',
    format:'json',
    v:'2.0',
    keywords:String(keyword||''),
    ship_to_country:String(process.env.ALIEXPRESS_SHIP_TO_COUNTRY||'DE'),
    target_currency:'EUR',
    target_language:'DE',
    page_size:String(pageSize),
    page_no:'1',
    fields:'product_id,product_title,sale_price,original_price,discount,product_detail_url,first_level_category_name,second_level_category_name,commission_rate,lastest_volume,ship_from_country,delivery_time'
  };
  const signBase=Object.keys(baseParams).sort().map(k=>k+String(baseParams[k])).join('');
  const sign=crypto.createHmac('sha256',appSecret).update('aliexpress.affiliate.product.query'+signBase).digest('hex').toUpperCase();
  const params=new URLSearchParams({...baseParams,sign});
  try{
    const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:params});
    const text=await r.text();
    if(!r.ok)throw new Error('AliExpress API HTTP '+r.status);
    const d=JSON.parse(text);
    const root=d?.aliexpress_affiliate_product_query_response?.resp_result?.result
      ||d?.aliexpress_affiliate_product_query_response?.result
      ||d?.resp_result?.result
      ||d?.result      ||d;
    const list=root?.products?.product||root?.products||root?.product||[];
    const arr=Array.isArray(list)?list:(list?[list]:[]);
    const eu=new Set(['DE','GERMANY','DEUTSCHLAND','PL','POLAND','POLEN','CZ','CZECH','CZECHIA','CZECH REPUBLIC','TSchechien'.toUpperCase(),'ES','SPAIN','SPANIEN','FR','FRANCE','FRANKREICH','IT','ITALY','ITALIEN','NL','NETHERLANDS','NIEDERLANDE','BE','BELGIUM','BELGIEN','AT','AUSTRIA','ÖSTERREICH']);
    const out=[];
    for(const p of arr){
      const ship=String(p.ship_from_country||p.shipFromCountry||p.ship_from||p.warehouse_country||p.warehouseCountry||'').trim();
      const shipNorm=ship.toUpperCase();
      const euWarehouse=eu.has(shipNorm)||[...eu].some(c=>shipNorm.includes(c));
      const id=String(p.product_id||p.productId||'').replace(/[^0-9]/g,'');
      const url=String(p.product_detail_url||p.productDetailUrl||'').trim() || (id?'https://www.aliexpress.com/item/'+id+'.html':'');
      const cost=Number(String(p.sale_price||p.salePrice||p.app_sale_price||'').replace(',','.'));
      const sold=catalogNum(p.lastest_volume||p.latest_volume||p.orders||p.order_count||p.sales||0);
      if(id&&url)out.push({
        id,title:String(p.product_title||p.productTitle||keyword).trim(),cost,sold:Number.isFinite(sold)?sold:0,
        source_url:url,euWarehouse,source_type:'aliexpress-affiliate-api',
        context:JSON.stringify({ship_from_country:ship,delivery_time:p.delivery_time||'',sale_price:p.sale_price||''}),
        evidence:'AliExpress Affiliate API: ship_from_country='+ship
      });
    }
    console.log('ALIEXPRESS_API_SOURCE',keyword,'items='+out.length,'euConfirmed='+out.filter(x=>x.euWarehouse).length);
    return out;
  }catch(e){
    console.error('ALIEXPRESS_API_SOURCE_FAILED',keyword,String(e?.message||e));
    return [];
  }
}

async function homestroFeedSearch(keyword){
  const feed=String(process.env.HOMESTRO_SOURCE_FEED_URL||'').trim();
  if(!feed)return [];
  try{
    const r=await fetch(feed,{headers:{'Accept':'application/json,text/csv;q=0.9,*/*;q=0.8'},redirect:'follow'});
    if(!r.ok)throw new Error('feed HTTP '+r.status);
    const text=await r.text();
    let rows=[];
    if(/^\s*[\[{]/.test(text)){
      const d=JSON.parse(text);
      rows=Array.isArray(d)?d:(Array.isArray(d.products)?d.products:Array.isArray(d.items)?d.items:[]);
    }else{
      const lines=text.split(/\r?\n/).filter(Boolean),head=(lines.shift()||'').split(',').map(x=>x.replace(/^"|"$/g,'').trim());
      rows=lines.map(line=>{const vals=[];let cur='',q=false;for(const ch of line){if(ch==='"')q=!q;else if(ch===','&&!q){vals.push(cur);cur='';}else cur+=ch;}vals.push(cur);return Object.fromEntries(head.map((h,i)=>[h,vals[i]||'']));});
    }
    const eu=new Set(['DE','GERMANY','DEUTSCHLAND','PL','POLAND','POLEN','CZ','CZECH','CZECHIA','CZECH REPUBLIC','ES','SPAIN','SPANIEN','FR','FRANCE','FRANKREICH','IT','ITALY','ITALIEN','NL','NETHERLANDS','NIEDERLANDE','BE','BELGIUM','BELGIEN','AT','AUSTRIA','ÖSTERREICH']);
    const kw=String(keyword||'').toLowerCase();
    return rows.filter(p=>!p.keyword||String(p.keyword).toLowerCase().includes(kw)||kw.includes(String(p.keyword).toLowerCase())).map(p=>{
      const id=String(p.id||p.product_id||p.productId||'').replace(/[^0-9]/g,'');
      const url=String(p.url||p.product_url||p.productUrl||p.product_detail_url||'').trim()||(id?'https://www.aliexpress.com/item/'+id+'.html':'');
      const ship=String(p.ship_from_country||p.shipFromCountry||p.warehouse_country||p.warehouseCountry||'').trim();
      return {id,title:String(p.title||p.product_title||keyword),cost:Number(String(p.cost_eur||p.cost||p.sale_price||'').replace(',','.')),sold:catalogNum(p.sold||p.orders||p.sales||0),source_url:url,euWarehouse:Boolean(p.eu_warehouse)||[...eu].some(c=>ship.toUpperCase().includes(c)),source_type:'homestro-feed',context:JSON.stringify(p),evidence:'Configured sourcing feed'};    }).filter(x=>x.id&&x.source_url);
  }catch(e){console.error('HOMESTRO_SOURCE_FEED_FAILED',String(e?.message||e));return [];}
}



/* HOMESTRO_MULTI_SOURCE_V1
 * Source adapters are deliberately credential/config driven.
 * Apify is used as a sourcing/market-intelligence execution layer; no CAPTCHA,
 * stealth, proxy evasion, or anti-bot bypass is performed.
 */
const HOMESTRO_EU_COUNTRIES=new Set(['DE','GERMANY','DEUTSCHLAND','PL','POLAND','POLEN','CZ','CZECH','CZECHIA','CZECH REPUBLIC','ES','SPAIN','SPANIEN','FR','FRANCE','FRANKREICH','IT','ITALY','ITALIEN','NL','NETHERLANDS','NIEDERLANDE','BE','BELGIUM','BELGIEN','AT','AUSTRIA','ÖSTERREICH']);
function homestroEuWarehouseValue(v){
 const s=String(v??'').trim().toUpperCase();
 if(!s)return false;
 return [...HOMESTRO_EU_COUNTRIES].some(c=>s===c||s.includes(c));
}
function homestroSourcePrice(v){
 const n=Number(String(v??'').replace(',','.').replace(/[^\d.-]/g,''));
 return Number.isFinite(n)?n:NaN;
}
function homestroSourceSold(v){const n=catalogNum(v);return Number.isFinite(n)?n:0;}

async function apifyRunActor(actorId,input,{timeoutMs=90000}={}){
 const token=String(process.env.APIFY_API_TOKEN||'').trim();
 if(!token||!actorId)return [];
 const id=String(actorId).trim();
 try{
  const start=await fetch('https://api.apify.com/v2/acts/'+encodeURIComponent(id)+'/runs?token='+encodeURIComponent(token),{
   method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(input||{})
  });
  const sd=await start.json().catch(()=>({}));
  if(!start.ok||!sd?.data?.id)throw new Error('Apify actor start HTTP '+start.status);
  const runId=sd.data.id,datasetId=sd.data.defaultDatasetId;
  const deadline=Date.now()+timeoutMs;
  let status='';
  while(Date.now()<deadline){
   const rr=await fetch('https://api.apify.com/v2/actor-runs/'+encodeURIComponent(runId)+'?token='+encodeURIComponent(token),{headers:{'Accept':'application/json'}});
   const rd=await rr.json().catch(()=>({}));
   status=String(rd?.data?.status||'');
   if(['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(status))break;
   await new Promise(r=>setTimeout(r,2500));
  }
  if(status!=='SUCCEEDED')throw new Error('Apify actor run '+status);
  if(!datasetId)return [];
  const dr=await fetch('https://api.apify.com/v2/datasets/'+encodeURIComponent(datasetId)+'/items?token='+encodeURIComponent(token)+'&format=json',{headers:{'Accept':'application/json'}});
  if(!dr.ok)throw new Error('Apify dataset HTTP '+dr.status);
  const data=await dr.json().catch(()=>[]);
  return Array.isArray(data)?data:[];
 }catch(e){
  console.error('HOMESTRO_APIFY_FAILED',id,String(e?.message||e));
  return [];
 }
}

function homestroNormalizeExternalItem(p,sourceType,keyword){
 const id=String(p?.productId??p?.itemId??p?.product_id??p?.id??p?.asin??p?.sku??'').trim();
 const url=String(p?.url??p?.productUrl??p?.product_url??p?.detailUrl??p?.detail_url??'').trim();
 const title=String(p?.title??p?.detailTitle??p?.name??p?.productTitle??p?.product_title??keyword??'').trim();
 const cost=homestroSourcePrice(p?.price??p?.costEur??p?.cost_eur??p?.cost??p?.wholesalePrice??p?.wholesale_price??p?.salePrice);
 const sold=homestroSourceSold(p?.soldCount??p?.sold??p?.orders??p?.sales??p?.unitsSold??p?.ordersCount??p?.bsrSales??p?.soldText??p?.soldText);
 const availability=String(p?.availabilityNote??'').trim();
 const warehouseProof=detectEuWarehouse(p);
 const eu=sourceType!=='amazon-fba'&&warehouseProof.confirmed;
 const warehouse=warehouseProof.country;
 return {id:id||('ext-'+crypto.createHash('sha1').update(sourceType+'|'+title+'|'+url).digest('hex').slice(0,16)),title,cost,sold,url,source_url:url,costEur:cost,euWarehouse:eu,warehouse,availability,source_type:sourceType,source_role:sourceType==='amazon-fba'?'market_reference':'supplier',context:JSON.stringify(p).slice(0,12000),evidence:eu?'Apify '+warehouseProof.evidence[0].path+' confirms '+warehouse:'no explicit ship-from/warehouse country evidence'};
}
async function homestroApifySourceSearch(keyword){
 const token=String(process.env.APIFY_API_TOKEN||'').trim();
 if(!token)return [];
 const out=[];
 const jobs=[
  ['APIFY_ALIEXPRESS_ACTOR_ID','aliexpress-apify'],
  ['APIFY_CJ_ACTOR_ID','cj-dropshipping'],
  ['APIFY_BIGBUY_ACTOR_ID','bigbuy']
 ];
 for(const [envName,sourceType] of jobs){
  const actor=String(process.env[envName]||(sourceType==='amazon-fba'?'memo23~amazon-search':'')).trim();
  if(!actor)continue;
  let input={
   keywords:[keyword],
   maxResults:Number(process.env.APIFY_SOURCE_MAX_ITEMS||25),
   includeProductDetails:true,
   country:'DE',
   currency:'EUR'
  };
  if(sourceType!=='aliexpress-apify'){
   input={
    searchQueries:[keyword],queries:[keyword],keyword,searchKeyword:keyword,
    startUrls:[{url:'https://www.aliexpress.com/w/wholesale-'+encodeURIComponent(keyword).replace(/%20/g,'-')+'.html'}],
    countryCode:'DE',locale:'de-DE',maxItems:Number(process.env.APIFY_SOURCE_MAX_ITEMS||25),
    maxResults:Number(process.env.APIFY_SOURCE_MAX_ITEMS||25),shipToCountry:'DE',
    warehouses:['DE','PL','CZ','ES','FR','IT','NL','BE','AT'],includeShipping:true,
    scrapeFullProductDetails:true,includeCustomerReviews:false,maxReviewsPerProduct:0,
    proxyConfiguration:{useApifyProxy:true,apifyProxyGroups:['RESIDENTIAL']}
   };
  }
  if(sourceType==='amazon-fba')Object.assign(input,{domain:'amazon.de',marketplace:'DE',primeOnly:true,fulfillment:'FBA'});
  if(sourceType==='cj-dropshipping')Object.assign(input,{warehouse:['DE','PL','ES']});
  if(sourceType==='bigbuy')Object.assign(input,{stockMin:50});
  const rows=await apifyRunActor(actor,input);
  if(sourceType==='aliexpress-apify' && rows[0]) console.log('HOMESTRO_APIFY_SAMPLE_KEYS',JSON.stringify(Object.keys(rows[0]).slice(0,120)));
  for(const p of rows){
   const x=homestroNormalizeExternalItem(p,sourceType,keyword);
   if(x.title&&x.url)out.push(x);
  }
 } if(out.length)console.log('HOMESTRO_APIFY_SOURCES',keyword,'items='+out.length,'euConfirmed='+out.filter(x=>x.euWarehouse).length);
 return out;
}

async function homestroAmazonCheck(candidate){
 if(!String(process.env.APIFY_API_TOKEN||'').trim())return {checked:false,reason:'amazon-not-configured'};
 const actor=String(process.env.APIFY_AMAZON_ACTOR_ID||'memo23~amazon-search').trim();
 const rows=await apifyRunActor(actor,{search:String(candidate.title),searchQueries:[String(candidate.title)],country:'DE',domain:'amazon.de',maxItems:Number(process.env.APIFY_AMAZON_MAX_ITEMS||10)});
 const match=selectAmazonMatch(candidate,rows,homestroSourcePrice);
 if(!match)return {checked:true,matched:false,reason:'amazon-product-match-not-confirmed'};
 const required=targetSellingPrice(candidate.costEur,Boolean(candidate.isHeadphone),rules());
 return {checked:true,matched:true,priceEur:match.priceEur,confidence:match.confidence,url:String(match.offer?.url||match.offer?.productUrl||''),requiredSellingPriceEur:required,reject:match.priceEur<required?'amazon-market-too-cheap':''};
}

async function homestroMarketCheck(title){
 const actor=String(process.env.APIFY_GOOGLE_SHOPPING_ACTOR_ID||'').trim();
 const token=String(process.env.APIFY_API_TOKEN||'').trim();
 if(!actor||!token)return {checked:false,lowestPriceEur:NaN,offers:[],source:'not-configured'};
 const rows=await apifyRunActor(actor,{
  searchQueries:[String(title||'')],
  queries:[String(title||'')],
  countryCode:String(process.env.HOMESTRO_MARKET_COUNTRY||'DE'),
  languageCode:'de',
  maxItems:Number(process.env.APIFY_MARKET_MAX_ITEMS||10)
 });
 const offers=[];
 for(const p of rows){
  const price=homestroSourcePrice(p?.priceEur??p?.price_eur??p?.price??p?.currentPrice??p?.productPrice);
  if(Number.isFinite(price)&&price>0)offers.push({priceEur:price,store:String(p?.merchant||p?.store||p?.seller||'').trim(),url:String(p?.url||p?.productUrl||'').trim()});
 }
 offers.sort((a,b)=>a.priceEur-b.priceEur);
 return {checked:true,lowestPriceEur:offers[0]?.priceEur??NaN,offers:offers.slice(0,10),source:'apify-google-shopping'};
}

async function homestroCompetitivePrice(candidate){
 const market=await homestroMarketCheck(candidate.title);
 if(!market.checked||!Number.isFinite(market.lowestPriceEur)||market.lowestPriceEur<=0)return {...candidate,marketChecked:false};
 const price=Number(candidate.sellingPriceEur||0);
 const floor=market.lowestPriceEur;
 const maxOver=Math.max(0,Number(process.env.HOMESTRO_MAX_MARKET_OVERPRICE||0.15));
 const adjusted=Math.min(price,Math.round(floor*100)/100);
 return {...candidate,marketChecked:true,marketLowestPriceEur:floor,marketOffers:market.offers,marketSource:market.source,
   marketStatus:price<=floor?'AT_OR_BELOW_MARKET':(price>floor*(1+maxOver)?'UNCOMPETITIVE_PRICE':'WITHIN_MARKET_BAND'),
   recommendedSellingPriceEur:price<=floor?price:adjusted};
}

function homestroExternalCandidatePass(x){
 return externalCandidateRejection(x,rules());
}

async function catalogSearch(keyword){
  const out=[],ids=new Set();
  const sourceMode=String(process.env.HOMESTRO_CATALOG_SOURCE||'apify').trim().toLowerCase();
  const externalItems=sourceMode==='cj'?await homestroCJSearch(keyword):await homestroApifySourceSearch(keyword);
  for(const x of externalItems){if(x?.id&&!ids.has(String(x.id))){ids.add(String(x.id));out.push(x);}}
  if(externalItems.length)console.log('CATALOG EXTERNAL SOURCE MERGED',keyword,'items='+externalItems.length);
  const apiItems=await homestroAffiliateApiSearch(keyword);
  for(const x of apiItems){if(x?.id&&!ids.has(String(x.id))){ids.add(String(x.id));out.push(x);}}
  const feedItems=await homestroFeedSearch(keyword);
  for(const x of feedItems){if(x?.id&&!ids.has(String(x.id))){ids.add(String(x.id));out.push(x);}}
  // HARD SAFETY: Apify/API/feed are now the only catalog discovery sources.
  // Never fall back to direct AliExpress browser/search-engine scraping here.
  if(out.length){
    console.log('CATALOG PRIMARY SOURCES ONLY',keyword,'items='+out.length,'euConfirmed='+out.filter(x=>x.euWarehouse===true).length);
    return out.slice(0,200);
  }
  console.log('CATALOG PRIMARY SOURCES EMPTY',keyword,'no-browser-fallback=true');
  return [];

}
function catalogPassReason(x){return catalogCandidateRejection(x,rules(),ebayProfitability);}
function catalogPass(x){return !catalogPassReason(x);}

function isDsersImportedCandidate(product){
 if(!isDraftProduct(product))return false;
 const tags=(Array.isArray(product?.tags)?product.tags:[]).map(String);
 // DSers-imported products arrive in Shopify as DRAFT. Do not require a special DSers tag.
 // ACTIVE products are excluded by the status check above.
 if(tags.includes('homestro-ai-rejected'))return false;
 if(tags.includes('homestro-ai-complete'))return false;
 return true;
}



async function repairExistingDraftImages(productId,product,token){
 const mediaNodes=(product?.media?.nodes||[]).filter(m=>String(m.mediaContentType||'')==='IMAGE'&&m.image?.url);
 const input={title:String(product?.title||''),category:String(product?.productType||''),description:String(product?.description||'')};
 const keep=[],remove=[];
 for(const m of mediaNodes){
   const ok=await imageIsRelevant(m.image.url,input,'');
   if(ok) keep.push(m);
   else remove.push(m);
 }
 let generated=0;
 const target=Math.max(3,Math.min(5,mediaNodes.length||3));
 for(let i=0;keep.length<target&&i<5;i++){
   const dataUrl=await generateHomestroImage(input,input.title,'');
   if(!dataUrl) break;
   const uploaded=await uploadGeneratedImageToShopify(productId,dataUrl,input.title,token,i+1);
   if(uploaded){
     keep.push({id:null,image:{url:uploaded}});
     generated++;
   }
 }
 if(remove.length){
   const ids=remove.map(m=>m.id).filter(Boolean);
   if(ids.length && keep.length>=3){
     const del=await shopifyGraphQL('mutation($productId:ID!,$mediaIds:[ID!]!){productDeleteMedia(productId:$productId,mediaIds:$mediaIds){deletedMediaIds mediaUserErrors{field message}}}',{productId,mediaIds:ids},token);
     const errs=del.productDeleteMedia?.mediaUserErrors||[];
     if(errs.length) throw Object.assign(new Error('Shopify could not remove rejected product images.'),{status:400,details:errs});
   } else if(ids.length) console.log('DRAFT IMAGE KEEP EXISTING SAFETY','rejected='+ids.length,'verified='+keep.length,'generated='+generated);
 }
 if(!keep.length && !generated) throw new Error('No verified product image remains and no replacement could be generated.');
 return {checked:mediaNodes.length,kept:keep.length-generated,removed:remove.length,generated,validation:'strict-ai-vision'};
}

function configuredCollectionId(product){
 let map={};
 try{map=JSON.parse(process.env.HOMESTRO_COLLECTION_MAP_JSON||'{}');}catch{console.error('Invalid HOMESTRO_COLLECTION_MAP_JSON');}
 return String(map[categoryKey([product?.title,product?.productType,product?.description].join(' '))]||'').trim();
}
async function assignDraftCollection(product,token){
 const collectionId=configuredCollectionId(product);
 if(!collectionId)return {assigned:false,pending:true,reason:'collection-map-not-configured'};
 const check=await shopifyGraphQL('query($id:ID!){product(id:$id){id status collections(first:50){nodes{id}}}}',{id:product.id},token);
 assertDraftProduct(check.product);
 if((check.product.collections?.nodes||[]).some(c=>c.id===collectionId))return {assigned:true,id:collectionId,existing:true};
 const request=collectionAssignmentRequest(collectionId,product.id);
 const d=await shopifyGraphQL(request.query,request.variables,token);
 const errors=d.collectionAddProducts?.userErrors||[];if(errors.length)throw new Error('Collection assignment failed: '+errors.map(e=>e.message).join('; '));
 return {assigned:true,id:collectionId};
}

async function optionalDraftOperation(operation,productId,work,fallback){
 try{return {ok:true,value:await work()};}
 catch(e){
  const message=String(e?.message||e);
  console.error('EXISTING_DRAFT_OPTIONAL_PENDING',productId,'operation='+operation,'error='+message);
  return {ok:false,value:fallback,pending:true,reason:operation+'-failed',error:message};
 }
}
async function associateDraftVariantImages(product,token){
 const assignments=variantMediaAssociations(product.variants?.nodes||[],product.media?.nodes||[]);
 if(!assignments.length)return {changed:0,pending:(product.variants?.nodes||[]).filter(v=>!v.image).length};
 const safety=await shopifyGraphQL('query($id:ID!){product(id:$id){status}}',{id:product.id},token);assertDraftProduct(safety.product);
 const d=await shopifyGraphQL('mutation($productId:ID!,$variantMedia:[ProductVariantAppendMediaInput!]!){productVariantAppendMedia(productId:$productId,variantMedia:$variantMedia){product{id} userErrors{field message}}}',{productId:product.id,variantMedia:assignments},token);
 const errors=d.productVariantAppendMedia?.userErrors||[];if(errors.length)throw new Error('Variant image assignment failed: '+errors.map(e=>e.message).join('; '));
 return {changed:assignments.length,pending:Math.max(0,(product.variants?.nodes||[]).filter(v=>!v.image).length-assignments.length)};
}

async function processExistingDraftProduct(productId,token){ const d=await shopifyGraphQL('query($id:ID!){product(id:$id){id title description vendor productType tags status seo{title description} options{id name optionValues{id name}} collections(first:50){nodes{id title handle}} variants(first:100){nodes{id title price sku selectedOptions{name value} image{id url altText width height} inventoryItem{unitCost{amount currencyCode}} metafields(first:20){nodes{namespace key value}}}} metafields(first:100){nodes{namespace key value}} media(first:30){nodes{id mediaContentType status alt ... on MediaImage { image { url width height } }}}}}',{id:productId},token);
 const p=d.product;if(!p)throw new Error('Product not found');assertDraftProduct(p);
 const existingTags=(Array.isArray(p.tags)?p.tags:[]).map(String);
 if(existingTags.includes('homestro-ai-rejected'))return {id:productId,title:p.title,processed:false,skipped:true,reason:'rejected'};
 const alreadyProcessed=existingTags.includes('homestro-ai-processed-existing');
 // Pending/failed products must be repaired on later runs; the old one-shot tag
 // made transient OpenAI and supplier failures permanent.
 const contentNeedsWork=!alreadyProcessed||existingTags.some(t=>/pending|failed/.test(t));
 const mf=Object.fromEntries((p.metafields?.nodes||[]).filter(x=>x.namespace==='homestro').map(x=>[x.key,String(x.value||'')]));
 const desc=String(p.description||'');
 const reference=aliExpressReferenceFromProduct(p,mf);
 const src=reference.url;
 const id=reference.productId;
 const supplierState=supplierProcessingState(reference);
 if(!supplierState.available)console.log('EXISTING_DRAFT_SUPPLIER_PENDING',productId,'reason='+supplierState.reason,'safe-processing=continue','pendingChecks='+supplierState.pendingChecks.join(','));
 // A missing supplier reference blocks evidence-dependent work, not safe content,
 // SEO, category, option, or variant normalization.
 // Persist source BEFORE pricing/content/image operations can replace the imported description.
 const sourceFields=supplierReferenceMetafields(p,mf,reference);
 if(sourceFields.length){
  const saved=await shopifyGraphQL('mutation($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){userErrors{field message}}}',{metafields:sourceFields},token);
  if(saved.metafieldsSet?.userErrors?.length)throw new Error(saved.metafieldsSet.userErrors.map(e=>e.message).join('; '));
 }

 const landedEvidence=supplierState.available
  ?fulfillmentCostEvidence(mf.fulfillment_cost_evidence,p.variants?.nodes||[],src)
  :{verified:false,landedByVariant:{},reason:'verified-supplier-reference-missing'};
 let details={page_title:'',page_text:'',image_urls:[],variants:[],options:[],euWarehouse:false};
 const hasImages=(p.media?.nodes||[]).some(m=>String(m.mediaContentType||'')==='IMAGE'&&m.image?.url);
 const imageNeedsSource=existingTags.includes('homestro-ai-image-pending')||!hasImages;
 if(src&&id&&(contentNeedsWork||imageNeedsSource)){
  try{
   details=await extractAliExpressDetails(src);
  }catch(e){
   console.log('EXISTING_DRAFT_SOURCE_FALLBACK',productId,String(e?.message||e));
   details={page_title:'',page_text:'',image_urls:[],variants:[],options:[],euWarehouse:false};
  }
 }
 let price=Number(p.variants?.nodes?.[0]?.price||0);
 let cost=Number(p.variants?.nodes?.[0]?.inventoryItem?.unitCost?.amount||NaN);
 let pricing={changed:0,planned:[]};
 if(supplierState.available&&landedEvidence.verified&&(p.variants?.nodes||[]).length){
  pricing=await homestroAutoPriceVariants(productId,p.variants.nodes,p.title,token,landedEvidence.landedByVariant);
  if(pricing.changed){
   const refreshed=await shopifyGraphQL('query($id:ID!){product(id:$id){variants(first:100){nodes{id title price sku selectedOptions{name value} inventoryItem{unitCost{amount currencyCode}}}}}}',{id:productId},token);
   p.variants.nodes=refreshed.product?.variants?.nodes||p.variants.nodes;
   price=Number(p.variants?.nodes?.[0]?.price||0);
   cost=Number(p.variants?.nodes?.[0]?.inventoryItem?.unitCost?.amount||NaN);
  }
 }
 const supplierCost=supplierState.available&&Number.isFinite(cost)&&cost>0?cost:null;
 if(landedEvidence.verified)cost=landedEvidence.landedByVariant[p.variants?.nodes?.[0]?.id]??cost;
 const ratio=cost>0&&price>0?price/cost:NaN;
 const variantEconomics=(p.variants?.nodes||[]).map(v=>{
  const vp=Number(v.price||0),vc=Number(landedEvidence.landedByVariant[v.id]??v.inventoryItem?.unitCost?.amount??NaN);
  return {id:v.id,price:vp,cost:vc,economics:ebayProfitability({selling_price:vp,landed_cost_eur:vc})};
 });
 const profitability=ebayProfitability({selling_price:price,landed_cost_eur:cost});
 const supplierContributionPending=variantEconomics.length===0||variantEconomics.some(v=>!Number.isFinite(v.cost)||v.cost<=0||!v.economics.valid);
 const profitPending=!landedEvidence.verified||supplierContributionPending;
 let x=null;
 const aiInput={
  title:details.page_title||p.title,
  description:(details.page_text||desc||'').slice(0,7000),
  category:p.productType,
  source_url:src||'',
  source_product_id:id||'',
  variants:details.variants||[],
  options:details.options||[],
  image_urls:details.image_urls||[],
  cost:supplierState.available&&Number.isFinite(cost)&&cost>0?cost:null,selling_price:price
 };
 if(contentNeedsWork){
  try{
   if(process.env.OPENAI_API_KEY){
    const ai=await aiProduct(aiInput);
    x=homestroSanitizeProduct(ai.product||{}, {title:p.title,category:p.productType});
   }
  }catch(e){
   console.error('EXISTING_DRAFT_AI_FALLBACK',productId,String(e?.message||e));
  }
 }
 // instead of repeatedly marking an already-imported DSers product as failed.
 if(!x){
  if(alreadyProcessed){
   x=homestroSanitizeProduct({
    title:p.title,
    description:desc,
    seoTitle:p.seo?.title||p.title,
    seoDescription:p.seo?.description||homestroPlain(desc).slice(0,320),
    handle:homestroCleanHandle('',p.title),
    tags:existingTags,
    category:p.productType
   },{title:p.title,category:p.productType});
  }else{
  const fallbackTitle=homestroStripEmoji(String(p.title||details.page_title||'Produkt')).trim();
  const category=homestroInferCategory(fallbackTitle,p.productType);
  const sourcePlain=homestroPlain(details.page_text||desc||'');
  const existingPlain=homestroPlain(desc);
  const base=sourcePlain||existingPlain||'';
  const safeText=base.replace(/(?:aliexpress|ali express|seller|supplier|shopify|sku|shipping|ships from|buy now|add to cart)/gi,' ').replace(/\\s+/g,' ').trim();
  const variantText=(p.variants?.nodes||[]).map(v=>(v.selectedOptions||[]).map(o=>homestroGermanOptionName(o.name)+': '+homestroVariantLabel(o.value)).join(' – ')).filter(Boolean).slice(0,8);
  const paragraphs=[];
  if(safeText)paragraphs.push('<p>'+homestroStripEmoji(safeText).slice(0,1800)+'</p>');
  paragraphs.push('<p>'+homestroStripEmoji(fallbackTitle)+' ist für den vorgesehenen Einsatzbereich übersichtlich aufbereitet. Die Angaben basieren ausschließlich auf den verfügbaren Produktdaten.</p>');
  if(variantText.length)paragraphs.push('<p><strong>Varianten:</strong> '+homestroStripEmoji(variantText.join('; '))+'.</p>');
  paragraphs.push('<p>Bitte wählen Sie vor dem Kauf die gewünschte Variante und prüfen Sie die dazugehörigen Angaben.</p>');
  const fallbackDescription=paragraphs.join('');
  const seoTitle=(fallbackTitle+(category?' | '+category:'')).slice(0,70);
  const seoDescription=homestroPlain(fallbackDescription).slice(0,320);
  const derivedTags=[category,...fallbackTitle.split(/[^A-Za-zÄÖÜäöüß0-9]+/).filter(w=>w.length>=4).slice(0,6)].map(homestroStripEmoji);
  x=homestroSanitizeProduct({
   title:fallbackTitle,
   description:fallbackDescription,
   seoTitle,
   seoDescription,
   handle:homestroCleanHandle('',fallbackTitle),
   tags:[...new Set([...((Array.isArray(p.tags)?p.tags:[])),...derivedTags])],
   category
  },{title:fallbackTitle,category});
  }
 }
 if(!x.title)throw new Error('Product has no usable title');
 const baseTags=Array.isArray(x.tags)?x.tags:[];
 const oldTags=Array.isArray(p.tags)?p.tags:[];
 const tags=[...new Set([...oldTags.filter(t=>!['homestro-ai-failed-existing','homestro-ai-complete','homestro-ai-images-checked','homestro-ai-image-pending','homestro-ai-rejected','⚠️-chybi-foto','⚠️-nizka-cena'].includes(String(t))),...baseTags,'homestro-ai-processed-existing',...(profitPending?['homestro-profit-pending']:['homestro-profit-checked'])])];
 const category=homestroInferCategory(x.title||p.title,x.category||p.productType);
 const input={id:productId,title:String(x.title),descriptionHtml:String(x.description||p.description),productType:category,tags,seo:{title:String(x.seoTitle||x.title).slice(0,70),description:String(x.seoDescription||'').slice(0,320)}};
 if(src&&id){input.metafields=[{namespace:'homestro',key:'aliexpress_url',type:'single_line_text_field',value:src},{namespace:'homestro',key:'aliexpress_product_id',type:'single_line_text_field',value:id}];}
 let upd={productUpdate:{userErrors:[]}};
 if(contentNeedsWork){
  upd=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id title description productType seo{title description} tags}userErrors{field message}}}',{input},token);
  if(upd.productUpdate.userErrors?.length)throw new Error(upd.productUpdate.userErrors.map(e=>e.message).join('; '));
 }
 // productOptionUpdate renames the option values in place, and Shopify carries
 // those value IDs through to existing variants without recreating them.
 const optionStep=contentNeedsWork?await optionalDraftOperation('option-normalization',productId,()=>homestroUpdateOptionNames(productId,p.options||[],token),{options:0,values:0}):{ok:true,value:{options:0,values:0}};
 const collectionStep=await optionalDraftOperation('collection-assignment',productId,()=>assignDraftCollection({id:productId,title:x.title,productType:category,description:x.description},token),{assigned:false,pending:true,reason:'collection-assignment-failed'});
 const optionsUpdated=optionStep.value.options;
 const variantsUpdated=optionStep.value.values;
 const collection=collectionStep.value;
 // Preserve imported images until supplier identity is known; image association
 // is not part of the safe metadata/content normalization path.
 const variantImages=supplierState.available?await associateDraftVariantImages(p,token):{changed:0,pending:(p.variants?.nodes||[]).filter(v=>!v.image).length,reason:supplierState.reason};
 const existingImages=(p.media?.nodes||[]).filter(m=>String(m.mediaContentType||'')==='IMAGE'&&m.image?.url);
 let media={count:existingImages.length,validation:existingImages.length?'preserved-existing':'not-run'};
 let imagesVerified=existingImages.length>0&&existingTags.includes('homestro-ai-images-verified');
 if(supplierState.available&&(existingTags.includes('homestro-ai-image-pending')||existingImages.length===0)){
   try{
    if(process.env.OPENAI_API_KEY){
      let relevant=0;
      for(const m of existingImages.slice(0,5)){
       if(await imageIsRelevant(m.image.url,{...aiInput,title:x.title,category:x.category||p.productType},(details.page_title+' '+details.page_text).slice(0,4000)))relevant++;
      }
      if(relevant>0){
       imagesVerified=true;
       media={count:existingImages.length,validation:'strict-ai-vision-existing-preserved',relevant};
      }else{
       let added=0;
       for(let i=0;i<3&&existingImages.length+added<5;i++){
        const dataUrl=await generateHomestroImage({...aiInput,title:x.title,category:x.category||p.productType},x.title,(details.page_title+' '+details.page_text).slice(0,4000));
        if(!dataUrl)break;
        const uploaded=await uploadGeneratedImageToShopify(productId,dataUrl,x.title,token,i+1);
        if(uploaded)added++;
       }
       if(added>0){imagesVerified=true;media={count:existingImages.length+added,validation:'strict-ai-vision-replacement-added',generated:added};}
       else media={count:existingImages.length,validation:'image-pending'};
      }
    }else media={count:existingImages.length,validation:'image-pending-no-api'};
   }catch(e){
    console.error('EXISTING_DRAFT_IMAGE_NON_BLOCKING',productId,String(e?.message||e));
    media={count:existingImages.length,validation:'image-pending'};
   }
 }
 const imagePending=!imagesVerified;
 const finalTags=[...new Set([
  ...tags.filter(t=>!['homestro-ai-image-pending','homestro-ai-images-checked','homestro-ai-images-verified','homestro-ai-complete','homestro-profit-pending','homestro-profit-checked'].includes(String(t))),
  'homestro-ai-processed-existing',
  ...(profitPending?['homestro-profit-pending']:['homestro-profit-checked']),
  ...(imagePending?['homestro-ai-image-pending']:['homestro-ai-images-verified'])
 ])];
 // Read after every write. This is both the final DRAFT guard and the QA gate;
 // tags never claim readiness based on optimistic local state.
 const verified=(await shopifyGraphQL('query($id:ID!){product(id:$id){id status title description productType seo{title description} collections(first:20){nodes{id title handle}} variants(first:100){nodes{id price selectedOptions{name value} image{id url} inventoryItem{unitCost{amount}}}} media(first:30){nodes{id ... on MediaImage{image{url width height}}}}}}',{id:productId},token)).product;
 assertDraftProduct(verified);
 for(const v of verified.variants?.nodes||[])if(landedEvidence.verified)v.cost=landedEvidence.landedByVariant[v.id];
 const qa=qaProduct({...verified,landedCostVerified:landedEvidence.verified,rules:{minSellingPrice:rules().minSellingPrice,minRatio:rules().minRatio,minNetProfit:rules().minNetProfit}});
 const optionalPending=[['option-normalization',optionStep],['collection-assignment',collectionStep]].filter(([,step])=>!step.ok).map(([name])=>name);
 const complete=qa.ok&&optionalPending.length===0;
 finalTags.push(complete?'homestro-ai-complete':'homestro-ai-qa-pending');
 const cleanFinal=finalTags.filter(t=>complete?t!=='homestro-ai-qa-pending':t!=='homestro-ai-complete');
 await setProductTags(productId,[...new Set(cleanFinal)],token);
 const pendingChecks=[...new Set([...supplierState.pendingChecks,...optionalPending,...(!landedEvidence.verified&&supplierState.available?['variant-landed-cost','destination-shipping','matched-market-price']:[]),...(qa.reasons||[])])];
 if(pendingChecks.length)console.log('EXISTING_DRAFT_QA_PENDING',productId,'reason='+(supplierState.reason||landedEvidence.reason||'qa-incomplete'),'pendingChecks='+pendingChecks.join(','));
 return {id:productId,title:x.title,source_url:src||null,source_product_id:id||null,images:media.count,variants:(p.variants?.nodes||[]).length,optionsUpdated,variantsUpdated,variantImages,collection,optionalOperations:{options:optionStep,collection:collectionStep},price,cost:supplierState.available&&Number.isFinite(cost)?cost:null,supplierCost,ratio:supplierState.available&&Number.isFinite(ratio)?ratio:null,profitPending,estimatedProfitEur:supplierState.available?profitability.estimatedProfitEur:null,pricingChanged:pricing.changed,processed:true,skipped:false,reason:supplierState.reason,pendingChecks,contentUpdated:contentNeedsWork,mediaValidation:media.validation,imagesVerified,qa,complete,landedCostVerified:landedEvidence.verified,profitStatus:landedEvidence.verified?'VERIFIED_LANDED_COST':'PENDING_SUPPLIER_EVIDENCE',supplierContributionPending};
}
async function processExistingDrafts(limit,token){
 const d=await shopifyGraphQL('query($first:Int!,$query:String){products(first:$first,query:$query,sortKey:CREATED_AT,reverse:true){nodes{id title status description vendor tags metafields(first:20){nodes{key value}}}}}',{first:50,query:'status:draft'},token);
 const eligible=d.products.nodes.slice(0,Math.min(Math.max(Number(limit)||50,1),50));
 const results=[];
 for(const p of eligible){
  try{results.push(await processExistingDraftProduct(p.id,token));}
  catch(e){
   try{
    const current=await shopifyGraphQL('query($id:ID!){product(id:$id){status tags}}',{id:p.id},token);
    assertDraftProduct(current.product);
    const tags=[...new Set([...(current.product?.tags||[]),'homestro-ai-failed-existing'])];
    await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id tags}userErrors{message}}}',{input:{id:p.id,tags}},token);
   }catch{}
   results.push({id:p.id,title:p.title,processed:false,error:e.message});
  }
 }
 return results;
}
const draftAutopilotState={running:false,imageRunning:false,lastRun:null,lastError:null,processed:0,skipped:0,pending:0,lastResult:null};
function draftAutopilotInterval(){const n=Number(process.env.HOMESTRO_AUTOPILOT_INTERVAL_MS||300000);return Number.isFinite(n)&&n>=60000?n:300000;}
async function runDraftImageQA(){
 if(process.env.HOMESTRO_IMAGE_QA_ENABLED==='false'){console.log('DRAFT IMAGE QA DISABLED');return {disabled:true};}
 if(draftAutopilotState.imageRunning)return;
 draftAutopilotState.imageRunning=true;
 try{
  const token=await getClientToken();
  const d=await shopifyGraphQL('query{products(first:50,query:"status:draft",sortKey:CREATED_AT,reverse:true){nodes{id title status description vendor productType tags metafields(first:20,namespace:"homestro"){nodes{key value}} media(first:20){nodes{id mediaContentType status alt ... on MediaImage { image { url } }}}}}}',{},token);
  const nodes=d.products.nodes||[];
  const imageEligible=nodes.filter(p=>{const mf=Object.fromEntries((p.metafields?.nodes||[]).map(m=>[m.key,m.value]));return !p.tags?.includes('homestro-ai-rejected')&&Boolean(aliExpressReference({url:mf.aliexpress_url,description:p.description}).url)&&String(p.status)==='DRAFT'&&!((p.tags||[]).map(String).includes('homestro-ai-images-verified'))&&!((p.tags||[]).map(String).includes('homestro-ai-image-pending'));}).slice(0,50);
  console.log('DRAFT IMAGE QA QUEUE','drafts='+nodes.length,'eligible='+imageEligible.length);
  for(const p of imageEligible){
   try{
    const result=await repairExistingDraftImages(p.id,p,token);
    const safety=await shopifyGraphQL('query($id:ID!){product(id:$id){status}}',{id:p.id},token);
    assertDraftProduct(safety.product);
    const tags=[...(p.tags||[]).map(String)].filter(t=>!['homestro-ai-images-checked','homestro-ai-image-pending','homestro-ai-complete','homestro-ai-images-verified'].includes(t));
    // Image QA is only one stage. It must never independently declare the
    // complete product ready (content, variants, pricing and collection may fail).
    tags.push('homestro-ai-images-verified');
    const u=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id tags}userErrors{field message}}}',{input:{id:p.id,tags:[...new Set(tags)]}},token);
    const errs=u.productUpdate?.userErrors||[];
    if(errs.length)throw new Error(errs.map(x=>x.message).join('; '));
    console.log('DRAFT IMAGE REPAIR COMPLETE',p.id,'checked='+result.checked,'kept='+result.kept,'removed='+result.removed,'generated='+result.generated);
   }catch(e){
    try{
      const current=await shopifyGraphQL('query($id:ID!){product(id:$id){status tags}}',{id:p.id},token);
      assertDraftProduct(current.product);
      const tags=[...(current.product?.tags||[]).map(String)].filter(t=>!['homestro-ai-complete','homestro-ai-images-verified','homestro-ai-images-checked'].includes(t));
      tags.push('homestro-ai-image-pending');
      await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id tags}userErrors{message}}}',{input:{id:p.id,tags:[...new Set(tags)]}},token);
    }catch{}
    console.error('DRAFT IMAGE REPAIR FAILED',p.id,e.message);
   }
  }
 }catch(e){console.error('DRAFT IMAGE QA FAILED',e.message);}
 finally{draftAutopilotState.imageRunning=false;}
}

async function draftAutopilotRun(){
 if(draftAutopilotState.running)return;
 draftAutopilotState.running=true;
 try{
  const token=await getClientToken();
  const d=await shopifyGraphQL('query{products(first:50,query:"status:draft",sortKey:CREATED_AT,reverse:true){nodes{id title status description vendor productType tags metafields(first:20){nodes{key value}} media(first:30){nodes{id mediaContentType status alt ... on MediaImage { image { url } }}}}}}',{},token);
  const nodes=d.products.nodes||[];
  const eligible=nodes.filter(p=>isDsersImportedCandidate(p)).slice(0,50);
  draftAutopilotState.skipped=0;
  console.log('DRAFT AUTOPILOT QUEUE','shopifyDraftQuery='+nodes.length,'eligible='+eligible.length);
  let done=0;
  const allResults=[];
  const concurrency=3;
  for(let i=0;i<eligible.length;i+=concurrency){
   const chunk=eligible.slice(i,i+concurrency);
   const results=await Promise.all(chunk.map(async p=>{
    try{return await processExistingDraftProduct(p.id,token);}
    catch(e){console.error('DRAFT AUTOPILOT PRODUCT FAILED',p.id,e.message);return {processed:false,id:p.id,error:String(e.message)};}
   }));
   allResults.push(...results);
   done+=results.filter(x=>x.processed===true).length;
   console.log('DRAFT AUTOPILOT PROGRESS','batch='+Math.floor(i/concurrency+1),'done='+done,'target='+eligible.length);
  }
  draftAutopilotState.lastResult=summarizeAutopilotResults(allResults);
  draftAutopilotState.skipped=draftAutopilotState.lastResult.skipped;
  draftAutopilotState.pending=draftAutopilotState.lastResult.pending;
  draftAutopilotState.processed+=done;
  draftAutopilotState.lastRun=new Date().toISOString();
  draftAutopilotState.lastError=null;
  console.log('DRAFT AUTOPILOT COMPLETE','eligible='+eligible.length,'processed='+done,'skipped='+draftAutopilotState.skipped);
 }catch(e){draftAutopilotState.lastRun=new Date().toISOString();draftAutopilotState.lastError=e.message;console.error('DRAFT AUTOPILOT FAILED',e.message);}
 finally{draftAutopilotState.running=false;}
}

async function catalogRun(){
 if(catalogState.running)return;
 console.log('CATALOG RUN VERSION','eu-evidence-v2','batch='+String(process.env.HOMESTRO_CANDIDATE_BATCH||process.env.HOMESTRO_CATALOG_BATCH||100));
 catalogState.running=true;
 let rejected=0,failed=0; const rejectionReasons=new Map(); const reject=(reason)=>{rejected++;rejectionReasons.set(reason,Number(rejectionReasons.get(reason)||0)+1);};
 try{
  const batch=Math.max(1,Number(process.env.HOMESTRO_CANDIDATE_BATCH||process.env.HOMESTRO_CATALOG_BATCH||100));
  const candidates=[],runSeen=new Set(),titleSeen=new Set(),keywordCounts=new Map();
  for(const k of catalogKeywords){
   if(candidates.length>=batch)break;
   let items=[];
   try{items=await catalogSearch(k);}catch(e){failed++;console.error('CATALOG SOURCE FAILED',k,e.message);continue;}
   for(const x of items){
    if(candidates.length>=batch)break;
    if(runSeen.has(x.id))continue;
    runSeen.add(x.id); catalogState.seen.add(x.id);
    if(String(x.source_role||'supplier')==='market_reference'){
      console.log('CATALOG MARKET-REFERENCE',k,x.id,'source='+String(x.source_type||'unknown'),'title='+String(x.title||'').slice(0,120));
      continue;
    }
    const externalReason=homestroExternalCandidatePass(x);
    if(externalReason){reject(externalReason);continue;}
    if(Number.isFinite(Number(x.cost))&&Number(x.cost)<=0){reject('invalid-cost');continue;}

    // catalogSearch already fetched/enriched the AliExpress detail page. Reuse that evidence.
    // A second unconditional fetch caused valid EU-stock items to disappear when AliExpress
    // returned a transient/blocked response on the second request.
    const candidate={
      id:String(x.id),keyword:k,title:String(x.title||'').trim(),url:String(x.source_url||x.url||''),
      costEur:Number(x.costEur??x.cost),sold:Number(x.sold||0),euWarehouse:x.euWarehouse===true,
      source_type:String(x.source_type||'aliexpress'),source_role:String(x.source_role||'supplier'),
      warehouse:String(x.warehouse||''),sellingPriceEur:0,ratio:0,estimatedProfitBeforeShippingVat:0,
      marketChecked:false,marketLowestPriceEur:NaN,marketStatus:'NOT_CHECKED',marketOffers:[],
      recommendedSellingPriceEur:0,
      note:'Preis-/EU-Filter bestanden. Versand/DPH/Servicekosten aus DSers müssen vor Verkauf geprüft werden.'
    };
    // Only retry detail enrichment when catalogSearch did not obtain a required field.
    // Never replace positive EU evidence with a failed second fetch.
    const missingDetail=!candidate.euWarehouse||!Number.isFinite(candidate.costEur)||candidate.costEur<=0||candidate.sold<rules().minSold||!candidate.title;
    if(missingDetail){
      try{
        const details=await extractAliExpressDetails(x.source_url);
        if(details.page_title)candidate.title=String(details.page_title).trim();
        if(Number.isFinite(details.costEur)&&details.costEur>0)candidate.costEur=details.costEur;
        if(Number.isFinite(details.sold)&&details.sold>0)candidate.sold=details.sold;
        if(details.euWarehouse===true)candidate.euWarehouse=true;
      }catch{}
    }

    if(candidate.euWarehouse!==true){
      reject('eu-warehouse-not-confirmed');
      console.log('CATALOG REJECT',k,x.id,'reason=eu-warehouse-not-confirmed','title='+String(candidate.title||'').slice(0,120));
      continue;
    }

    const amazon=await homestroAmazonCheck(candidate);
    candidate.amazonChecked=amazon.checked;
    candidate.amazonMatched=Boolean(amazon.matched);
    candidate.amazonPriceEur=amazon.priceEur;
    candidate.amazonMatchConfidence=amazon.confidence;
    candidate.amazonUrl=amazon.url||'';
    candidate.amazonStatus=amazon.reason||(amazon.reject||'amazon-market-ok');
    if(amazon.reject){
      reject(amazon.reject);
      console.log('CATALOG REJECT',k,x.id,'reason='+amazon.reject,'amazon='+amazon.priceEur,'required='+amazon.requiredSellingPriceEur);
      continue;
    }
    if(amazon.checked&&!amazon.matched&&process.env.HOMESTRO_AMAZON_REQUIRE_MATCH==='true'){
      reject('amazon-product-match-not-confirmed');
      continue;
    }

    const finalReason=catalogPassReason({
      id:candidate.id,title:candidate.title,cost:candidate.costEur,sold:candidate.sold,
      source_url:candidate.url,euWarehouse:candidate.euWarehouse,
      amazonPriceEur:candidate.amazonPriceEur,amazonMatchConfidence:candidate.amazonMatchConfidence
    });
    if(finalReason){
      reject(finalReason);
      console.log('CATALOG REJECT',k,x.id,'reason='+finalReason,'title='+String(candidate.title||'').slice(0,120),'cost='+candidate.costEur,'sold='+candidate.sold,'eu='+candidate.euWarehouse);
      continue;
    }

    const hp=/(earphone|earbuds?|headphone|headset|bluetooth headphones?|wireless headphones?|ai headphones?|kopfhörer|ohrhörer)/i.test(candidate.title);
    candidate.sellingPriceEur=targetSellingPrice(candidate.costEur,hp,rules());
    candidate.recommendedSellingPriceEur=candidate.sellingPriceEur;
    if(process.env.HOMESTRO_MARKET_CHECK_ENABLED!=='false'){
      const market=await homestroCompetitivePrice(candidate);
      Object.assign(candidate,{
        marketChecked:Boolean(market.marketChecked),
        marketLowestPriceEur:Number.isFinite(market.marketLowestPriceEur)?market.marketLowestPriceEur:NaN,
        marketStatus:String(market.marketStatus||'NOT_CHECKED'),
        marketOffers:Array.isArray(market.marketOffers)?market.marketOffers:[],
        recommendedSellingPriceEur:Number(market.recommendedSellingPriceEur||candidate.sellingPriceEur)
      });
      if(candidate.marketStatus==='UNCOMPETITIVE_PRICE'){
        reject('UNCOMPETITIVE_PRICE');
        console.log('CATALOG REJECT',k,x.id,'reason=UNCOMPETITIVE_PRICE','our='+candidate.sellingPriceEur,'market='+candidate.marketLowestPriceEur);
        continue;
      }
      candidate.sellingPriceEur=candidate.recommendedSellingPriceEur||candidate.sellingPriceEur;
    }
    Object.assign(candidate,candidateProfitEvidence(candidate));
    candidate.ratio=Number((candidate.sellingPriceEur/candidate.costEur).toFixed(2));
    candidate.estimatedProfitBeforeShippingVat=Number(ebayProfitability({selling_price:candidate.sellingPriceEur,landed_cost_eur:candidate.costEur}).estimatedProfitEur||0);
    if(candidate.estimatedProfitBeforeShippingVat<rules().minNetProfit){
      reject('profit-under-'+rules().minNetProfit+'-after-market-price');
      continue;
    }

    const titleKey=String(candidate.title||'').toLowerCase().replace(/[^a-z0-9äöüß]+/g,' ').trim();
    const keyCount=Number(keywordCounts.get(k)||0);
    if(titleSeen.has(titleKey)){reject('duplicate-title');continue;}
    if(keyCount>=5){reject('keyword-cap');continue;}
    titleSeen.add(titleKey); keywordCounts.set(k,keyCount+1); candidates.push(candidate);
   }
  }
  catalogState.candidates=candidates;
  catalogState.rejected+=rejected;
  catalogState.lastRun=new Date().toISOString();
  catalogState.lastError=null;
  console.log('CATALOG REJECTION SUMMARY',JSON.stringify(Object.fromEntries(rejectionReasons)));
  console.log('CATALOG CANDIDATE RUN COMPLETE','candidates='+candidates.length,'rejected='+rejected,'failed='+failed);
 }catch(e){
  catalogState.lastRun=new Date().toISOString();catalogState.lastError=e.message;
  console.error('CATALOG RUN FAILED',e.message);
 }finally{catalogState.running=false;}
}

registerSidekickApi(app,{sidekick,apiKey,catalogState,catalogInterval,catalogRun,validateProduct:body=>validateProduct(Number(body.cost),Number(body.sellingPrice),body.ratio===undefined?undefined:Number(body.ratio))});

app.get('/api/catalog/sources',apiKey,(_q,res)=>res.json({ok:true,apifyConfigured:Boolean(process.env.APIFY_API_TOKEN),actors:{aliexpress:Boolean(process.env.APIFY_ALIEXPRESS_ACTOR_ID),cj:Boolean(process.env.APIFY_CJ_ACTOR_ID),bigbuy:Boolean(process.env.APIFY_BIGBUY_ACTOR_ID),amazon:Boolean(process.env.APIFY_AMAZON_ACTOR_ID),googleShopping:Boolean(process.env.APIFY_GOOGLE_SHOPPING_ACTOR_ID)},marketCheckEnabled:process.env.HOMESTRO_MARKET_CHECK_ENABLED!=='false',marketCountry:process.env.HOMESTRO_MARKET_COUNTRY||'DE'}));
app.get('/api/catalog/candidates',apiKey,(_q,res)=>res.json({ok:true,source:'AliExpress',count:catalogState.candidates.length,candidates:catalogState.candidates.map(x=>({url:x.url,title:x.title,costEur:x.costEur,sellingPriceEur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,euWarehouse:x.euWarehouse,estimatedProfitBeforeShippingVat:x.estimatedProfitBeforeShippingVat,note:x.note}))}));
function csvCell(v){const s=String(v??'');return '"'+s.replace(/"/g,'""')+'"';}
function catalogFeedRows(){return catalogState.candidates.map(x=>({id:x.id,title:x.title,url:x.url,cost_eur:x.costEur,selling_price_eur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,eu_warehouse:x.euWarehouse?'TRUE':'FALSE',warehouse:x.warehouse||'',amazon_checked:x.amazonChecked?'TRUE':'FALSE',amazon_matched:x.amazonMatched?'TRUE':'FALSE',amazon_price_eur:Number.isFinite(x.amazonPriceEur)?x.amazonPriceEur:'',amazon_url:x.amazonUrl||'',market_checked:x.marketChecked?'TRUE':'FALSE',market_lowest_price_eur:Number.isFinite(x.marketLowestPriceEur)?x.marketLowestPriceEur:'',market_status:x.marketStatus||'NOT_CHECKED',recommended_selling_price_eur:x.recommendedSellingPriceEur||x.sellingPriceEur,estimated_profit_eur:x.estimatedProfitBeforeShippingVat,source:x.source_type||'AliExpress',status:'CANDIDATE',profit_status:'PROVISIONAL_BEFORE_SHIPPING_AND_TAX',landed_cost_verified:'FALSE',sell_ready:'FALSE'}));}
function sendCatalogCsv(res){const rows=catalogFeedRows(),headers=['id','title','url','cost_eur','selling_price_eur','sold','ratio','eu_warehouse','warehouse','amazon_checked','amazon_matched','amazon_price_eur','amazon_url','market_checked','market_lowest_price_eur','market_status','recommended_selling_price_eur','estimated_profit_eur','source','status','profit_status','landed_cost_verified','sell_ready'];res.set('Content-Type','text/csv; charset=utf-8');res.send('\uFEFF'+headers.join(',')+'\n'+rows.map(r=>headers.map(h=>csvCell(r[h])).join(',')).join('\n'));}
app.get('/feeds/products.csv',(_q,res)=>sendCatalogCsv(res));
app.get('/feeds/google-sheet.csv',(_q,res)=>sendCatalogCsv(res));
app.get('/feeds/youtube.json',(_q,res)=>res.json({ok:true,source:'Homestro candidate feed',generatedAt:new Date().toISOString(),items:catalogState.candidates.map(x=>({title:x.title,productUrl:x.url,hook:'Praktisches Produkt für den Alltag – jetzt bei Homestro entdecken.',description:'Entdecke '+x.title+' bei Homestro.de. Produktdaten und Verfügbarkeit vor dem Verkauf nochmals prüfen.',sellingPriceEur:x.sellingPriceEur}))}));
app.get('/catalog/candidates-public',(_q,res)=>res.json({ok:true,source:'AliExpress',count:catalogState.candidates.length,candidates:catalogState.candidates.map(x=>({url:x.url,title:x.title,costEur:x.costEur,sellingPriceEur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,euWarehouse:x.euWarehouse,estimatedProfitBeforeShippingVat:x.estimatedProfitBeforeShippingVat,...candidateProfitEvidence(x)}))}));

app.post('/api/catalog/process-existing',apiKey,async(req,res)=>{try{const selected=normalizeSelectedDraftId(req.body?.productId);const token=await getClientToken();const results=selected?[await processExistingDraftProduct(selected,token)]:await processExistingDrafts(Math.min(Number(req.body?.limit||10),10),token);res.json({ok:true,results});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
app.get('/api/catalog/process-existing-test',apiKey,async(req,res)=>{try{const token=await getClientToken();const results=await processExistingDrafts(Math.min(Number(req.query?.limit||5),5),token);res.json({ok:true,results});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
app.get('/health/catalog',(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',running:catalogState.running,lastRun:catalogState.lastRun,lastError:catalogState.lastError,totals:{created:catalogState.created,rejected:catalogState.rejected,failed:catalogState.failed}}));
app.get('/api/catalog/status',apiKey,(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',running:catalogState.running,lastRun:catalogState.lastRun,lastError:catalogState.lastError,totals:{created:catalogState.created,rejected:catalogState.rejected,failed:catalogState.failed}}));
app.post('/api/catalog/run',apiKey,async(_q,res)=>{if(catalogState.running)return res.json({ok:true,skipped:true});catalogRun();res.json({ok:true,started:true});});
if(process.env.HOMESTRO_CATALOG_ENABLED!=='false'){setTimeout(()=>catalogRun().catch(e=>console.error('CATALOG AUTO FAILED',e.message)),10000);setInterval(()=>catalogRun().catch(e=>console.error('CATALOG AUTO FAILED',e.message)),catalogInterval());}

app.get('/api/automation/status-public',(_q,res)=>res.json({ok:true,service:'homestro-catalog-autopilot',enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',intervalMs:catalogInterval(),running:catalogState.running,lastRun:catalogState.lastRun,lastError:catalogState.lastError,totals:{created:catalogState.created,rejected:catalogState.rejected,failed:catalogState.failed}}));


app.get('/api/autopilot/status',apiKey,(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false',intervalMs:draftAutopilotInterval(),running:draftAutopilotState.running,lastRun:draftAutopilotState.lastRun,lastError:draftAutopilotState.lastError,processed:draftAutopilotState.processed,skipped:draftAutopilotState.skipped,pending:draftAutopilotState.pending,lastResult:draftAutopilotState.lastResult}));
if(process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false'){
 setTimeout(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),15000); setInterval(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),draftAutopilotInterval());
}
// One-time visual QA safety net: runs independently of the text autopilot flag and is idempotent via homestro-ai-images-checked.
if(process.env.HOMESTRO_IMAGE_QA_ENABLED!=='false')setTimeout(()=>runDraftImageQA().catch(e=>console.error('DRAFT IMAGE QA AUTO FAILED',e.message)),20000);


const homestroRecommendationState={running:false,lastRun:null,lastError:null,processed:0,updated:0};
const HM_REC_STOPWORDS=new Set(['der','die','das','ein','eine','einer','einem','einen','und','oder','für','mit','von','zu','im','in','auf','an','bei','the','and','for','with','from','of','to','a','an','set','neu','new','home','homestro','produkt','produkte','stück','stuck','pcs','stückzahl']);
const HM_REC_RULES=[
 {a:/zahn.?bürste|zahnbürste|finger.?zahnbürste|zahnreinigung|zahnpflege/i,b:/zahnpasta|zahncreme|zahn.?gel|zahnreinigungs.?gel/i},
 {a:/stift.?halter|stifthalter|stiftständer|schreib.?tisch.?organizer/i,b:/kugelschreiber|gel.?stift|fineliner|marker|textmarker|bleistift|schreibstift/i},
 {a:/kugelschreiber|gel.?stift|fineliner|marker|textmarker|bleistift|schreibstift/i,b:/stift.?halter|stifthalter|stiftständer|schreib.?tisch.?organizer/i},
 {a:/küchen.?messer|chef.?messer|koch.?messer|messer/i,b:/messerschärfer|messerschleifer|schärfer|schneidebrett|schneidbrett/i},
 {a:/messerschärfer|messerschleifer|schärfer/i,b:/küchen.?messer|chef.?messer|koch.?messer/i},
 {a:/kopfhörer|ohrhörer|earbuds?|headphones?|headset/i,b:/kopfhörer.?tasche|headphone.?case|headset.?case|kopfhörer.?ständer|headphone.?stand|reinigungs.?set|earbud.?case/i},
 {a:/hunde?|hundezubehör|katzen?|haustier/i,b:/hundezahnpasta|zahnpasta|zahncreme|fell.?pflege|pflege.?bürste|grooming|leckerl/i},
 {a:/auto|autopflege|fahrzeugpflege|detailing/i,b:/mikrofaser|reinigungs.?tuch|detail.?bürste|innenraum.?reiniger|glasreiniger|reinigungs.?pinsel/i},
 {a:/garten|pflanzen|pflanz/i,b:/gartenschere|handschuhe|pflanz.?schaufel|gießkanne|bewässerung|pflanzenbinder/i},
 {a:/wäsche|waschen|kleidung.?pflege/i,b:/wäschesack|waschbeutel|fleckenentferner|wäschetrockner|wäschenetz/i},
 {a:/backen|back.?form|kuchen|teig/i,b:/backpapier|teigschaber|messbecher|küchenwaage|spritzbeutel/i},
 {a:/fitness|training|sport|yoga/i,b:/widerstandsband|fitnessband|sporthandtuch|trinkflasche|shaker|griffhilfe/i},
 {a:/reise|travel|koffer|gepäck/i,b:/gepäckwaage|reise.?organizer|koffer.?anhänger|kulturbeutel|reisetasche/i},
 {a:/beauty|kosmetik|hautpflege|gesichtspflege/i,b:/reinigung|gesichtsbürste|kosmetik.?tasche|applikator|pflege.?pad/i}
];
function hmRecText(p){
 return [p.title,p.productType,p.vendor,(Array.isArray(p.tags)?p.tags:[]).join(' '),String(p.description||'').replace(/<[^>]*>/g,' ').slice(0,1800),(p.collections?.nodes||[]).map(x=>x.title).join(' ')].join(' ').toLowerCase();
}
function hmRecTokens(text){
 return new Set(String(text||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').split(/[^a-z0-9äöüß]+/i).map(x=>x.trim()).filter(x=>x.length>=4&&!HM_REC_STOPWORDS.has(x)));
}
function hmRecRuleScore(a,b){
 const ta=hmRecText(a),tb=hmRecText(b); let score=0;
 for(const rule of HM_REC_RULES){
  if(rule.a.test(ta)&&rule.b.test(tb))score=Math.max(score,100);
  if(rule.b.test(ta)&&rule.a.test(tb))score=Math.max(score,100);
 }
 return score;
}
function hmRecScore(a,b){
 if(!b||String(a.id)===String(b.id)||String(b.status||'').toUpperCase()!=='ACTIVE')return -Infinity;
 const ta=hmRecText(a),tb=hmRecText(b); let score=hmRecRuleScore(a,b);
 const A=hmRecTokens(ta),B=hmRecTokens(tb); let overlap=0; for(const t of A)if(B.has(t))overlap++;
 score+=Math.min(overlap,5)*8;
 const atags=new Set((a.tags||[]).map(x=>String(x).toLowerCase())),btags=new Set((b.tags||[]).map(x=>String(x).toLowerCase())); let tagOverlap=0;
 for(const t of atags)if(btags.has(t))tagOverlap++;
 score+=Math.min(tagOverlap,4)*12;
 const ac=new Set((a.collections?.nodes||[]).map(x=>x.handle)),bc=new Set((b.collections?.nodes||[]).map(x=>x.handle)); let collectionOverlap=0;
 for(const x of ac)if(bc.has(x))collectionOverlap++;
 score+=Math.min(collectionOverlap,3)*6;
 if(a.productType&&b.productType&&String(a.productType).toLowerCase()===String(b.productType).toLowerCase())score-=18;
 const titleA=String(a.title||'').toLowerCase(),titleB=String(b.title||'').toLowerCase();
 if(titleA===titleB)return -Infinity;
 if(/\b(ersatz|replacement|reserve|refill)\b/i.test(titleB))score-=8;
 const priceA=Number(a.variants?.nodes?.[0]?.price||0),priceB=Number(b.variants?.nodes?.[0]?.price||0);
 if(priceA>0&&priceB>0&&priceB<=priceA*0.75)score+=5;
 if(priceA>0&&priceB>priceA*1.8)score-=5;
 return score;
}
async function refreshHomestroComplementaryRecommendations(token){
 if(homestroRecommendationState.running)return {skipped:true};
 homestroRecommendationState.running=true;
 try{
  const d=await shopifyGraphQL('query{products(first:250){nodes{id title description productType vendor tags status collections(first:10){nodes{id handle title}} variants(first:10){nodes{price}}}}}',{},token);
  const products=(d.products?.nodes||[]).filter(p=>['ACTIVE','DRAFT'].includes(String(p.status).toUpperCase()));
  const active=products.filter(p=>String(p.status).toUpperCase()==='ACTIVE'&&((p.variants?.nodes||[]).some(v=>Number(v.price||0)>0)));
  const imported=products.filter(p=>isDraftProduct(p)&&(isDsersImportedCandidate(p)||((p.tags||[]).map(String).includes('homestro-ai-processed-existing'))));
  const writes=[]; let processed=0,updated=0;
  for(const source of imported){
   const candidates=active.map(target=>({target,score:hmRecScore(source,target)})).filter(x=>Number.isFinite(x.score)&&x.score>=38).sort((a,b)=>b.score-a.score||String(a.target.title).localeCompare(String(b.target.title),'de')).slice(0,3).map(x=>x.target.id);
   writes.push({ownerId:source.id,ids:candidates}); processed++;
  }
  for(let i=0;i<writes.length;i+=25){
   const batch=writes.slice(i,i+25);
   const metafields=batch.map(x=>({ownerId:x.ownerId,namespace:'shopify--discovery--product_recommendation',key:'complementary_products',type:'list.product_reference',value:JSON.stringify(x.ids)}));
   const u=await shopifyGraphQL('mutation($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{namespace key value}userErrors{field message code}}}',{metafields},token);
   const errs=u.metafieldsSet?.userErrors||[]; if(errs.length)throw new Error(errs.map(e=>e.message).join('; ')); updated+=batch.length;
  }
  homestroRecommendationState.processed+=processed; homestroRecommendationState.updated+=updated; homestroRecommendationState.lastRun=new Date().toISOString(); homestroRecommendationState.lastError=null;
  return {processed,updated,activeCandidates:active.length};
 }catch(e){homestroRecommendationState.lastRun=new Date().toISOString();homestroRecommendationState.lastError=e.message;throw e;}
 finally{homestroRecommendationState.running=false;}
}
app.get('/api/recommendations/status',apiKey,(_q,res)=>res.json({ok:true,...homestroRecommendationState}));
app.post('/api/recommendations/refresh',apiKey,async(_q,res)=>{try{const token=await getClientToken();res.json({ok:true,...await refreshHomestroComplementaryRecommendations(token)});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
setTimeout(()=>{console.log('HOMESTRO RECOMMENDATIONS START');getClientToken().then(refreshHomestroComplementaryRecommendations).then(r=>console.log('HOMESTRO RECOMMENDATIONS COMPLETE',JSON.stringify(r))).catch(e=>console.error('HOMESTRO RECOMMENDATIONS STARTUP FAILED',e.message))},25000);
setInterval(()=>getClientToken().then(refreshHomestroComplementaryRecommendations).catch(e=>console.error('HOMESTRO RECOMMENDATIONS AUTO FAILED',e.message)),6*60*60*1000);

app.listen(PORT,()=>console.log(`Homestro AI Control listening on ${PORT}`));
// Immediate image-QA kickoff for existing DRAFTs; the image-check tag makes this idempotent.
if(process.env.HOMESTRO_IMAGE_QA_ENABLED!=='false')runDraftImageQA().catch(e=>console.error('DRAFT IMAGE QA STARTUP FAILED',e.message));

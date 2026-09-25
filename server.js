const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
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
function rules(){return{maxCost:Number(process.env.MAX_PRODUCT_COST||10),minSellingPrice:Number(process.env.MIN_SELLING_PRICE||34.9),minRatio:Number(process.env.MIN_PRICE_COST_RATIO||3)};}
function validateProduct(cost,sellingPrice,ratio){const r=rules();return{valid:Number.isFinite(cost)&&Number.isFinite(sellingPrice)&&Number.isFinite(ratio)&&cost<=r.maxCost&&sellingPrice>=r.minSellingPrice&&ratio>=r.minRatio,product:{cost,sellingPrice,ratio},rules:r};}
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
function homestroSanitizeProduct(p,input){const x={...(p||{})};x.title=homestroStripEmoji(x.title||input?.title||'Produkt');x.description=String(x.description||'').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').trim();x.seoTitle=homestroStripEmoji(x.seoTitle||x.title).slice(0,70);x.seoDescription=homestroStripEmoji(x.seoDescription||homestroPlain(x.description)).slice(0,320);x.handle=homestroCleanHandle(x.handle,x.title);x.category=homestroStripEmoji(x.category||input?.category||input?.productType||'');x.tags=[...new Set((Array.isArray(x.tags)?x.tags:[]).map(homestroStripEmoji).filter(Boolean))];return x;}
function homestroVariantLabel(name){let v=homestroStripEmoji(name);const colors={white:'Weiß',red:'Rot',green:'Grün',grey:'Grau',gray:'Grau',black:'Schwarz',blue:'Blau',navy:'Marineblau',pink:'Rosa',rose:'Rosa',beige:'Beige',brown:'Braun',orange:'Orange',yellow:'Gelb',purple:'Lila',violet:'Violett',silver:'Silber',gold:'Gold'};if(colors[v.toLowerCase()])return colors[v.toLowerCase()];let m=v.match(/^Style\s*([A-Z])$/i);if(m)return 'Ausführung '+m[1].toUpperCase();m=v.match(/^Style\s*([A-Z])\s*[-–— ]\s*(\d+)\s*(?:PC|PCS)/i);if(m)return m[2]+'er-Set – Ausführung '+m[1].toUpperCase();return v;}
async function aiProduct(input){
 if(!process.env.OPENAI_API_KEY)throw Object.assign(new Error('OPENAI_API_KEY is not configured.'),{status:503});
 const model=process.env.OPENAI_MODEL||'gpt-5-mini';
 const system='Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Schreibe ausschließlich natürliches, professionelles Deutsch. Nutze nur belegbare Angaben aus den gelieferten Quelldaten. Keine erfundenen technischen Daten, Materialien, Maße, Zertifikate, Garantien, Lieferzeiten, Bewertungen, Verkaufszahlen oder Varianten. Keine Emojis, keine chinesischen/japanischen/koreanischen Werbetexte und keine Lieferanten-SKUs oder Rohcodes wie Style A, G17 A oder L007 Set A im sichtbaren Text. Die Beschreibung muss vollständiges HTML mit 3 bis 5 Absätzen plus 5 bis 7 konkreten Vorteilen enthalten und mindestens 900 Zeichen reinen Text ergeben; ideal sind 1200 bis 1800 Zeichen. Erstelle außerdem natürlichen SEO-Titel, SEO-Beschreibung, sauberen Handle und 5 bis 10 deutsche Tags. Ausgabe ausschließlich JSON mit title,description,shortDescription,bullets,seoTitle,seoDescription,handle,tags,category.';
 const payload=JSON.stringify(input,null,2);
 async function call(extra){
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:(extra||'')+'Verarbeite dieses Produkt und gib NUR gültiges JSON zurück.\\n'+payload}]}],text:{format:{type:'json_object'}},max_output_tokens:2200})});
  const raw=await r.text();let d={};try{d=JSON.parse(raw);}catch{throw Object.assign(new Error('OpenAI returned non-JSON HTTP '+r.status),{status:502});}
  if(!r.ok)throw Object.assign(new Error(d?.error?.message||'OpenAI request failed'),{status:502});
  const text=d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'';
  return cleanJson(text);
 }
 try{let p=await call('');if(homestroPlain(p.description).length<900)p=await call('QUALITÄTS-RETRY: Die Beschreibung war zu kurz. Erzeuge zwingend mindestens 900 Zeichen reinen deutschen Text, 3 bis 5 Absätze und 5 bis 7 konkrete Vorteile.');p=homestroSanitizeProduct(p,input);if(homestroPlain(p.description).length<900)throw new Error('AI description shorter than 900 characters');return{model,product:p};}catch(e){let p=await call('QUALITÄTS-RETRY: Erzeuge ausschließlich eine vollständige deutsche Produktbeschreibung mit mindestens 900 Zeichen, 3 bis 5 Absätzen und 5 bis 7 konkreten Vorteilen. Keine Emojis und keine Lieferantencodes.');p=homestroSanitizeProduct(p,input);if(homestroPlain(p.description).length<900)throw new Error('AI description shorter than 900 characters');return{model,product:p};} 
}
app.post('/api/ai/product',apiKey,async(req,res)=>{try{res.json({ok:true,...await aiProduct(req.body?.product||req.body)});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
function absoluteUrl(u,base){try{return new URL(u,base).href;}catch{return null;}}
async function extractAliExpressDetails(url){
 const out={image_urls:[],variants:[],options:[],page_title:'',page_text:'',euWarehouse:false,costEur:NaN,sold:0};
 try{
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; HomestroCatalog/4.1)','Accept-Language':'en-US,en;q=0.9'},redirect:'follow'});
  if(!r.ok)return out;
  const html=await r.text();
  const strip=new RegExp('<script[^>]*>[\\s\\S]*?</script>','gi');
  const style=new RegExp('<style[^>]*>[\\s\\S]*?</style>','gi');
  out.page_text=html.replace(strip,' ').replace(style,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,20000);
  const titleMatch=html.match(new RegExp('<title[^>]*>([\\s\\S]*?)</title>','i'));
  out.page_title=String(titleMatch?.[1]||'').replace(/<[^>]+>/g,' ').trim();
  const urls=[];
  const add=u=>{try{let v=String(u).replace(/\\\\u002F/g,'/').replace(/\\\\u0026/g,'&').replace(/\\\\\//g,'/');if(/^https?:\/\//i.test(v))urls.push(v.replace(/\\\\/g,''));}catch{}};
  let m;
  const metaRe=new RegExp("<meta[^>]+(?:property|name)=\"(?:og:image|twitter:image)\"[^>]+content=\"([^\"]+)\"[^>]*>","gi");
  while((m=metaRe.exec(html))&&urls.length<12)add(m[1]);
  const jsonImageRe=new RegExp('"(?:image|images|imageUrl|imageURL)"\\s*:\\s*"(https?:[^"\\\\]+)"','gi');
  while((m=jsonImageRe.exec(html))&&urls.length<40)add(m[1]);
  const imgRe=new RegExp("(?:src|data-src|data-original)=\"(https?:[^\"]+)\"","gi");
  while((m=imgRe.exec(html))&&urls.length<60)add(m[1]);
  out.image_urls=[...new Set(urls.filter(u=>!/logo|icon|avatar|sprite/i.test(u)))].slice(0,20);

  const valueMap=new Map(),optionDefs=[];
  const optRe=new RegExp('"skuPropertyName"\\s*:\\s*"([^"]+)"[\\s\\S]{0,12000}?"skuPropertyValues"\\s*:\\s*\\[([\\s\\S]*?)\\]','gi');
  while((m=optRe.exec(html))&&optionDefs.length<3){
   const name=m[1].trim(),vals=[];
   let vm;const vr=new RegExp('"propertyValueId"\\s*:\\s*"?([0-9]+)"?[\\s\\S]{0,500}?"propertyValueDisplayName"\\s*:\\s*"([^"]+)"','gi');
   while((vm=vr.exec(m[2]))&&vals.length<100){
    const id=vm[1],label=vm[2].trim();if(!valueMap.has(id))valueMap.set(id,{name:label,option:name});
    if(!vals.some(v=>v.name===label))vals.push({name:label,id});
   }
   if(vals.length)optionDefs.push({name,values:vals.map(v=>v.name)});
  }
  out.options=optionDefs;
  const combos=[],seen=new Set();
  const skuRe=new RegExp('"([0-9]+(?::[0-9]+)+)"\\s*:\\s*\\{[\\s\\S]{0,2500}?"skuId"\\s*:','g');
  while((m=skuRe.exec(html))&&combos.length<100){
   const parts=m[1].split(':').map(id=>valueMap.get(id)).filter(Boolean);
   if(parts.length){const combo=parts.map(v=>({optionName:v.option,name:v.name}));const key=JSON.stringify(combo);if(!seen.has(key)){seen.add(key);combos.push(combo);}}
  }
  out.variants=combos;
  {
    const priceKeys=[...html.matchAll(/"(?:price|salePrice|discountPrice|formattedPrice|currentPrice|productPrice|minPrice|maxPrice|skuPrice|originalPrice)"\s*:\s*(?:"|')?([0-9]{1,3}(?:[.,][0-9]{1,2})?)/gi)].map(m=>Number(String(m[1]).replace(',','.'))).filter(n=>Number.isFinite(n)&&n>=2&&n<=100);
    const prices=[...html.matchAll(/(?:price|salePrice|discountPrice|formattedPrice|currentPrice|productPrice|minPrice|maxPrice|skuPrice|originalPrice)[^0-9]{0,100}(?:EUR|€|\$)?\s*([0-9]{1,3}(?:[.,][0-9]{1,2})?)/gi)].map(m=>Number(String(m[1]).replace(',','.'))).filter(n=>Number.isFinite(n)&&n>=2&&n<=100);
    const eur=[...html.matchAll(/(?:€|EUR)\s*([0-9]{1,3}(?:[.,][0-9]{1,2})?)/gi)].map(m=>Number(String(m[1]).replace(',','.'))).filter(n=>Number.isFinite(n)&&n>=2&&n<=100);
    const eurAfter=[...html.matchAll(/([0-9]{1,3}(?:[.,][0-9]{1,2})?)\s*(?:€|EUR)/gi)].map(m=>Number(String(m[1]).replace(',','.'))).filter(n=>Number.isFinite(n)&&n>=2&&n<=100);
    if([...priceKeys,...prices,...eur,...eurAfter].length)out.costEur=Math.min(...priceKeys,...prices,...eur,...eurAfter);
    const sold=[...html.matchAll(/([0-9]+(?:[.,][0-9]+)?\s*[kKmMbB]?)\+?\s*(?:orders|sold|sales|units?)/gi)].map(m=>catalogNum(m[1])).filter(Number.isFinite);
    const orders=[...html.matchAll(/"(?:orders|orderCount|tradeCount|sold|sales)"\s*:\s*"?(\d+(?:[.,]\d+)?\s*[kKmMbB]?)"?/gi)].map(m=>catalogNum(m[1])).filter(Number.isFinite);
    out.sold=Math.max(0,...sold,...orders);
  }
  {
    const euNames='Germany|Deutschland|Poland|Polen|Czech(?:ia| Republic)|Tschechien|France|Frankreich|Spain|Spanien|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich|EU|European Union|Europäische Union';
    const euCodes='DE|PL|CZ|ES|FR|IT|NL|BE|AT';
    const nearLabel=new RegExp('(?:ships?\\s*from|shipFrom|shippingFrom|warehouse(?:Location)?|deliverFrom)[^]{0,300}?(?:'+euNames+'|'+euCodes+')','i');
    const reverse=new RegExp('(?:'+euNames+'|'+euCodes+')[^]{0,180}?(?:ships?\\s*from|shipFrom|shippingFrom|warehouse(?:Location)?|deliverFrom)','i');
    out.euWarehouse=nearLabel.test(html)||reverse.test(html)||nearLabel.test(out.page_text)||reverse.test(out.page_text);
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
 try{const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:url,detail:'high'}]}],max_output_tokens:180})});const raw=await r.text();const d=JSON.parse(raw);if(!r.ok)return false;const out=cleanJson(d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'{}');return out.relevant===true&&out.hasForeignText!==true&&out.lowQuality!==true&&Number(out.confidence)>=0.85;}catch{return false;}
}

async function generateHomestroImage(input,title,pageContext){
 if(!process.env.OPENAI_API_KEY) return null;
 const model=process.env.OPENAI_IMAGE_MODEL||'gpt-image-1';
 const prompt='Create a clean, realistic premium e-commerce product photo for Homestro.de. Show ONLY the actual product described below, centered and clearly visible, suitable for a German online shop. No text anywhere in the image, no letters, no numbers, no Chinese/Japanese/Korean characters, no English, no logos, no watermark, no labels, no packaging with writing, no UI, no collage. Neutral professional studio background, natural realistic lighting, product-focused, photorealistic. Product: '+String(title||input?.title||'').slice(0,500)+'. Category: '+String(input?.category||input?.productType||'').slice(0,300)+'. Source context: '+String(pageContext||'').slice(0,2500);
 try{
  const r=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,prompt,size:'1024x1024',n:1})});
  const raw=await r.text();let d={};try{d=JSON.parse(raw);}catch{return null;}
  if(!r.ok||!d.data?.[0]?.b64_json)return null;
  return 'data:image/png;base64,'+d.data[0].b64_json;
 }catch{return null;}
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
 const fileCreate=await shopifyGraphQL('mutation($files:[FileCreateInput!]!){fileCreate(files:$files){files{id fileStatus alt} userErrors{field message}}}',{files:[{alt:String(title||'Homestro Produkt'),contentType:'IMAGE',originalSource:target.resourceUrl}]},token);
 const fe=fileCreate.fileCreate.userErrors||[]; if(fe.length)throw Object.assign(new Error('Shopify fileCreate failed.'),{status:400,details:fe});
 const fileId=fileCreate.fileCreate.files?.[0]?.id; if(!fileId)throw new Error('Shopify did not return generated image file ID.');
 for(let i=0;i<8;i++){
  const q=await shopifyGraphQL('query($id:ID!){node(id:$id){... on MediaImage{id image{url}}}}',{id:fileId},token);
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
async function setSeo(productId,seo,token){if(!seo?.title&&!seo?.description)return null;const input={id:productId,seo:{title:String(seo.title||'').slice(0,70),description:String(seo.description||'').slice(0,320)}};const d=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id seo{title description}}userErrors{field message}}}',{input},token);if(d.productUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected SEO data.'),{status:400,details:d.productUpdate.userErrors});return d.productUpdate.product;}
async function setProductTags(productId,tags,token){const arr=Array.isArray(tags)?tags.map(String).filter(Boolean):[];if(!arr.length)return null;const d=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id tags}userErrors{field message}}}',{input:{id:productId,tags:arr}},token);if(d.productUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected product tags.'),{status:400,details:d.productUpdate.userErrors});return d.productUpdate.product;}
async function setVariantPricing(productId,price,cost,token){if(!Number.isFinite(price)&&!Number.isFinite(cost))return null;const q='{product(id:"'+productId.replace(/"/g,'\\"')+'"){variants(first:1){nodes{id}}}}';const d0=await shopifyGraphQL(q,{},token),id=d0.product?.variants?.nodes?.[0]?.id;if(!id)return null;const variant={id};if(Number.isFinite(price))variant.price=String(price);if(Number.isFinite(cost))variant.inventoryItem={cost:Number(cost)};const d=await shopifyGraphQL('mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){product{id variants(first:1){nodes{id price inventoryItem{unitCost{amount currencyCode}}}}}userErrors{field message}}}',{productId,variants:[variant]},token);if(d.productVariantsBulkUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected price/cost.'),{status:400,details:d.productVariantsBulkUpdate.userErrors});return d.productVariantsBulkUpdate.product;}
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
async function updateVariants(productId,variants,token){const normalized=(Array.isArray(variants)?variants:[]).map(v=>({id:String(v.id||''),optionValues:(v.optionValues||[]).map(o=>({optionName:String(o.optionName||''),name:String(o.name||'')}))})).filter(v=>v.id&&v.optionValues.length&&v.optionValues.every(o=>o.optionName&&o.name));if(!productId||!normalized.length)throw Object.assign(new Error('productId and valid variants are required.'),{status:400});const d=await shopifyGraphQL('mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){product{id title options{id name optionValues{id name}}variants(first:100){nodes{id title selectedOptions{name value}image{id url altText}}}}userErrors{field message}}}',{productId,variants:normalized},token);if(d.productVariantsBulkUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected the variant update.'),{status:400,details:d.productVariantsBulkUpdate.userErrors});return d.productVariantsBulkUpdate.product;}
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
 let n=Number(x); if(!Number.isFinite(n))return NaN;
 if(suffix==='k')n*=1000; else if(suffix==='m')n*=1000000; else if(suffix==='b')n*=1000000000;
 return Number.isFinite(n)?n:NaN;
}
async function catalogSearch(keyword){
  const out=[],ids=new Set();
  const addId=(id,context='',extra={})=>{id=String(id||'').replace(/[^0-9]/g,'');if(id.length<8||ids.has(id))return;ids.add(id);const ctx=String(context||'');const euEvidence=/(EU\\s*stock|EU\\s*warehouse|ships?\\s*from\\s*(?:Germany|Poland|Czech(?:ia| Republic)|Spain|France|Italy|Netherlands|Belgium|Austria)|\\b(?:Germany|Poland|Czechia|Czech Republic|Spain|France|Italy|Netherlands|Belgium|Austria)\\s*(?:warehouse|stock))/i.test(ctx);const soldMatch=ctx.match(/(?:orders?|sold|sales|units?|verkauft)\s*[:：]?\s*([0-9][0-9.,]*\s*[kmb]?\+?)/i)||ctx.match(/([0-9][0-9.,]*\s*[kmb]?\+?)\s*(?:orders?|sold|sales|units?)/i);const costMatch=ctx.match(/(?:EUR|€|\$)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i)||ctx.match(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:EUR|€)/i);out.push({id,title:extra.title||keyword,cost:Number.isFinite(extra.cost)?extra.cost:(costMatch?catalogNum(costMatch[1]):NaN),sold:Number(extra.sold||0)||(soldMatch?catalogNum(soldMatch[1]):0),image_urls:extra.image_urls||[],source_url:'https://www.aliexpress.com/item/'+id+'.html',context:ctx,euWarehouse:extra.euWarehouse===true||euEvidence});};

  // Verified launch seed: PandaFind found this AliExpress item explicitly labelled EU Stock,
  // with 2,457 units sold and EUR 15.48 at discovery time. Keep it as a starter while
  // live AliExpress HTML/search access is repaired. It is still re-checked by detail fetch.
  if(/headphone|earphone|earbud|kopfhörer|ohrhörer|bluetooth|wireless|ai/i.test(keyword)){
    addId('1005008550894374','PandaFind EU Stock seed',{title:'Soundcore P20I Wireless Bluetooth 5.3 Earbuds EU Stock',cost:15.48,sold:2457,euWarehouse:true});
  }

  const parseAli=(html)=>{
    const normalized=String(html||'').replace(/&amp;/g,'&').replace(/&#x2F;/gi,'/').replace(/\\u002F/g,'/').replace(/\\\//g,'/');
    const re=/(?:productId|product_id|productIdStr|itemId|item_id)\s*["']?\s*[:=]\s*["']?(\d{8,})/gi;let m;
    while((m=re.exec(normalized))&&ids.size<1000)addId(m[1],normalized.slice(Math.max(0,m.index-5000),Math.min(normalized.length,m.index+7000)));
    const ur=/(?:aliexpress[^"'<>]{0,180})?(?:item\/|\/item\/)(\d{8,})(?:\.html)?/gi;
    while((m=ur.exec(normalized))&&ids.size<1000)addId(m[1],normalized.slice(Math.max(0,m.index-5000),Math.min(normalized.length,m.index+7000)));
    const shortUrl=/(?:aliexpress[^"'<>]{0,180})(?:\/i\/|\/item\/)(\d{8,})/gi;
    while((m=shortUrl.exec(normalized))&&ids.size<1000)addId(m[1],normalized.slice(Math.max(0,m.index-5000),Math.min(normalized.length,m.index+7000)));
  };

  const fetchText=async(url,headers={})=>{
    try{const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36','Accept-Language':'de-DE,de;q=0.9,en;q=0.8','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',...headers},redirect:'follow'});const html=await r.text();return r.ok?html:'';}catch{return '';}
  };

  const slug=encodeURIComponent(keyword).replace(/%20/g,'-');
  const aliUrls=[
    'https://www.aliexpress.com/w/wholesale-'+slug+'.html?g=y&page=1',
    'https://www.aliexpress.com/w/wholesale-'+slug+'.html?page=2',
    'https://www.aliexpress.com/w/wholesale-'+slug+'.html?SearchText='+encodeURIComponent(keyword),
    'https://www.aliexpress.com/wholesale?SearchText='+encodeURIComponent(keyword)+'&page=1',
    'https://www.aliexpress.com/wholesale?SearchText='+encodeURIComponent(keyword)+'&page=2'
  ];
  for(const url of aliUrls){const html=await fetchText(url);if(html.length>5000)parseAli(html);if(out.length>=120)break;}

  // Search-engine fallbacks. These often survive AliExpress anti-bot pages and give real item IDs.
  if(out.length<8){
    const queries=['site:aliexpress.com/item/ '+keyword,'site:aliexpress.com/item '+keyword+' orders','site:aliexpress.com '+keyword+' EU stock'];
    const sources=[];
    for(const query of queries){const q=encodeURIComponent(query);sources.push('https://www.bing.com/search?q='+q+'&count=50');sources.push('https://www.google.com/search?q='+q+'&num=50');sources.push('https://html.duckduckgo.com/html/?q='+q);}
    for(const u of sources){
      const html=await fetchText(u,{'Accept-Language':'en-US,en;q=0.9'});
      if(html)parseAli(html);
      if(out.length>=80)break;
    }
  }

  // Enrich real IDs from AliExpress detail pages. If a seeded EU-stock product is blocked,
  // retain the seed data but do not invent new EU warehouse evidence.
  for(const x of out.slice(0,120)){
    try{
      const d=await extractAliExpressDetails(x.source_url);
      if(d.page_title)x.title=d.page_title;
      if(Number.isFinite(d.costEur)&&d.costEur>0)x.cost=d.costEur;
      if(Number.isFinite(d.sold)&&d.sold>0)x.sold=d.sold;
      if(Array.isArray(d.image_urls))x.image_urls=d.image_urls.slice(0,3);
      if(d.euWarehouse===true)x.euWarehouse=true;
    }catch{}
  }
  console.log('CATALOG SOURCE',keyword,'items='+out.length);
  return out;
}
function catalogPassReason(x){
 const r=rules(),cost=Number(x.cost),title=String(x.title||'').toLowerCase();
 if(!String(x.source_url||'').trim()||!String(x.id||'').trim())return 'missing-id-or-url';
 const isHeadphone=/(earphone|earbuds?|headphone|headset|bluetooth headphones?|wireless headphones?|ai headphones?|kopfhörer|ohrhörer)/i.test(title);
 const bad=/(smartwatch|watch phone|charger|cable|usb|led strip|camera|drone|gaming|projector|power bank|electronic|elektronik|speaker|lautsprecher)/i.test(title);
 if(bad&&!isHeadphone)return 'blocked-electronics';
 const junk=/(hook|hooks|hanging hook|adhesive hook|haken|box|boxes|storage box|organizer|organiser|aufbewahrung|rack|shelf|shelves|regal|holder|halter|stand|case|cover|bag|pouch|tasche|etui|hülle|keychain|key ring|schlüsselanhänger|sticker|decal|ornament|decoration|decor|deko|wall art|phone case|cable holder|clip|clamp|bracket)/i.test(title);
 if(junk)return 'junk-generic-accessory';
 const isKnife=/(kitchen knives?|chef knives?|cooking knives?|kitchen knife|messer küche|küchenmesser)/i.test(title);
 const practical=/(clean|cleaning|reinig|kitchen|küche|cook|kochen|knife|messer|laundry|wäsche|car|auto|garden|garten|tool|werkzeug|repair|repar|pet|hund|dog|cat|katze|fitness|sport|baby|beauty|pflege|travel|reise|camping|office|büro|headphone|earphone|earbud|kopfhörer|ohrhörer|bluetooth|wireless|ai)/i.test(title);
 if(!practical)return 'not-practical';
 const maxCost=isHeadphone?27:Number(r.maxCost||10),minCost=isHeadphone?10:5;
 if(!Number.isFinite(cost)||cost<minCost||cost>maxCost)return 'cost-outside-range:'+String(cost);
 if(Number(x.sold||0)<2000)return 'sold-under-2000:'+String(x.sold||0);
 if(/(clothing|shoe|shoes|dress|jacket|shirt|pants|bra|underwear|swimwear|battery|laser|weapon|hunting knife|tactical knife|survival knife|pocket knife|butterfly knife|switchblade|medical|supplement|toy|plush|jewelry|necklace|ring|bracelet|wallet|mug|cup|bottle|towel|sock|slipper|curtain|pillow|flower|vase|generic|replacement|spare part)/i.test(title)&&!isKnife)return 'blocked-category';
 const problem=/(clean|cleaning|reinig|stain|scrub|remove|repair|repar|fix|measure|cut|knife|messer|sharpen|organize|wash|laundry|pet hair|groom|training|pain relief|posture|exercise|grip|safety|protect|travel|camping|outdoor|car care|detailing|garden|prun|weed|drill|screw|paint|baking|cook|slice|peel|seal|vacuum|dust|steam|headphone|earphone|earbud|kopfhörer|ohrhörer|bluetooth|wireless|ai)/i.test(title);
 if(!problem)return 'no-problem-signal';
 const targetPrice=isHeadphone?Math.max(69.90,Math.ceil(cost*2.9*100)/100):Math.max(39.90,Math.ceil(cost*3.5*100)/100);
 const ebay=ebayProfitability({selling_price:targetPrice,landed_cost_eur:cost});
 if(Number(ebay.estimatedProfitEur||0)<12)return 'profit-under-12:'+String(Math.round(ebay.estimatedProfitEur||0));
 if(targetPrice/cost<Math.max(r.minRatio,isHeadphone?2.9:3.5))return 'ratio-too-low';
 return '';
}
function catalogPass(x){return !catalogPassReason(x);}

function isDsersImportedCandidate(product){
 const status=String(product?.status||'').toUpperCase();
 if(status!=='DRAFT')return false;
 const tags=(Array.isArray(product?.tags)?product.tags:[]).map(String).join(' ');
 const desc=String(product?.description||'');
 const mf=Array.isArray(product?.metafields)?product.metafields:[];
 const values=mf.map(x=>String(x?.value||'')).join(' ');
 const all=tags+' '+desc+' '+values;
 // Without the DSers API, the reliable source marker we can enforce is an AliExpress item URL
 // carried by the imported Shopify product. Products without this marker are never touched.
 return new RegExp('https?:\\\\/\\\\/(?:www\\.)?aliexpress\\\\.com\\\\/item\\\\/\\\\d+\\\\.html','i').test(all);
}

async function processExistingDraftProduct(productId,token){
 const d=await shopifyGraphQL('query($id:ID!){product(id:$id){id title description vendor productType tags status variants(first:100){nodes{id title price sku selectedOptions{name value} inventoryItem{unitCost{amount currencyCode}}}} metafields(first:20,namespace:"homestro"){nodes{key value}} media(first:30){nodes{mediaContentType status alt}}}}',{id:productId},token);
 const p=d.product;if(!p)throw new Error('Product not found');if(String(p.status)!=='DRAFT')throw new Error('Safety guard: only DRAFT products may be modified');if(!isDsersImportedCandidate(p))throw new Error('Safety guard: DRAFT is not recognized as a DSers/AliExpress import; skipped');
 const mf=Object.fromEntries((p.metafields?.nodes||[]).map(x=>[x.key,String(x.value||'')]));
 const desc=String(p.description||'');
 const srcMatch=desc.match(new RegExp("https?://(?:www\\\\.)?aliexpress\\\\.com/item/\\\\d+\\\\.html[^\\\\s<]*","i"));
 const src=mf.aliexpress_url || (srcMatch?.[0]||'');
 const idMatch=src.match(new RegExp("/item/(\\\\d+)\\\\.html","i"));
 const id=mf.aliexpress_product_id || (idMatch?.[1]||'');
 let details={page_title:'',page_text:'',image_urls:[],variants:[],options:[],euWarehouse:false};
 if(src&&id){
  details=await extractAliExpressDetails(src);
  if(!details.page_title||!details.page_text)throw new Error('AliExpress source data unavailable');
 }
 const price=Number(p.variants?.nodes?.[0]?.price||0);
 const cost=Number(p.variants?.nodes?.[0]?.inventoryItem?.unitCost?.amount||NaN);
 const ratio=cost>0&&price>0?price/cost:NaN;
 const profitability=ebayProfitability({selling_price:price,landed_cost_eur:cost});
 const profitPending=!profitability.valid;
 const ai=await aiProduct({
  title:details.page_title||p.title,
  description:(details.page_text||desc||'Shopify-Draft ohne Lieferantenquelle').slice(0,7000),
  category:p.productType,
  source_url:src||'',
  source_product_id:id||'',
  variants:details.variants||[],
  options:details.options||[],
  image_urls:details.image_urls||[],
  cost,selling_price:price
 });
 const x=homestroSanitizeProduct(ai.product||{}, {title:p.title,category:p.productType});
 if(!x.title)throw new Error('AI returned no title');
 if(homestroPlain(x.description).length<900)throw new Error('Existing draft failed 900-character description gate');
 const baseTags=Array.isArray(x.tags)?x.tags:[];
 const oldTags=Array.isArray(p.tags)?p.tags:[];
 const tags=[...new Set([...oldTags.filter(t=>!['homestro-ai-failed-existing'].includes(String(t))),...baseTags,'homestro-ai-processed-existing',...(profitPending?['homestro-profit-pending']:['homestro-profit-checked'])])];
 const input={id:productId,title:String(x.title),descriptionHtml:String(x.description||p.description),tags,seo:{title:String(x.seoTitle||x.title).slice(0,70),description:String(x.seoDescription||'').slice(0,320)}};
 if(src&&id){input.metafields=[{namespace:'homestro',key:'aliexpress_url',type:'single_line_text_field',value:src},{namespace:'homestro',key:'aliexpress_product_id',type:'single_line_text_field',value:id}];}
 const upd=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id title description seo{title description} tags}userErrors{field message}}}',{input},token);
 if(upd.productUpdate.userErrors?.length)throw new Error(upd.productUpdate.userErrors.map(e=>e.message).join('; '));
 let media={count:0,validation:'not-run'};
 if(src&&details.image_urls?.length)media=await addMedia(productId,{source_url:src,image_urls:details.image_urls},x.title,token);
 return {id:productId,title:x.title,source_url:src||null,source_product_id:id||null,images:media.count,variants:details.variants.length,price,cost,ratio,profitPending,estimatedProfitEur:profitability.estimatedProfitEur,processed:true,mediaValidation:media.validation};
}
async function processExistingDrafts(limit,token){
 const d=await shopifyGraphQL('query($first:Int!,$query:String){products(first:$first,query:$query){nodes{id title status description vendor tags metafields(first:20){nodes{key value}}}}}',{first:50,query:'status:draft'},token);
 const eligible=d.products.nodes.filter(isDsersImportedCandidate).filter(p=>!p.tags?.includes('homestro-ai-processed-existing')&&!p.tags?.includes('homestro-ai-failed-existing')).slice(0,Math.min(Math.max(Number(limit)||5,1),10));
 const results=[];
 for(const p of eligible){
  try{results.push(await processExistingDraftProduct(p.id,token));}
  catch(e){
   try{
    const current=await shopifyGraphQL('query($id:ID!){product(id:$id){tags}}',{id:p.id},token);
    const tags=[...new Set([...(current.product?.tags||[]),'homestro-ai-failed-existing'])];
    await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id tags}userErrors{message}}}',{input:{id:p.id,tags}},token);
   }catch{}
   results.push({id:p.id,title:p.title,processed:false,error:e.message});
  }
 }
 return results;
}
const draftAutopilotState={running:false,lastRun:null,lastError:null,processed:0,skipped:0};
function draftAutopilotInterval(){const n=Number(process.env.HOMESTRO_AUTOPILOT_INTERVAL_MS||300000);return Number.isFinite(n)&&n>=60000?n:300000;}
async function draftAutopilotRun(){
 if(draftAutopilotState.running)return;
 draftAutopilotState.running=true;
 try{
  const token=await getClientToken();
  const d=await shopifyGraphQL('query{products(first:50,query:"status:draft"){nodes{id title status description vendor tags metafields(first:20){nodes{key value}}}}}',{},token);
  const nodes=d.products.nodes||[];
  draftAutopilotState.skipped=nodes.filter(p=>!isDsersImportedCandidate(p)).length;
  const eligible=nodes.filter(isDsersImportedCandidate).filter(p=>!p.tags?.includes('homestro-ai-processed-existing')&&!p.tags?.includes('homestro-ai-failed-existing')).slice(0,5);
  let done=0;
  for(const p of eligible){
   try{await processExistingDraftProduct(p.id,token);done++;}
   catch(e){console.error('DRAFT AUTOPILOT PRODUCT FAILED',p.id,e.message);}
  }
  draftAutopilotState.processed+=done;
  draftAutopilotState.lastRun=new Date().toISOString();
  draftAutopilotState.lastError=null;
  console.log('DRAFT AUTOPILOT COMPLETE','eligible='+eligible.length,'processed='+done,'skipped='+draftAutopilotState.skipped);
 }catch(e){draftAutopilotState.lastRun=new Date().toISOString();draftAutopilotState.lastError=e.message;console.error('DRAFT AUTOPILOT FAILED',e.message);}
 finally{draftAutopilotState.running=false;}
}


async function catalogRun(){
 if(catalogState.running)return;
 catalogState.running=true;
 let rejected=0,failed=0;
 try{
  const batch=Math.max(1,Number(process.env.HOMESTRO_CANDIDATE_BATCH||process.env.HOMESTRO_CATALOG_BATCH||100));
  const candidates=[];
  // Deduplicate only within the current scan. Persistent seen IDs caused valid products to be permanently skipped.
  const runSeen=new Set();
  const titleSeen=new Set();
  const keywordCounts=new Map();
  for(const k of catalogKeywords){
   if(candidates.length>=batch)break;
   let items=[];
   try{items=await catalogSearch(k);}catch(e){failed++;console.error('CATALOG SOURCE FAILED',k,e.message);continue;}
   for(const x of items){
    if(candidates.length>=batch)break;
    if(runSeen.has(x.id))continue;
    runSeen.add(x.id);
    catalogState.seen.add(x.id);
    // Source-search titles are often only the keyword. Do not apply title/category gates
    // until the real AliExpress detail page has supplied the product title.
    const preCost=Number(x.cost), preSold=Number(x.sold||0);
    // Search-result snippets are often incomplete. Unknown cost/sales must be enriched
    // from the real detail page before rejection; only explicit bad values are rejected here.
    if(Number.isFinite(preCost)&&preCost<=0){rejected++;continue;}
    // Never reject on search-result sales: the snippet can contain stale or partial order data.
    // The authoritative sold count is taken from the real detail page below.
    const isHeadphoneCandidate=/(earphone|earbuds?|headphone|headset|bluetooth headphones?|wireless headphones?|ai headphones?|kopfhörer|ohrhörer)/i.test(String(x.title||'')); const selling=isHeadphoneCandidate?Math.max(39.90,Math.ceil(Number(x.cost)*2.9*100)/100):Math.max(39.90,Math.ceil(Number(x.cost)*3.5*100)/100);
    const ebay=ebayProfitability({selling_price:selling,landed_cost_eur:Number(x.cost)});
    const candidate={id:String(x.id),keyword:k,title:String(x.title||'').trim(),url:String(x.source_url),costEur:Number(x.cost),sellingPriceEur:selling,sold:Number(x.sold||0),ratio:Number((selling/Number(x.cost)).toFixed(2)),euWarehouse:null,estimatedProfitBeforeShippingVat:Number(ebay.estimatedProfitEur||0),note:'Preisfilter bestanden. Versand/DPH/Servicekosten aus DSers müssen vor Verkauf geprüft werden.'};
    try{
     const details=await extractAliExpressDetails(x.source_url);
     candidate.title=String(details.page_title||candidate.title).trim();
     candidate.euWarehouse=(details.euWarehouse===true)||(x.euWarehouse===true);
     if(Number.isFinite(details.costEur)&&details.costEur>0){candidate.costEur=details.costEur;const hp=/(earphone|earbuds?|headphone|headset|bluetooth headphones?|wireless headphones?|ai headphones?|kopfhörer|ohrhörer)/i.test(candidate.title);candidate.sellingPriceEur=hp?Math.max(69.90,Math.ceil(details.costEur*2.9*100)/100):Math.max(39.90,Math.ceil(details.costEur*3.5*100)/100);}
     if(Number.isFinite(details.sold)&&details.sold>0)candidate.sold=details.sold;
     if(candidate.euWarehouse!==true){
       if(x.euWarehouse===true)candidate.euWarehouse=true;
       else continue;
     }
    }catch(e){
     if(x.euWarehouse!==true){candidate.note+=' AliExpress Detaildaten konnten nicht vollständig geladen werden.';continue;}
     candidate.euWarehouse=true;
    }
    // Re-apply the economic filter after detail enrichment so changed live data cannot bypass the rules.
    const finalReason=catalogPassReason({id:x.id,title:candidate.title,cost:candidate.costEur,sold:candidate.sold,source_url:candidate.url,euWarehouse:candidate.euWarehouse});
    if(finalReason){
      console.log('CATALOG REJECT',k,x.id,'reason='+finalReason,'title='+String(candidate.title||'').slice(0,120),'cost='+candidate.costEur,'sold='+candidate.sold,'eu='+candidate.euWarehouse);
      rejected++; continue;
    }
    const finalHp=/(earphone|earbuds?|headphone|headset|bluetooth headphones?|wireless headphones?|ai headphones?|kopfhörer|ohrhörer)/i.test(candidate.title);
    candidate.sellingPriceEur=finalHp?Math.max(69.90,Math.ceil(candidate.costEur*2.9*100)/100):Math.max(39.90,Math.ceil(candidate.costEur*3.5*100)/100);
    candidate.ratio=Number((candidate.sellingPriceEur/candidate.costEur).toFixed(2));
    const finalEbay=ebayProfitability({selling_price:candidate.sellingPriceEur,landed_cost_eur:candidate.costEur});
    candidate.estimatedProfitBeforeShippingVat=Number(finalEbay.estimatedProfitEur||0);
    const titleKey=String(candidate.title||'').toLowerCase().replace(/[^a-z0-9äöüß]+/g,' ').trim();
    const keyCount=Number(keywordCounts.get(k)||0);
    if(titleSeen.has(titleKey)||keyCount>=5)continue;
    titleSeen.add(titleKey);
    keywordCounts.set(k,keyCount+1);
    candidates.push(candidate);
   }
  }
  catalogState.candidates=candidates;
  catalogState.rejected+=rejected;
  catalogState.lastRun=new Date().toISOString();
  catalogState.lastError=null;
  console.log('CATALOG CANDIDATE RUN COMPLETE','candidates='+candidates.length,'rejected='+rejected,'failed='+failed);
 }catch(e){catalogState.lastRun=new Date().toISOString();catalogState.lastError=e.message;console.error('CATALOG RUN FAILED',e.message);}
 finally{catalogState.running=false;}
}

app.get('/api/catalog/candidates',apiKey,(_q,res)=>res.json({ok:true,source:'AliExpress',count:catalogState.candidates.length,candidates:catalogState.candidates.map(x=>({url:x.url,title:x.title,costEur:x.costEur,sellingPriceEur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,euWarehouse:x.euWarehouse,estimatedProfitBeforeShippingVat:x.estimatedProfitBeforeShippingVat,note:x.note}))}));
function csvCell(v){const s=String(v??'');return '"'+s.replace(/"/g,'""')+'"';}
function catalogFeedRows(){return catalogState.candidates.map(x=>({id:x.id,title:x.title,url:x.url,cost_eur:x.costEur,selling_price_eur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,eu_warehouse:x.euWarehouse?'TRUE':'FALSE',estimated_profit_eur:x.estimatedProfitBeforeShippingVat,source:'AliExpress',status:'CANDIDATE'}));}
function sendCatalogCsv(res){const rows=catalogFeedRows(),headers=['id','title','url','cost_eur','selling_price_eur','sold','ratio','eu_warehouse','estimated_profit_eur','source','status'];res.set('Content-Type','text/csv; charset=utf-8');res.send('\uFEFF'+headers.join(',')+'\n'+rows.map(r=>headers.map(h=>csvCell(r[h])).join(',')).join('\n'));}
app.get('/feeds/products.csv',(_q,res)=>sendCatalogCsv(res));
app.get('/feeds/google-sheet.csv',(_q,res)=>sendCatalogCsv(res));
app.get('/feeds/youtube.json',(_q,res)=>res.json({ok:true,source:'Homestro candidate feed',generatedAt:new Date().toISOString(),items:catalogState.candidates.map(x=>({title:x.title,productUrl:x.url,hook:'Praktisches Produkt für den Alltag – jetzt bei Homestro entdecken.',description:'Entdecke '+x.title+' bei Homestro.de. Produktdaten und Verfügbarkeit vor dem Verkauf nochmals prüfen.',sellingPriceEur:x.sellingPriceEur}))}));
app.get('/catalog/candidates-public',(_q,res)=>res.json({ok:true,source:'AliExpress',count:catalogState.candidates.length,candidates:catalogState.candidates.map(x=>({url:x.url,title:x.title,costEur:x.costEur,sellingPriceEur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,euWarehouse:x.euWarehouse,estimatedProfitBeforeShippingVat:x.estimatedProfitBeforeShippingVat}))}));

app.post('/api/catalog/process-existing',apiKey,async(req,res)=>{try{const token=await getClientToken();const results=await processExistingDrafts(Math.min(Number(req.body?.limit||10),10),token);res.json({ok:true,results});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
app.get('/api/catalog/process-existing-test',apiKey,async(req,res)=>{try{const token=await getClientToken();const results=await processExistingDrafts(Math.min(Number(req.query?.limit||5),5),token);res.json({ok:true,results});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
app.get('/health/catalog',(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',running:catalogState.running,lastRun:catalogState.lastRun,lastError:catalogState.lastError,totals:{created:catalogState.created,rejected:catalogState.rejected,failed:catalogState.failed}}));
app.get('/api/catalog/status',apiKey,(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',running:catalogState.running,lastRun:catalogState.lastRun,lastError:catalogState.lastError,totals:{created:catalogState.created,rejected:catalogState.rejected,failed:catalogState.failed}}));
app.post('/api/catalog/run',apiKey,async(_q,res)=>{if(catalogState.running)return res.json({ok:true,skipped:true});catalogRun();res.json({ok:true,started:true});});
if(process.env.HOMESTRO_CATALOG_ENABLED!=='false'){setTimeout(()=>catalogRun().catch(e=>console.error('CATALOG AUTO FAILED',e.message)),10000);setInterval(()=>catalogRun().catch(e=>console.error('CATALOG AUTO FAILED',e.message)),catalogInterval());}

app.get('/api/automation/status-public',(_q,res)=>res.json({ok:true,service:'homestro-catalog-autopilot',enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',intervalMs:catalogInterval(),running:catalogState.running,lastRun:catalogState.lastRun,lastError:catalogState.lastError,totals:{created:catalogState.created,rejected:catalogState.rejected,failed:catalogState.failed}}));


app.get('/api/autopilot/status',apiKey,(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false',intervalMs:draftAutopilotInterval(),running:draftAutopilotState.running,lastRun:draftAutopilotState.lastRun,lastError:draftAutopilotState.lastError,processed:draftAutopilotState.processed,skippedNonDsers:draftAutopilotState.skipped}));
if(process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false'){
 setTimeout(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),15000);
 setInterval(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),draftAutopilotInterval());
}

app.listen(PORT,()=>console.log(`Homestro AI Control listening on ${PORT}`));
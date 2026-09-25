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
function rules(){return{maxCost:Number(process.env.MAX_PRODUCT_COST||15),minSellingPrice:Number(process.env.MIN_SELLING_PRICE||34.9),minRatio:Number(process.env.MIN_PRICE_COST_RATIO||3)};}
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
   try{
    const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36','Accept-Language':'de-DE,de;q=0.9,en;q=0.8','Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'},redirect:'follow'});
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
 const id=String(p?.productId||p?.product_id||p?.id||p?.asin||p?.sku||'').trim();
 const url=String(p?.productUrl||p?.product_url||p?.url||p?.detailUrl||p?.detail_url||'').trim();
 const title=String(p?.title||p?.name||p?.productTitle||p?.product_title||keyword||'').trim();
 const cost=homestroSourcePrice(p?.costEur??p?.cost_eur??p?.cost??p?.wholesalePrice??p?.wholesale_price??p?.price);
 const sold=homestroSourceSold(p?.sold??p?.orders??p?.sales??p?.unitsSold??p?.ordersCount??p?.bsrSales);
 const warehouse=String(p?.shipFromCountry??p?.ship_from_country??p?.warehouseCountry??p?.warehouse_country??p?.warehouse??p?.fulfillmentCountry??p?.fulfillment_country??'').trim();
 const eu=Boolean(p?.euWarehouse??p?.eu_warehouse??p?.euStock??p?.eu_stock)||homestroEuWarehouseValue(warehouse)||Boolean(p?.isFba||p?.amazonFba);
 return {id:id||('ext-'+crypto.createHash('sha1').update(sourceType+'|'+title+'|'+url).digest('hex').slice(0,16)),title,cost,sold,url,source_url:url,costEur:cost,euWarehouse:eu,warehouse,source_type:sourceType,source_role:sourceType==='amazon-fba'?'market_reference':'supplier',context:JSON.stringify(p).slice(0,12000),evidence:warehouse?'external source warehouse='+warehouse:'external source'};
}

async function homestroApifySourceSearch(keyword){
 const token=String(process.env.APIFY_API_TOKEN||'').trim();
 if(!token)return [];
 const out=[];
 const jobs=[
  ['APIFY_ALIEXPRESS_ACTOR_ID','aliexpress-apify'],
  ['APIFY_CJ_ACTOR_ID','cj-dropshipping'],
  ['APIFY_BIGBUY_ACTOR_ID','bigbuy'],
  ['APIFY_AMAZON_ACTOR_ID','amazon-fba']
 ];
 for(const [envName,sourceType] of jobs){
  const actor=String(process.env[envName]||'').trim();
  if(!actor)continue;
  const input={
   searchQueries:[keyword],
   queries:[keyword],
   keyword,
   searchKeyword:keyword,
   searchQueries:[keyword],
   startUrls:[{url:'https://www.aliexpress.com/w/wholesale-'+encodeURIComponent(keyword).replace(/%20/g,'-')+'.html'}],
   countryCode:'DE',
   locale:'de-DE',
   maxItems:Number(process.env.APIFY_SOURCE_MAX_ITEMS||25),
   maxResults:Number(process.env.APIFY_SOURCE_MAX_ITEMS||25),
   shipToCountry:'DE',
   warehouses:['DE','PL','CZ','ES','FR','IT','NL','BE','AT'],
   includeShipping:true,
   scrapeFullProductDetails:true,
   includeCustomerReviews:false,
   maxReviewsPerProduct:0,
   proxyConfiguration:{useApifyProxy:true,apifyProxyGroups:['RESIDENTIAL']}
  };
  if(sourceType==='amazon-fba')Object.assign(input,{domain:'amazon.de',marketplace:'DE',primeOnly:true,fulfillment:'FBA'});
  if(sourceType==='cj-dropshipping')Object.assign(input,{warehouse:['DE','PL','ES']});
  if(sourceType==='bigbuy')Object.assign(input,{stockMin:50});
  const rows=await apifyRunActor(actor,input);
  if(sourceType==='aliexpress-apify' && rows[0]) console.log('HOMESTRO_APIFY_SAMPLE_KEYS',JSON.stringify(Object.keys(rows[0]).slice(0,120)));
  for(const p of rows){
   const x=homestroNormalizeExternalItem(p,sourceType,keyword);
   if(x.title&&x.url)out.push(x);
  }
 }
 if(out.length)console.log('HOMESTRO_APIFY_SOURCES',keyword,'items='+out.length,'euConfirmed='+out.filter(x=>x.euWarehouse).length);
 return out;
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
 if(String(x.source_role||'supplier')==='market_reference')return '';
 if(!x.euWarehouse)return 'eu-warehouse-not-confirmed';
 if(!Number.isFinite(Number(x.costEur))||Number(x.costEur)<=0)return 'invalid-cost';
 if(Number(x.sold||0)<Number(process.env.HOMESTRO_EXTERNAL_MIN_SOLD||100))return 'external-sales-under-threshold';
 return '';
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

  if(out.filter(x=>x.euWarehouse===true).length>=Number(process.env.HOMESTRO_API_MIN_EU_CANDIDATES||8)){
    console.log('CATALOG API/FEED SUFFICIENT',keyword,'items='+out.length,'euConfirmed='+out.filter(x=>x.euWarehouse===true).length);
    return out.slice(0,200);
  }
  const cleanText=(html)=>String(html||'')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/\s+/g,' ')
    .trim();

  const plausibleTitle=(t)=>{
    const s=cleanText(t);
    if(!s)return '';
    if(/^(?:ali ?express|search|page not found|access denied|just a moment|something went wrong)$/i.test(s))return '';
    if(/(?:search results|404|not found|access denied)/i.test(s)&&s.length<220)return '';
    if(s.length<8||s.length>500)return '';
    return s;
  };

  const addId=(id,context='',extra={})=>{
    id=String(id||'').replace(/[^0-9]/g,'');
    if(id.length<8||ids.has(id))return;
    ids.add(id);
    const ctx=String(context||'');
    const euEvidence=/(EU\s*stock|EU\s*warehouse|ships?\s*from\s*(?:Germany|Deutschland|Poland|Polen|Czech(?:ia| Republic)|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)|\b(?:Germany|Deutschland|Poland|Polen|Czechia|Czech Republic|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)\s*(?:warehouse|stock))/i.test(ctx);
    const soldMatch=ctx.match(/(?:orders?|sold|sales|units?|verkauft)\s*[:：]?\s*([0-9][0-9.,]*\s*[kmb]?\+?)/i)
      ||ctx.match(/([0-9][0-9.,]*\s*[kmb]?\+?)\s*(?:orders?|sold|sales|units?)/i);
    const costMatch=ctx.match(/(?:EUR|€|\$)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i)
      ||ctx.match(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:EUR|€)/i);

    out.push({
      id,
      title:plausibleTitle(extra.title)||keyword,
      cost:Number.isFinite(extra.cost)?extra.cost:(costMatch?catalogNum(costMatch[1]):NaN),
      sold:Number(extra.sold||0)||(soldMatch?catalogNum(soldMatch[1]):0),
      image_urls:Array.isArray(extra.image_urls)?extra.image_urls:[],
      source_url:'https://www.aliexpress.com/item/'+id+'.html',
      context:ctx,
      evidence:ctx.slice(0,3000),
      euWarehouse:extra.euWarehouse===true||euEvidence,
      source_type:extra.source_type||'unknown'
    });
  };

  if(/headphone|earphone|earbud|kopfhörer|ohrhörer|bluetooth|wireless|ai/i.test(keyword)){
    addId('1005008550894374','PandaFind EU Stock seed',{
      title:'Soundcore P20I Wireless Bluetooth 5.3 Earbuds EU Stock',
      cost:15.48,sold:2457,euWarehouse:true,source_type:'seed'
    });
  }

  const fetchText=async(url,headers={})=>{
    try{
      const r=await fetch(url,{headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept-Language':'de-DE,de;q=0.9,en;q=0.8',
        'Accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        ...headers
      },redirect:'follow'});
      const html=await r.text();
      return r.ok?html:'';
    }catch{return '';}
  };

  const addSearchBlock=(block,source_type)=>{
    const text=cleanText(block);
    if(!text)return;
    const idsFound=new Set();
    const linkRe=/(?:https?:\/\/(?:www\.)?aliexpress\.com)?(?:\/item\/|\/i\/)(\d{8,})(?:\.html)?/gi;
    let m;
    while((m=linkRe.exec(block)))idsFound.add(m[1]);
    if(!idsFound.size){
      const p=block.match(/(?:productId|product_id|itemId|item_id)["']?\s*[:=]\s*["']?(\d{8,})/i);
      if(p)idsFound.add(p[1]);
    }
    if(!idsFound.size)return;

    const tm=block.match(/<h[1-6][^>]*>([\s\S]{0,1000}?)<\/h[1-6]>/i)
      ||block.match(/<a[^>]*>([\s\S]{0,1000}?)<\/a>/i);
    const title=tm?plausibleTitle(tm[1]):'';
    const eu=/(EU\s*stock|EU\s*warehouse|ships?\s*from\s*(?:Germany|Deutschland|Poland|Polen|Czech(?:ia| Republic)|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)|\b(?:Germany|Deutschland|Poland|Polen|Czechia|Czech Republic|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)\s*(?:warehouse|stock))/i.test(text);
    if(!eu)return;
    for(const id of idsFound)addId(id,text,{title,euWarehouse:true,source_type});
  };

  const parseAliSearch=(html)=>{ 
    const normalized=String(html||'')
      .replace(/&amp;/g,'&').replace(/&#x2F;/gi,'/')
      .replace(/\\u002F/g,'/').replace(/\\\\\//g,'/');

    const seenLocal=new Set();
    const urlRe=new RegExp('(?:https?:\\/\\/(?:www\\.)?aliexpress\\.com)?(?:\\/item\\/|\\/i\\/)(\\d{8,})(?:\\.html)?','gi');
    let m;
    while((m=urlRe.exec(normalized))&&ids.size<1000){
      const id=m[1];
      const key=id+'@'+Math.floor(m.index/2500);
      if(seenLocal.has(key))continue;
      seenLocal.add(key);
      const local=cleanText(normalized.slice(Math.max(0,m.index-1800),Math.min(normalized.length,m.index+2200)));
      const eu=/(EU\\s*stock|EU\\s*warehouse|ships?\\s*from\\s*(?:Germany|Deutschland|Poland|Polen|Czech(?:ia| Republic)|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)|\\b(?:Germany|Deutschland|Poland|Polen|Czechia|Czech Republic|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich)\\s*(?:warehouse|stock))/i.test(local);
      const titleMatch=local.match(/(?:product|title|name)[^\\n:]{0,30}[:：]\\s*([^\\n]{10,240})/i);
      const priceMatch=local.match(/(?:EUR|€)\\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\\s*(?:EUR|€)/i);
      const soldMatch=local.match(/(?:orders?|sold|sales|units?|verkauft)\\s*[:：]?\\s*([0-9][0-9.,]*\\s*[kmb]?\\+?)|([0-9][0-9.,]*\\s*[kmb]?\\+?)\\s*(?:orders?|sold|sales|units?)/i);
      const title=titleMatch?plausibleTitle(titleMatch[1]):'';
      const cost=priceMatch?catalogNum(priceMatch[1]||priceMatch[2]):NaN;
      const sold=soldMatch?catalogNum(soldMatch[1]||soldMatch[2]):0;
      addId(id,local,{title,cost,sold,euWarehouse:eu,source_type:'search-engine-local'});
    }

    const blocks=[];
    function collectHtmlBlocks(tag,className,maxBlockLength){
      let pos=0;
      const open='<'+tag;
      const close='</'+tag+'>';
      while(pos<normalized.length&&blocks.length<400){
        const a=normalized.indexOf(open,pos);
        if(a<0)break;
        const openEnd=normalized.indexOf('>',a);
        if(openEnd<0)break;
        const header=normalized.slice(a,openEnd+1);
        if(header.includes(className)){
          const b=normalized.indexOf(close,openEnd+1);
          if(b<0)break;
          const endPos=b+close.length;
          if(endPos-a<=maxBlockLength)blocks.push(normalized.slice(a,endPos));
          pos=endPos;
        }else{
          pos=openEnd+1;
        }
      }
    }
    collectHtmlBlocks('li','b_algo',30000);
    collectHtmlBlocks('div','MjjYud',18000);
    collectHtmlBlocks('div','result',12000);
    for(const block of blocks)addSearchBlock(block,'search-engine');

    let pm;
    const re=/(?:productId|product_id|itemId|item_id)\s*["']?\s*[:=]\s*["']?(\d{8,})/gi;
    while((pm=re.exec(normalized))&&ids.size<1000){
      const ctx=cleanText(normalized.slice(Math.max(0,pm.index-900),Math.min(normalized.length,pm.index+1500)));
      addId(pm[1],ctx,{source_type:'aliexpress-search'});
    }
  };

  // First direct AliExpress discovery.
  const slug=encodeURIComponent(keyword).replace(/%20/g,'-');
  const aliUrls=[
    'https://www.aliexpress.com/w/wholesale-'+slug+'.html?g=y&page=1',
    'https://www.aliexpress.com/w/wholesale-'+slug+'.html?page=2',
    'https://www.aliexpress.com/w/wholesale-'+slug+'.html?SearchText='+encodeURIComponent(keyword),
    'https://www.aliexpress.com/wholesale?SearchText='+encodeURIComponent(keyword)+'&page=1',
    'https://www.aliexpress.com/wholesale?SearchText='+encodeURIComponent(keyword)+'&page=2'
  ];  for(const url of aliUrls){
    const html=await fetchText(url);
    if(html.length>5000)parseAliSearch(html);
    if(out.length>=120)break;
  }

  // Browser discovery: render AliExpress search results like a real browser when plain HTML
  // does not expose reliable EU-stock evidence.
  const confirmedEU=()=>out.filter(x=>x.euWarehouse===true).length;
  if(confirmedEU()<8 && process.env.ALIEXPRESS_BROWSER_ENABLED!=='false'){
    for(const u of aliUrls.slice(0,3)){
      try{
        const b=await aliExpressBrowserRead(u,{waitMs:5000});
        if(b.html)parseAliSearch(b.html);
        if(confirmedEU()>=8)break;
      }catch{}
    }
  }

  // The fallback threshold is confirmed EU candidates, NOT total IDs.
  if(confirmedEU()<8){
    const countries=['Germany','Poland','Czech Republic','Spain','France','Italy','Netherlands','Belgium','Austria'];
    const queries=[
      'site:aliexpress.com/item/ '+keyword+' "Ships From" ('+countries.join(' OR ')+')',
      'site:aliexpress.com/item/ '+keyword+' "Ships From Poland"',
      'site:aliexpress.com/item/ '+keyword+' "Ships From Germany"',
      'site:aliexpress.com/item/ '+keyword+' "Ships From Czech Republic"',
      'site:aliexpress.com/item/ '+keyword+' "Ships From France"',
      'site:aliexpress.com/item/ '+keyword+' "Ships From Spain"',
      'site:aliexpress.com/item/ '+keyword+' "Ships From Italy"',
      'site:aliexpress.com/item/ '+keyword+' "Ships From Netherlands"',
      'site:aliexpress.com/item/ '+keyword+' "EU warehouse"',
      'site:aliexpress.com/item/ '+keyword+' "EU stock"',
      'site:aliexpress.com/item '+keyword+' orders'
    ];
    const sources=[];
    for(const query of queries){
      const q=encodeURIComponent(query);
      sources.push('https://www.bing.com/search?q='+q+'&count=50');
      sources.push('https://www.google.com/search?q='+q+'&num=50');
      sources.push('https://html.duckduckgo.com/html/?q='+q);
    }
    for(const u of sources){
      const html=await fetchText(u,{'Accept-Language':'en-US,en;q=0.9'});
      if(html)parseAliSearch(html);
      if(confirmedEU()>=80)break;
    }
  }

  // Verify a bounded sample of discovered products on their actual detail pages.
  // Search-result snippets often hide the selected warehouse, so browser detail verification
  // must also run for candidates without prior EU evidence. This keeps EU strict while
  // preventing the search parser from discarding valid EU-stock products too early.
  for(const x of out.slice(0,40)){
    try{
      const d=await extractAliExpressDetails(x.source_url);
      const dt=plausibleTitle(d.page_title);
      const generic=String(x.title||'').trim().toLowerCase()===String(keyword||'').trim().toLowerCase();
      if(dt&&!generic)x.title=dt;
      if(Number.isFinite(d.costEur)&&d.costEur>0)x.cost=d.costEur;
      if(Number.isFinite(d.sold)&&d.sold>0)x.sold=d.sold;
      if(Array.isArray(d.image_urls))x.image_urls=d.image_urls.slice(0,3);
      if(d.euWarehouse===true)x.euWarehouse=true;
      x.detail_fetch='attempted';
      x.detail_title=dt||'';
    }catch{ x.detail_fetch='failed'; }
  }

  console.log('CATALOG SOURCE',keyword,'items='+out.length,'euConfirmed='+confirmedEU());
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
 const maxCost=isHeadphone?27:Number(r.maxCost||15),minCost=isHeadphone?10:3;
 if(!Number.isFinite(cost)||cost<minCost||cost>maxCost)return 'cost-outside-range:'+String(cost);
 if(Number(x.sold||0)<1000)return 'sold-under-1000:'+String(x.sold||0);
 if(/(clothing|shoe|shoes|dress|jacket|shirt|pants|bra|underwear|swimwear|battery|laser|weapon|hunting knife|tactical knife|survival knife|pocket knife|butterfly knife|switchblade|medical|supplement|toy|plush|jewelry|necklace|ring|bracelet|wallet|mug|cup|bottle|towel|sock|slipper|curtain|pillow|flower|vase|generic|replacement|spare part)/i.test(title)&&!isKnife)return 'blocked-category';
 const problem=/(clean|cleaning|reinig|stain|scrub|remove|repair|repar|fix|measure|cut|knife|messer|sharpen|organize|wash|laundry|pet hair|groom|training|pain relief|posture|exercise|grip|safety|protect|travel|camping|outdoor|car care|detailing|garden|prun|weed|drill|screw|paint|baking|cook|slice|peel|seal|vacuum|dust|steam|headphone|earphone|earbud|kopfhörer|ohrhörer|bluetooth|wireless|ai)/i.test(title);
 if(!problem)return 'no-problem-signal';
 const targetPrice=isHeadphone?Math.max(69.90,Math.ceil(cost*2.9*100)/100):Math.max(34.90,Math.ceil(cost*3*100)/100);
 const ebay=ebayProfitability({selling_price:targetPrice,landed_cost_eur:cost});
 if(Number(ebay.estimatedProfitEur||0)<12)return 'profit-under-12:'+String(Math.round(ebay.estimatedProfitEur||0));
 if(targetPrice/cost<Math.max(r.minRatio,isHeadphone?2.9:3))return 'ratio-too-low';
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
    const missingDetail=!candidate.euWarehouse||!Number.isFinite(candidate.costEur)||candidate.costEur<=0||candidate.sold<1000||!candidate.title;
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

    const finalReason=catalogPassReason({
      id:candidate.id,title:candidate.title,cost:candidate.costEur,sold:candidate.sold,
      source_url:candidate.url,euWarehouse:candidate.euWarehouse
    });
    if(finalReason){
      reject(finalReason);
      console.log('CATALOG REJECT',k,x.id,'reason='+finalReason,'title='+String(candidate.title||'').slice(0,120),'cost='+candidate.costEur,'sold='+candidate.sold,'eu='+candidate.euWarehouse);
      continue;
    }

    const hp=/(earphone|earbuds?|headphone|headset|bluetooth headphones?|wireless headphones?|ai headphones?|kopfhörer|ohrhörer)/i.test(candidate.title);
    candidate.sellingPriceEur=hp?Math.max(69.90,Math.ceil(candidate.costEur*2.9*100)/100):Math.max(34.90,Math.ceil(candidate.costEur*3*100)/100);
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
    candidate.ratio=Number((candidate.sellingPriceEur/candidate.costEur).toFixed(2));
    candidate.estimatedProfitBeforeShippingVat=Number(ebayProfitability({selling_price:candidate.sellingPriceEur,landed_cost_eur:candidate.costEur}).estimatedProfitEur||0);
    if(candidate.estimatedProfitBeforeShippingVat<12){
      reject('profit-under-12-after-market-price');
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

app.get('/api/catalog/sources',apiKey,(_q,res)=>res.json({ok:true,apifyConfigured:Boolean(process.env.APIFY_API_TOKEN),actors:{aliexpress:Boolean(process.env.APIFY_ALIEXPRESS_ACTOR_ID),cj:Boolean(process.env.APIFY_CJ_ACTOR_ID),bigbuy:Boolean(process.env.APIFY_BIGBUY_ACTOR_ID),amazon:Boolean(process.env.APIFY_AMAZON_ACTOR_ID),googleShopping:Boolean(process.env.APIFY_GOOGLE_SHOPPING_ACTOR_ID)},marketCheckEnabled:process.env.HOMESTRO_MARKET_CHECK_ENABLED!=='false',marketCountry:process.env.HOMESTRO_MARKET_COUNTRY||'DE'}));
app.get('/api/catalog/candidates',apiKey,(_q,res)=>res.json({ok:true,source:'AliExpress',count:catalogState.candidates.length,candidates:catalogState.candidates.map(x=>({url:x.url,title:x.title,costEur:x.costEur,sellingPriceEur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,euWarehouse:x.euWarehouse,estimatedProfitBeforeShippingVat:x.estimatedProfitBeforeShippingVat,note:x.note}))}));
function csvCell(v){const s=String(v??'');return '"'+s.replace(/"/g,'""')+'"';}
function catalogFeedRows(){return catalogState.candidates.map(x=>({id:x.id,title:x.title,url:x.url,cost_eur:x.costEur,selling_price_eur:x.sellingPriceEur,sold:x.sold,ratio:x.ratio,eu_warehouse:x.euWarehouse?'TRUE':'FALSE',warehouse:x.warehouse||'',market_checked:x.marketChecked?'TRUE':'FALSE',market_lowest_price_eur:Number.isFinite(x.marketLowestPriceEur)?x.marketLowestPriceEur:'',market_status:x.marketStatus||'NOT_CHECKED',recommended_selling_price_eur:x.recommendedSellingPriceEur||x.sellingPriceEur,estimated_profit_eur:x.estimatedProfitBeforeShippingVat,source:x.source_type||'AliExpress',status:'CANDIDATE'}));}
function sendCatalogCsv(res){const rows=catalogFeedRows(),headers=['id','title','url','cost_eur','selling_price_eur','sold','ratio','eu_warehouse','warehouse','market_checked','market_lowest_price_eur','market_status','recommended_selling_price_eur','estimated_profit_eur','source','status'];res.set('Content-Type','text/csv; charset=utf-8');res.send('\uFEFF'+headers.join(',')+'\n'+rows.map(r=>headers.map(h=>csvCell(r[h])).join(',')).join('\n'));}
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
 setTimeout(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),15000); setInterval(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),draftAutopilotInterval());
}

app.listen(PORT,()=>console.log(`Homestro AI Control listening on ${PORT}`));
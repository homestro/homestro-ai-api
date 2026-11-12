Warning: truncated output (original token count: 34467)
Total output lines: 1555

const {checkGallery}=require('./gallery-readiness');
const {contentReadiness}=require('./content-readiness');
const {summarizeAutopilotResults}=require('./autopilot-results');
const {registerSupplierQuoteBridge}=require('./supplier-quote-bridge');
const {fulfillmentCostEvidence}=require('./fulfillment-cost-evidence');
const {supplierReferenceMetafields}=require('./supplier-reference');
const {normalizeSelectedDraftId}=require('./selected-draft');
// Railway sync: DSers-imported Shopify DRAFTs are eligible for Homestro autopilot.
const express=require('express');
const {registerMetaOrganic}=require('./meta-organic');
const {registerMetaConnection}=require('./meta-connection');
const {registerOrganicCatalog}=require('./organic-catalog');
const {registerMarketingPilot}=require('./homestro-marketing-pilot/runtime.cjs');
const {registerJarvisWorkforce}=require('./jarvis_agents/workforce-status');
const {registerMsHandwerkOrganic,buildDraft}=require('./ms-handwerk-organic');
const {registerMsHandwerkLeadsDryRun}=require('./ms-handwerk-leads-dry-run');
const {registerMsGoogleBusiness}=require('./ms-google-business');
const {registerMsMetaBusiness}=require('./ms-meta-business');
const {registerGoogleOrganicFeed}=require('./google-organic-feed');
const {registerShopOptimizer}=require('./shop-optimizer');
const {registerShopifyCustomerChat}=require('./shopify-customer-chat');
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
app.use(express.json({limit:'4mb',verify:(req,_res,buf)=>{req.rawBody=Buffer.from(buf);}}));
function cfg(){const domain=String(process.env.SHOPIFY_STORE_DOMAIN||'').trim().replace(/^https?:\/\//,'').replace(/\/$/,'');return{domain,token:String(process.env.SHOPIFY_ACCESS_TOKEN||'').trim(),clientId:String(process.env.SHOPIFY_CLIENT_ID||'').trim(),clientSecret:String(process.env.SHOPIFY_CLIENT_SECRET||'').trim()};}
let cached={token:'',expires:0};
async function getClientToken(){const c=cfg();if(!c.domain)throw Object.assign(new Error('Shopify is not configured.'),{status:503});if(cached.token&&Date.now()<cached.expires-60000)return cached.token;const direct=String(process.env.SHOPIFY_ACCESS_TOKEN||process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN||'').trim();if(direct)return direct;if(!c.clientId||!c.clientSecret)throw Object.assign(new Error('Shopify credentials are not configured.'),{status:503});const body=new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'client_credentials'});const r=await fetch(`https://${c.domain}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body});const text=await r.text();let d={};try{d=JSON.parse(text);}catch{throw Object.assign(new Error(`Shopify token endpoint returned HTTP ${r.status} instead of JSON (content-type: ${r.headers.get('content-type')||'unknown'}). Check Shopify app credentials/installation.`),{status:502});}if(!r.ok||!d.access_token)throw Object.assign(new Error(d.error_description||d.error||`Shopify token request failed (HTTP ${r.status})`),{status:502});cached={token:d.access_token,expires:Date.now()+Number(d.expires_in||86400)*1000};return cached.token;}
function b64(s){return Buffer.from(s,'base64url');}
function validateIdToken(token){const c=cfg();if(!token||!c.clientSecret)throw new Error('Missing Shopify ID token configuration');const p=token.split('.');if(p.length!==3)throw new Error('Invalid ID token');const[h,payload,sig]=p;const head=JSON.parse(b64(h)),body=JSON.parse(b64(payload));if(head.alg!=='HS256')throw new Error('Unsupported ID token algorithm');const expected=crypto.createHmac('sha256',c.clientSecret).update(`${h}.${payload}`).digest(),got=b64(sig);if(got.length!==expected.length||!crypto.timingSafeEqual(got,expected))throw new Error('Invalid ID token signature');const now=Math.floor(Date.now()/1000);if(body.exp<=now||(body.nbf&&body.nbf>now))throw new Error('Expired or not-yet-valid ID token');if(body.aud!==c.clientId)throw new Error('Invalid ID token audience');if(!body.dest)throw new Error('Missing ID token destination');return body;}
async function exchangeIdToken(idToken,payload){const c=cfg(),shop=new URL(payload.dest).hostname;const r=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:idToken,subject_token_type:'urn:shopify:params:oauth:token-type:id_token',requested_token_type:'urn:shopify:params:oauth:token-type:offline-access-token',expiring:'1'})});const d=await r.json();if(!r.ok||!d.access_token)throw Object.assign(new Error('Token exchange failed'),{status:r.status===400?401:502});return{token:d.access_token,shop};}
async function getRequestToken(req){const a=req.get('authorization')||'',id=a.startsWith('Bearer ')?a.slice(7):'';const payload=validateIdToken(id);return exchangeIdToken(id,payload);}
async function shopifyGraphQL(query,variables={},overrideToken){const c=cfg();if(!c.domain)throw Object.assign(new Error('Shopify is not configured.'),{status:503});const token=overrideToken||await getClientToken();const r=await fetch(`https://${c.domain}/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables})});const raw=await r.text();let d={};try{d=JSON.parse(raw);}catch(e){throw Object.assign(new Error('Shopify GraphQL returned non-JSON HTTP '+r.status+' '+raw.slice(0,180)),{status:502});}if(!r.ok||d.errors?.length)throw Object.assign(new Error(d.errors?.map(x=>x.message).join('; ')||`Shopify HTTP ${r.status}`),{status:502});return d.data;}
function apiKey(req,res,next){const k=process.env.HOMESTRO_API_KEY,a=req.get('authorization')||'';if(!k)return res.status(503).json({ok:false,error:'API key is not configured.'});if(a==='Bearer '+k)return next();return res.status(401).json({ok:false,error:'Unauthorized'});}
registerShopOptimizer(app,{graphql:shopifyGraphQL,apiKey});
registerShopifyCustomerChat(app,{graphql:shopifyGraphQL});
const metaConnection=registerMetaConnection(app,apiKey);
const metaAccess={getCredentials:()=>metaConnection.credentials(),onCredentialError:(error,credentials)=>metaConnection.reject(error,credentials)};
registerMetaOrganic(app,apiKey,metaAccess);
if(process.env.PILOT_V2_ENABLED!=='true')registerOrganicCatalog(app,apiKey,shopifyGraphQL,metaAccess);
const marketingPilot=registerMarketingPilot(app,{graphql:shopifyGraphQL,apiKey,...metaAccess});
const shopifyProductWebhookSeen=new Map();
app.post('/webhooks/shopify/products',(req,res)=>{
  const secret=cfg().clientSecret,signature=String(req.get('x-shopify-hmac-sha256')||''),raw=req.rawBody;
  const suppliedShop=String(req.get('x-shopify-shop-domain')||'').toLowerCase();
  const expectedShop=cfg().domain.toLowerCase();
  if(!secret||!raw||!signature||suppliedShop!==expectedShop)return res.status(401).send('Unauthorized');
  const expected=crypto.createHmac('sha256',secret).update(raw).digest();
  let received;try{received=Buffer.from(signature,'base64');}catch{return res.status(401).send('Unauthorized');}
  if(received.length!==expected.length||!crypto.timingSafeEqual(received,expected))return res.status(401).send('Unauthorized');
  const topic=String(req.get('x-shopify-topic')||'');
  if(!['products/create','products/update'].includes(topic))return res.status(404).send('Unsupported topic');
  const delivery=String(req.get('x-shopify-webhook-id')||'');
  if(delivery&&shopifyProductWebhookSeen.has(delivery))return res.status(200).send('Already accepted');
  if(delivery){
    shopifyProductWebhookSeen.set(delivery,Date.now());
    if(shopifyProductWebhookSeen.size>2000)for(const [key,seenAt] of shopifyProductWebhookSeen)if(Date.now()-seenAt>3600000)shopifyProductWebhookSeen.delete(key);
  }
  const productId=String(req.body?.admin_graphql_api_id||'');
  if(!/^gid:\/\/shopify\/Product\/\d+$/.test(productId))return res.status(400).send('Invalid product id');
  res.status(202).send('Accepted');
  void marketingPilot.processProduct(productId).then(result=>{
    console.log('[shopify-product-webhook] '+JSON.stringify({topic,productId,status:result?.status||'unknown'}));
  }).catch(()=>console.warn('[shopify-product-webhook] PROCESSING_FAILED'));
});
const msMetaBusiness=registerMsMetaBusiness(app,{apiKey});
const googleBusiness=registerMsGoogleBusiness(app,{apiKey,buildDraft});
registerMsHandwerkOrganic(app,apiKey,{googleBusiness,metaBusiness:msMetaBusiness});
registerMsHandwerkLeadsDryRun(app);
registerGoogleOrganicFeed(app,shopifyGraphQL,{getPilotFeed:async()=>{const pilot=await marketingPilot.ready;if(!pilot?.enabled||!pilot.feedXML)throw new Error('Pilot feed unavailable');return pilot.feedXML();}});
registerSupplierQuoteBridge(app,{apiKey,graphql:shopifyGraphQL,getToken:getClientToken});
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
 const scopes=encodeURIComponent('write_products,read_products,read_reports,write_files,write_content');
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

app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Homestro Pilot – Ergebnisse</title><style>body{margin:0;background:#f5f7f5;color:#15211b;font:16px system-ui,sans-serif}.wrap{max-width:900px;margin:auto;padding:24px}.hero,.card{background:#fff;border:1px solid #dde5df;border-radius:16px;padding:20px;margin:14px 0}.hero{background:#10251d;color:white}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.label{color:#66736b;font-size:14px}.hero .label{color:#c6d4ca}strong.value{display:block;font-size:30px;margin-top:4px}.badge{display:inline-block;border-radius:99px;background:#d8f4e1;color:#14562c;padding:7px 12px;font-weight:700}a{color:#087443}li{margin:10px 0;overflow-wrap:anywhere}footer{color:#68746d;font-size:13px;margin:20px 0}</style></head><body><main class="wrap"><section class="hero"><span class="badge">ORGANISCH · 0 € REKLAMEN</span><h1>Homestro Pilot</h1><p>Der Pilot verbindet Produktdaten, SEO-Ratgeber und organische Beiträge auf Facebook, Instagram, TikTok und Pinterest. Bezahlte Anzeigen bleiben deaktiviert.</p></section><section class="grid"><article class="card"><span class="label">Werbeausgaben</span><strong class="value">0 €</strong></article><article class="card"><span class="label">Veröffentlichte Beiträge · 7 Tage</span><strong id="posts" class="value">–</strong></article><article class="card"><span class="label">Linkaufrufe · inklusive Vorschau-Bots</span><strong id="clicks" class="value">–</strong></article></section><section class="card"><h2>Kanäle</h2><div id="channels">Lade echte Veröffentlichungsdaten …</div></section><section class="card"><h2>Letzte bestätigte Beiträge</h2><ul id="recent"></ul></section><section class="card"><h2>Veröffentlichte SEO-Ratgeber</h2><ul id="guides"></ul><p>Die Ratgeber führen zu passenden Produkten im Shop. Eine Google-Indexierung ist noch nicht bestätigt.</p></section><section class="card"><h2>Google Produktfeed</h2><p><a href="/feeds/google-organic-v2.xml">XML-Feed öffnen</a></p><p>Der Feed enthält Produktdaten. Die Freigabe in Merchant Center wird separat geprüft.</p></section><footer id="updated">Bestellungen und Umsatz kontrollierst du in Shopify Analytics. Ein Beitrag gilt hier erst als Ergebnis, wenn die Plattform die Veröffentlichung bestätigt.</footer></main><script>const el=id=>document.getElementById(id);function channelName(x){return ({facebook:'Facebook',instagram:'Instagram',tiktok:'TikTok',pinterest:'Pinterest'})[x]||x}async function load(){try{const r=await fetch('/api/marketing/v2/public-results?days=7',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();el('posts').textContent=d.publishedTotal;el('clicks').textContent=d.clickTotal;el('channels').textContent=(d.channels||[]).length?(d.channels||[]).map(x=>channelName(x.channel)+': '+x.published+' veröffentlicht · '+x.clicks+' Linkaufrufe').join(' | '):'Noch keine bestätigten Veröffentlichungen in diesem Zeitraum.';el('guides').replaceChildren();for(const p of d.guides||[]){const u=new URL(p.url);if(u.origin!=='https://homestro.de'||!u.pathname.startsWith('/pages/homestro-ratgeber-'))continue;const li=document.createElement('li'),a=document.createElement('a');a.textContent=p.handle.replace('homestro-ratgeber-','').replace(/-/g,' ');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';li.append(a);el('guides').append(li)}if(!d.guides?.length){const li=document.createElement('li');li.textContent='Noch kein veröffentlichter Ratgeber bestätigt.';el('guides').append(li)}el('recent').replaceChildren();for(const p of d.recent||[]){const li=document.createElement('li'),a=document.createElement('a');a.textContent=(p.channel?channelName(p.channel)+': ':'')+(p.title||'Beitrag öffnen');a.href=p.permalink;a.target='_blank';a.rel='noopener noreferrer';li.append(a);el('recent').append(li)}if(!d.recent?.length){const li=document.createElement('li');li.textContent='Noch kein bestätigter Beitrag in der Liste.';el('recent').append(li)}el('updated').textContent='Letzte Aktualisierung: '+new Date(d.generatedAt).toLocaleString('de-DE')+'. Linkaufrufe enthalten automatische Vorschauen. Echte Besuche und Bestellungen kontrollierst du in Shopify Analytics; ein Beitrag zählt erst nach bestätigter Veröffentlichung.'}catch(e){el('channels').textContent='Ergebnisdaten momentan nicht erreichbar. Der Werbeetat bleibt 0 €.';el('updated').textContent='Status konnte nicht geladen werden; technische Details: '+e.message+'.' }}load();setInterval(load,60000);</script></body></html>`));
app.get('/health',(_q,res)=>res.json({ok:true,service:'homestro-ai-api',timestamp:new Date().toISOString()}));
registerJarvisWorkforce(app);
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
 v=v.replace(/\bChristmas Tree\b/gi,'Weihnachtsbaum').replace(/\bMainland China\b/gi,'China (Festland)').replace(/\bSky Blue\b/gi,'Himmelblau').replace(/\bGrey Camo\b/gi,'Tarnmuster Grau').replace(/\bDefault Title\b/gi,'Standardausführung').replace(/\bType\s+(\d+)\b/gi,'Ausführung $1').replace(/\bStyle\s*([A-Z])\b/gi,'Ausführung $1').replace(/\bWiRot\b/gi,'Weiß/Rot').replace(/\bFiber Rubber Base\b/gi,'Faser-Gummibasis').replace(/\bRubber Base\b/gi,'Gummibasis').replace(/\bBase\b/gi,'Basis').replace(/\bTop\b/gi,'Überlack').replace(/\bVest for Men\b/gi,'Weste für Herren').replace(/\bVest for Women\b/gi,'Weste für Damen').replace(/\bAdapter PC\b/gi,'PC-Adapter').replace(/\bwith lights\b/gi,'mit Beleuchtung');
 v=v.replace(/\b(\d+)\s*pcs\b/gi,'$1 Stück').replace(/\b(\d+)\s*pc\b/gi,'$1 Stück').replace(/\bbottles?\b/gi,'Flaschen').replace(/\bblue\b/gi,'Blau').replace(/\bblule\b/gi,'Blau').replace(/\bwhite\b/gi,'Weiß').replace(/\bblack\b/gi,'Schwarz').replace(/\bgrey\b/gi,'Grau').replace(/\bgray\b/gi,'Grau').replace(/\bred\b/gi,'Rot').replace(/\bgreen\b/gi,'Grün').replace(/\bpink\b/gi,'Rosa').replace(/\bpurple\b/gi,'Lila').replace(/\bviolet\b/gi,'Violett').replace(/\byellow\b/gi,'Gelb').replace(/\borange\b/gi,'Orange').replace(/\bbrown\b/gi,'Braun').replace(/\bbeige\b/gi,'Beige').replace(/\bsilver\b/gi,'Silber').replace(/\bgold\b/gi,'Gold').replace(/\bGermany\b/gi,'Deutschland').replace(/\bPoland\b/gi,'Polen').replace(/\bfrance\b/gi,'Frankreich').replace(/\bUnited States\b/gi,'Vereinigte Staaten').replace(/\bChina Mainland\b/gi,'China (Festland)').replace(/\bChina\b/gi,'China');
 v=v.replace(/(\d+)\s*[xX]\s*(\d+)/g,'$1 × $2 cm');
 let m=v.match(/^Style\s*([A-Z])\s*[-–— ]\s*(\d+)\s*(?:PC|PCS)/i);if(m)return m[2]+'er-Set – Ausführung '+m[1].toUpperCase();
 m=v.match(/^Style\s*([A-Z])$/i);if(m)return 'Ausführung '+m[1].toUpperCase();
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
   {max_output_tokens:12000,reasoning:{effort:'minimal'}},
   {max_output_tokens:8000}
  ];
  let lastError=null;
  for(let attempt=0;attempt<attempts.length;attempt++){
   const settings=attempts[attempt];
   const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:messages,text:{format:{type:'json_object'}},...settings})});
   const raw=await r.text();let d={};try{d=JSON.parse(raw);}catch{lastError=new Error('OpenAI returned non-JSON HTTP '+r.status);if(attempt+1<attempts.length)continue;throw lastError;}
   if(!r.ok){
    const message=String(d?.error?.message||'OpenAI request failed');
    lastError=new Error(message);
    const unsupportedReasoning=/reasoning\.effort.*not supported|unsupported.*reasoning\.effort/i.test(message);
    if(attempt+1<attempts.length&&(r.status>=500||unsupportedReasoning))continue;
    throw lastError;
   }
   try{
    const text=extractOpenAiResponseText(d,{httpStatus:r.status});
    const parsed=cleanJson(text);
    return parsed;
   }catch(e){
    lastError=e;
    const incomplete=String(d?.status||'')==='incomplete';
    const malformed=/JSON|no usable assistant text|no JSON object|description too short/i.test(String(e?.message||e));
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
  const fallbackDesc=desc&&plain.length>=900?desc:'<p>'+homestroStripEmoji(plain||('Praktisches Produkt für den Alltag: '+title+'.'))+'</p><p>Die Produktinformationen basieren auf den aktuell verfügbaren Quelldaten. Bitte prüfen Sie vor dem Kauf die ausgewählte Variante.</p><p>Homestro stellt die verfügbaren Angaben übersichtlich fü…18467 tokens truncated…raphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id status}userErrors{field message}}}',{input:{id:productId,status:'ACTIVE'}},token);
   const activationErrors=live.productUpdate?.userErrors||[];
   if(activationErrors.length)throw new Error('Shopify activation failed: '+activationErrors.map(e=>e.message).join('; '));
   activated=String(live.productUpdate?.product?.status||'')==='ACTIVE';
   console.log('DRAFT AUTOPILOT ACTIVATION',productId,'status='+String(live.productUpdate?.product?.status||'unknown'),'marginPolicy=owner-confirmed-DSers-3x','imagesAndTextVerified=true');
  }
 }
 const pendingChecks=[...new Set(contentQA.pendingReasons)];
 void marketingPilot.processProduct(productId).catch(()=>console.warn('[organic-pilot-v2] isolated pipeline hook failure'));
 if(pendingChecks.length)console.log('EXISTING_DRAFT_QA_PENDING',productId,'reason='+(supplierState.reason||landedEvidence.reason||'qa-incomplete'),'pendingChecks='+pendingChecks.join(','));
 return {id:productId,title:x.title,source_url:src||null,source_product_id:id||null,images:media.count,variants:(p.variants?.nodes||[]).length,optionsUpdated,variantsUpdated,variantImages,collection,optionalOperations:{options:optionStep,collection:collectionStep},price,cost:supplierState.available&&Number.isFinite(cost)?cost:null,supplierCost,ratio:supplierState.available&&Number.isFinite(ratio)?ratio:null,profitPending,estimatedProfitEur:supplierState.available?profitability.estimatedProfitEur:null,pricingChanged:pricing.changed,processed:true,skipped:false,reason:supplierState.reason,pendingChecks,contentUpdated:contentNeedsWork,mediaValidation:media.validation,imagesVerified,qa,contentQA,contentComplete,pricingPolicy:'PRESERVE_DSERS',complete,landedCostVerified:landedEvidence.verified,profitStatus:isDsersImportedCandidate(p)?'OWNER_CONFIRMED_DSERS_3X':(landedEvidence.verified?'VERIFIED_LANDED_COST':'PENDING_SUPPLIER_EVIDENCE'),supplierContributionPending,activated};
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
async function openAIAuthPreflight(){
 const key=String(process.env.OPENAI_API_KEY||'').trim();
 if(!key){console.error('OPENAI_KEY_PREFLIGHT_FAILED reason=missing');return false;}
 try{
  const response=await fetch('https://api.openai.com/v1/models',{method:'GET',headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)});
  if(!response.ok){console.error('OPENAI_KEY_PREFLIGHT_FAILED status='+response.status);return false;}
  console.log('OPENAI_KEY_PREFLIGHT_OK');
  return true;
 }catch(e){console.error('OPENAI_KEY_PREFLIGHT_FAILED reason=network');return false;}
}

async function runDraftImageQA(){
 if(process.env.HOMESTRO_IMAGE_QA_ENABLED==='false'){console.log('DRAFT IMAGE QA DISABLED');return {disabled:true};}
 if(draftAutopilotState.imageRunning||draftAutopilotState.running)return {busy:true};
 draftAutopilotState.imageRunning=true;
 let processed=0,activated=0,pending=0,skipped=0;
 try{
  if(!(await openAIAuthPreflight()))return {ok:false,reason:'openai-auth-preflight'};
  const token=await getClientToken();
  // Erazer XP6 is already ACTIVE, so inspect its existing gallery first without
  // editing its live listing or changing its status.
  const activeData=await shopifyGraphQL('query($id:ID!){product(id:$id){id title status description productType media(first:50){pageInfo{hasNextPage} nodes{id mediaContentType status alt ... on MediaImage{image{url width height}}}}}}}',{id:'gid://shopify/Product/16104466776446'},token);
  const active=activeData.product;
  if(active&&/erazer\s*xp6/i.test(String(active.title||''))&&String(active.status)==='ACTIVE'){
   const images=(active.media?.nodes||[]).filter(m=>String(m.mediaContentType||'')==='IMAGE'&&m.image?.url);
   const review=await checkGallery(images,m=>imageIsRelevant(m.image.url,{title:active.title,category:active.productType,description:active.description},''),{hasNextPage:active.media?.pageInfo?.hasNextPage===true});
   console.log('ACTIVE ERAZER XP6 IMAGE QA',active.id,'status='+active.status,JSON.stringify(review));
  }
  const d=await shopifyGraphQL('query{products(first:50,query:"status:draft AND tag:homestro-ai-image-pending",sortKey:CREATED_AT,reverse:true){nodes{id title status tags}}}',{},token);
  const nodes=d.products.nodes||[];
  const queue=nodes.filter(p=>String(p.status)==='DRAFT'&&!((p.tags||[]).map(String).includes('homestro-ai-rejected'))).sort((a,b)=>Number(/erazer\s*xp6/i.test(String(b.title||'')))-Number(/erazer\s*xp6/i.test(String(a.title||''))));
  const rejected=nodes.length-queue.length;
  console.log('DRAFT IMAGE QA QUEUE','imagePending='+nodes.length,'eligible='+queue.length,'rejectedPreserved='+rejected);
  for(const p of queue){
   try{
    const result=await processExistingDraftProduct(p.id,token);
    if(result.processed)processed++;
    if(result.complete&&result.activated===true)activated++;
    if(!result.complete)pending++;
    if(result.skipped)skipped++;
    console.log('DRAFT IMAGE QA PRODUCT',p.id,'imagesVerified='+Boolean(result.imagesVerified),'complete='+Boolean(result.complete),'activated='+Boolean(result.activated));
   }catch(e){pending++;console.error('DRAFT IMAGE QA PRODUCT FAILED',p.id,String(e?.message||e));}
  }
  console.log('DRAFT IMAGE QA COMPLETE','queued='+queue.length,'processed='+processed,'activated='+activated,'pending='+pending,'rejectedPreserved='+rejected);
  return {queued:queue.length,processed,activated,pending,rejectedPreserved:rejected};
 }catch(e){console.error('DRAFT IMAGE QA FAILED',String(e?.message||e));return {ok:false,error:String(e?.message||e)};}
 finally{draftAutopilotState.imageRunning=false;}
}
async function draftAutopilotRun(limit=50){
 if(draftAutopilotState.running||draftAutopilotState.imageRunning)return;
 draftAutopilotState.running=true;
 try{
  const token=await getClientToken();
  const d=await shopifyGraphQL('query{products(first:50,query:"status:draft",sortKey:CREATED_AT,reverse:true){nodes{id title status description vendor productType tags metafields(first:20){nodes{key value}} media(first:30){nodes{id mediaContentType status alt ... on MediaImage { image { url } }}}}}}',{},token);
  const nodes=d.products.nodes||[];
  const eligible=nodes.filter(p=>isDsersImportedCandidate(p)&&!((p.tags||[]).map(String).includes('homestro-ai-rejected'))).slice(0,Math.min(Math.max(Number(limit)||50,1),50));
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
app.post('/api/autopilot/run-once',apiKey,async(_q,res)=>{
 if(draftAutopilotState.running)return res.status(409).json({ok:false,error:'autopilot-already-running'});
 try{
  const before={processed:draftAutopilotState.processed,lastRun:draftAutopilotState.lastRun};
  await draftAutopilotRun(1);
  return res.json({ok:true,mode:'run-once',automaticEnabled:process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false',before,after:{processed:draftAutopilotState.processed,skipped:draftAutopilotState.skipped,pending:draftAutopilotState.pending,lastRun:draftAutopilotState.lastRun,lastError:draftAutopilotState.lastError,lastResult:draftAutopilotState.lastResult}});
 }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
});
if(process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false'){
 setTimeout(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),15000); setInterval(()=>draftAutopilotRun().catch(e=>console.error('DRAFT AUTOPILOT AUTO FAILED',e.message)),draftAutopilotInterval());
}
if(process.env.HOMESTRO_AUTOPILOT_RUN_ONCE==='true') setTimeout(()=>draftAutopilotRun(1).catch(e=>console.error('DRAFT AUTOPILOT RUN ONCE FAILED',e.message)),15000);
// One-time visual QA safety net: runs independently of the text autopilot flag and is idempotent via homestro-ai-images-checked.
if(process.env.HOMESTRO_IMAGE_QA_ENABLED!=='false'){
 const schedulePendingDraftImageQA=()=>setTimeout(async()=>{
  try{const result=await runDraftImageQA();if(result?.busy)schedulePendingDraftImageQA();}
  catch(e){console.error('DRAFT IMAGE QA AUTO FAILED',e.message);}
 },20000);
 schedulePendingDraftImageQA();
}


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


const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(cors({origin:true}));
app.use(express.json({limit:'2mb'}));

function cfg(){
  const domain=String(process.env.SHOPIFY_STORE_DOMAIN||'').trim().replace(/^https?:\/\//,'').replace(/\/$/,'');
  return {domain,token:String(process.env.SHOPIFY_ACCESS_TOKEN||'').trim(),clientId:String(process.env.SHOPIFY_CLIENT_ID||'').trim(),clientSecret:String(process.env.SHOPIFY_CLIENT_SECRET||'').trim()};
}
let cached={token:'',expires:0};
async function getClientToken(){
  const c=cfg(); if(!c.domain) throw Object.assign(new Error('Shopify is not configured.'),{status:503});
  if(c.token)return c.token;
  if(!c.clientId||!c.clientSecret)throw Object.assign(new Error('Shopify credentials are not configured.'),{status:503});
  if(cached.token&&Date.now()<cached.expires-60000)return cached.token;
  const r=await fetch(`https://${c.domain}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'client_credentials'})});
  const d=await r.json(); if(!r.ok||!d.access_token)throw Object.assign(new Error(d.error_description||d.error||'Shopify token request failed'),{status:502});
  cached={token:d.access_token,expires:Date.now()+Number(d.expires_in||86400)*1000}; return cached.token;
}
function b64(s){return Buffer.from(s,'base64url');}
function validateIdToken(token){
  const c=cfg(); if(!token||!c.clientSecret)throw new Error('Missing Shopify ID token configuration');
  const p=token.split('.'); if(p.length!==3)throw new Error('Invalid ID token');
  const [h,payload,sig]=p; const head=JSON.parse(b64(h)); const body=JSON.parse(b64(payload));
  if(head.alg!=='HS256')throw new Error('Unsupported ID token algorithm');
  const expected=crypto.createHmac('sha256',c.clientSecret).update(`${h}.${payload}`).digest(); const got=b64(sig);
  if(got.length!==expected.length||!crypto.timingSafeEqual(got,expected))throw new Error('Invalid ID token signature');
  const now=Math.floor(Date.now()/1000); if(body.exp<=now||body.nbf>now)throw new Error('Expired or not-yet-valid ID token');
  if(body.aud!==c.clientId)throw new Error('Invalid ID token audience');
  if(!body.dest)throw new Error('Missing ID token destination');
  return body;
}
async function exchangeIdToken(idToken,payload){
  const c=cfg(); const shop=new URL(payload.dest).hostname;
  const r=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:idToken,subject_token_type:'urn:ietf:params:oauth:token-type:id_token',requested_token_type:'urn:shopify:params:oauth:token-type:offline-access-token',expiring:'1'})});
  const d=await r.json(); if(!r.ok||!d.access_token)throw Object.assign(new Error('Token exchange failed'),{status:r.status===400?401:502}); return {token:d.access_token,shop};
}
async function getRequestToken(req){
  const auth=req.get('authorization')||''; const id=auth.startsWith('Bearer ')?auth.slice(7):''; const payload=validateIdToken(id); return exchangeIdToken(id,payload);
}
async function shopifyGraphQL(query,variables={},overrideToken){
  const c=cfg(); if(!c.domain)throw Object.assign(new Error('Shopify is not configured.'),{status:503});
  const token=overrideToken||await getClientToken();
  const r=await fetch(`https://${c.domain}/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables})});
  const d=await r.json(); if(!r.ok||d.errors?.length)throw Object.assign(new Error(d.errors?.map(x=>x.message).join('; ')||`Shopify HTTP ${r.status}`),{status:502}); return d.data;
}
function apiKey(req,res,next){const k=process.env.HOMESTRO_API_KEY,a=req.get('authorization')||'';if(!k)return res.status(503).json({ok:false,error:'API key is not configured.'});if(a==='Bearer '+k)return next();return res.status(401).json({ok:false,error:'Unauthorized'});}
async function sidekick(req,res,next){try{req.sidekick=await getRequestToken(req);next();}catch(e){res.set('X-Shopify-Retry-Invalid-Session-Request','1');res.status(e.status||401).json({ok:false,error:e.message});}}

app.get('/',(_q,res)=>res.type('html').send('<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Homestro AI Control</title></head><body><h1>Homestro AI Control</h1><p>Backend online</p><p>Neue Produkte bleiben DRAFT, bis Miroslav sie freigibt.</p></body></html>'));
app.get('/health',(_q,res)=>res.json({ok:true,service:'homestro-ai-api',timestamp:new Date().toISOString()}));
app.get('/api/status',apiKey,(_q,res)=>res.json({ok:true,service:'homestro-ai-api',shopifyConfigured:Boolean(cfg().domain),openaiConfigured:Boolean(process.env.OPENAI_API_KEY),timestamp:new Date().toISOString()}));
app.get('/api/shopify/connection',apiKey,async(_q,res)=>{try{const d=await shopifyGraphQL('{shop{name myshopifyDomain}}');res.json({ok:true,connected:true,shop:d.shop});}catch(e){res.status(e.status||502).json({ok:false,connected:false,error:e.message});}});
app.get('/api/shopify/products',apiKey,async(req,res)=>{const limit=Math.min(Math.max(Number(req.query.limit)||20,1),50),q=String(req.query.query||'').trim();try{const d=await shopifyGraphQL('query($first:Int!,$query:String){products(first:$first,query:$query){nodes{id title handle status vendor productType tags totalInventory priceRangeV2{minVariantPrice{amount currencyCode}maxVariantPrice{amount currencyCode}} variants(first:100){nodes{id title price sku inventoryQuantity selectedOptions{name value} image{id url altText}}} seo{title description}} pageInfo{hasNextPage endCursor}}}',{first:limit,query:q||null});res.json({ok:true,...d.products});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
async function createDraft(input,token){if(!input?.title)throw Object.assign(new Error('Product title is required.'),{status:400});const product={title:String(input.title).trim(),descriptionHtml:String(input.descriptionHtml||input.description||'').trim(),handle:input.handle?String(input.handle).trim():undefined,vendor:input.vendor?String(input.vendor).trim():undefined,productType:String(input.productType||input.category||'').trim()||undefined,status:'DRAFT'};const d=await shopifyGraphQL('mutation($product:ProductCreateInput!){productCreate(product:$product){product{id title handle status vendor productType}userErrors{field message}}}',{product},token);if(d.productCreate.userErrors?.length)throw Object.assign(new Error('Shopify rejected the product.'),{status:400,details:d.productCreate.userErrors});return d.productCreate.product;}
app.post('/api/shopify/products/draft',apiKey,async(req,res)=>{try{res.status(201).json({ok:true,product:await createDraft(req.body?.product||req.body),status:'DRAFT'});}catch(e){res.status(e.status||502).json({ok:false,error:e.message,userErrors:e.details});}});
async function updateVariants(productId,variants,token){const normalized=(Array.isArray(variants)?variants:[]).map(v=>({id:String(v.id||''),optionValues:(v.optionValues||[]).map(o=>({optionName:String(o.optionName||''),name:String(o.name||'')}))})).filter(v=>v.id&&v.optionValues.length&&v.optionValues.every(o=>o.optionName&&o.name));if(!productId||!normalized.length)throw Object.assign(new Error('productId and valid variants are required.'),{status:400});const d=await shopifyGraphQL('mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){product{id title options{id name optionValues{id name}}variants(first:100){nodes{id title selectedOptions{name value}image{id url altText}}}}userErrors{field message}}}',{productId,variants:normalized},token);if(d.productVariantsBulkUpdate.userErrors?.length)throw Object.assign(new Error('Shopify rejected the variant update.'),{status:400,details:d.productVariantsBulkUpdate.userErrors});return d.productVariantsBulkUpdate.product;}
app.post('/api/shopify/products/variants',apiKey,async(req,res)=>{try{res.json({ok:true,product:await updateVariants(String(req.body.productId||''),req.body.variants)});}catch(e){res.status(e.status||502).json({ok:false,error:e.message,userErrors:e.details});}});
function validateProduct(cost,sellingPrice,ratio){const rules={maxCost:Number(process.env.MAX_PRODUCT_COST||10),minSellingPrice:Number(process.env.MIN_SELLING_PRICE||34.9),minRatio:Number(process.env.MIN_PRICE_COST_RATIO||3)};return {valid:cost<=rules.maxCost&&sellingPrice>=rules.minSellingPrice&&ratio>=rules.minRatio,product:{cost,sellingPrice,ratio},rules};}
app.post('/api/products/validate',apiKey,(req,res)=>{const cost=Number(req.body?.cost),sellingPrice=Number(req.body?.sellingPrice),ratio=Number(req.body?.ratio);if(![cost,sellingPrice,ratio].every(Number.isFinite))return res.status(400).json({ok:false,error:'cost, sellingPrice and ratio must be numbers.'});res.json({ok:true,...validateProduct(cost,sellingPrice,ratio)});});
function cleanJson(t){return JSON.parse(String(t||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'').trim());}
async function aiProduct(input){if(!process.env.OPENAI_API_KEY)throw Object.assign(new Error('OPENAI_API_KEY is not configured.'),{status:503});const model=process.env.OPENAI_MODEL||'gpt-5-mini';const system='Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Erstelle hochwertige, ehrliche und verkaufsstarke Produktdaten auf Deutsch. Keine erfundenen technischen Daten, Zertifikate, Garantien, Lieferzeiten, Bewertungen oder Verkaufszahlen. Ausgabe ausschließlich als gültiges JSON mit title, description, shortDescription, bullets (Array mit 5 Einträgen), seoTitle, seoDescription, handle, tags (Array), category.';const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:'Verarbeite dieses Produkt:\n'+JSON.stringify(input,null,2)}]}],max_output_tokens:1800})});const d=await r.json();if(!r.ok)throw Object.assign(new Error(d?.error?.message||'OpenAI request failed'),{status:502});const text=d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'';return {model,product:cleanJson(text)};}
app.post('/api/ai/product',apiKey,async(req,res)=>{try{res.json({ok:true,...await aiProduct(req.body?.product||req.body)});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});

app.get('/sidekick/import-product',(_req,res)=>res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="shopify-api-key" content="${String(process.env.SHOPIFY_CLIENT_ID||'')}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><title>Homestro AI Control</title><style>body{font-family:system-ui;margin:32px;max-width:900px}#status{padding:16px;border:1px solid #ddd;border-radius:12px}</style></head><body><h1>Homestro AI Control</h1><div id="status">Sidekick-Workflow wird gestartet…</div><script>
const status=document.getElementById('status');
async function call(path,body){const token=await shopify.idToken();const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d;}
function register(){if(!shopify.tools?.register)return false;shopify.tools.register('optimize_product',async(input)=>call('/api/sidekick/optimize',{product:input.product}));shopify.tools.register('validate_product',async(input)=>call('/api/sidekick/validate',input));shopify.tools.register('create_product_draft',async(input)=>call('/api/sidekick/create-draft',input));shopify.tools.register('update_variants',async(input)=>call('/api/sidekick/variants',input));return true;}
async function run(){try{register();const req=shopify.intents?.request?.value;if(!req){status.textContent='Homestro Sidekick bereit.';return;}const p=req.data||{};status.textContent='Produkt wird geprüft, optimiert und als DRAFT angelegt…';const cost=Number(p.cost),price=Number(p.selling_price);const ratio=cost>0?price/cost:0;const v=await call('/api/sidekick/validate',{cost,sellingPrice:price,ratio});if(!v.valid)throw new Error('Produkt erfüllt die Homestro Preis-/Kostenregeln nicht.');const ai=await call('/api/sidekick/optimize',{product:p});const created=await call('/api/sidekick/create-draft',{product:{...p,...ai.product,descriptionHtml:ai.product.description}});status.textContent='Fertig: Shopify-DRAFT '+created.product.id;await shopify.intents.response.ok({id:created.product.id});}catch(e){status.textContent='Fehler: '+e.message;try{await shopify.intents.response.error(e.message);}catch{}}}
window.addEventListener('load',run);</script></body></html>`));
app.post('/api/sidekick/optimize',sidekick,async(req,res)=>{try{res.json({ok:true,...await aiProduct(req.body?.product||{})});}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
app.post('/api/sidekick/validate',sidekick,(req,res)=>{const cost=Number(req.body?.cost),sellingPrice=Number(req.body?.sellingPrice),ratio=Number(req.body?.ratio);if(![cost,sellingPrice,ratio].every(Number.isFinite))return res.status(400).json({ok:false,error:'cost, sellingPrice and ratio must be numbers.'});res.json({ok:true,...validateProduct(cost,sellingPrice,ratio)});});
app.post('/api/sidekick/create-draft',sidekick,async(req,res)=>{try{const product=req.body?.product||{};const cost=Number(product.cost),price=Number(product.selling_price||product.sellingPrice);if(Number.isFinite(cost)&&Number.isFinite(price)){const v=validateProduct(cost,price,cost>0?price/cost:0);if(!v.valid)return res.status(400).json({ok:false,error:'Product fails Homestro rules.',rules:v.rules});}res.status(201).json({ok:true,product:await createDraft(product,req.sidekick.token),status:'DRAFT'});}catch(e){res.status(e.status||502).json({ok:false,error:e.message,userErrors:e.details});}});
app.post('/api/sidekick/variants',sidekick,async(req,res)=>{try{res.json({ok:true,product:await updateVariants(String(req.body.productId||''),req.body.variants,req.sidekick.token)});}catch(e){res.status(e.status||502).json({ok:false,error:e.message,userErrors:e.details});}});

app.use((_req,res)=>res.status(404).json({ok:false,error:'Not found'}));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({ok:false,error:'Internal server error'});});
app.listen(PORT,'0.0.0.0',()=>console.log(`Homestro AI Control API listening on port ${PORT}`));

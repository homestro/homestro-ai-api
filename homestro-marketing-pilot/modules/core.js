import {createHash, timingSafeEqual} from 'node:crypto';

export class PilotError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new PilotError(code); };
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const codeOf = e => e instanceof PilotError ? e.code : ['MEDIA_TIMEOUT','MEDIA_BINARY_MISSING','MEDIA_ENCODING_FAILED','FFMPEG_MISSING','ENCODING_FAILED'].includes(e?.message) ? e.message : 'INTERNAL_ERROR';
export const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export function log(code, extra={}) {
  // Do not serialize errors, HTTP responses, tokens, captions or supplier URLs.
  console.log(JSON.stringify({component:'organic-pilot',code,...extra}));
}
export function secureEqual(a,b) {
  if (!a || !b) return false;
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
}
export function productURL(raw) {
  const u=new URL(raw);
  if (u.origin!=='https://homestro.de' || !u.pathname.startsWith('/products/') || u.username || u.password)
    fail('INVALID_PRODUCT_URL');
  return u;
}
export function trackingLink(raw,channel,format='reels') {
  const u=productURL(raw);
  for (const [k,v] of Object.entries({utm_source:channel,utm_medium:'organic',
    utm_campaign:'homestro_pilot',utm_content:format})) u.searchParams.set(k,v);
  return u.toString();
}
export function pricing(price,cost,feeRate=0) {
  const p=Number(price), known=cost!==null && cost!==undefined && cost!=='' && Number.isFinite(Number(cost)) && Number(cost)>=0;
  if (!Number.isFinite(p) || p<=0 || !Number.isFinite(feeRate) || feeRate<0 || feeRate>=1) fail('INVALID_PRICE');
  // Zero is for numeric continuity only. Unknown costs NEVER become a verified margin.
  const numericCost=known?Number(cost):0;
  return {price:p,costForCalculation:numericCost,costVerified:known,
    marginEUR:known?Number((p-p*feeRate-numericCost).toFixed(2)):null,
    mayReprice:known, recommendedPrice:null};
}
const envBool=(value)=>String(value??'').trim().toLowerCase()==='true';
export function config(env=process.env) {
  const publicOrigin=new URL(env.PILOT_PUBLIC_ORIGIN || 'https://homestro-ai-api-fixed-current-production.up.railway.app').origin;
  if (!publicOrigin.startsWith('https://')) fail('HTTPS_REQUIRED');
  const cfg={publicOrigin,graphVersion:env.META_GRAPH_VERSION||'v26.0',
    pageId:env.META_PAGE_ID||'187533961115946', instagramId:env.META_INSTAGRAM_ACCOUNT_ID||'17841463937458002',
    token:env.META_PAGE_ACCESS_TOKEN||'', adminKey:env.PILOT_ADMIN_KEY||'',
    dataDir:env.PILOT_DATA_DIR||'/data/marketing',
    workerEnabled:envBool(env.PILOT_WORKER_ENABLED), publishingEnabled:envBool(env.PILOT_PUBLISH_ENABLED),
    publishOnce:envBool(env.PILOT_PUBLISH_ONCE), syncOnce:envBool(env.PILOT_SYNC_ONCE),
    feedEnabled:envBool(env.PILOT_FEED_ENABLED),
    // Merchant fees are separate from ad spend. Feed shipping must match checkout.
    feeRate:Number(env.PILOT_PAYMENT_FEE_RATE||0),
    shipping:JSON.parse(env.PILOT_SHIPPING_JSON||'[{"country":"DE","price":6.99,"freeFrom":50}]'),
    mediaHosts:(env.PILOT_MEDIA_HOSTS||'cdn.shopify.com').split(',').map(x=>x.trim()),
    maxDailyPosts:Number(env.PILOT_MAX_DAILY_POSTS||2),
    feedCap:Number(env.PILOT_FEED_MAX_OFFERS||50), intervalMs:60000};
  cfg.autonomyEnabled=env.PILOT_AUTONOMY_POLICY==='homestro-reviewed-organic-v1';
  cfg.excludedProductIds=(env.META_ORGANIC_EXCLUDED_PRODUCT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!/^v\d+\.\d+$/.test(cfg.graphVersion) || !/^\d+$/.test(cfg.pageId) || !/^\d+$/.test(cfg.instagramId))fail('INVALID_META_CONFIG');
  if(!Number.isInteger(cfg.maxDailyPosts) || cfg.maxDailyPosts<1 || cfg.maxDailyPosts>10)fail('INVALID_DAILY_LIMIT');
  if(!Number.isFinite(cfg.feeRate) || cfg.feeRate<0 || cfg.feeRate>=1)fail('INVALID_FEE_RATE');
  if(!Array.isArray(cfg.shipping) || !cfg.shipping.length)fail('INVALID_SHIPPING');
  return cfg;
}

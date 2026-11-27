'use strict';
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
const QUERY='query GoogleOrganicFeed($after:String){products(first:100,after:$after,query:"status:active"){nodes{id title handle description productType tags onlineStoreUrl vendor featuredMedia{... on MediaImage{image{url}}} variants(first:100){nodes{id title price availableForSale sku}}}pageInfo{hasNextPage endCursor}}}';
function shopifyJpegUrl(raw){
 try{const u=new URL(String(raw||''));if(u.hostname!=='cdn.shopify.com'&&!(u.hostname==='homestro.de'&&u.pathname.startsWith('/cdn/shop/')))return null;u.searchParams.set('format','jpg');u.searchParams.set('width','1080');return u.href;}catch{return null;}
}
function cleanText(v,max=5000){return String(v??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim().slice(0,max);}
function productType(p){
 const direct=String(p.productType||'').trim();if(direct)return direct;
 const tags=Array.isArray(p.tags)?p.tags:[];
 const fallback=tags.map(String).map(x=>x.trim()).find(x=>x&&!/^(homestro-|qa-|processed|pending|active|draft|rejected)/i.test(x));
 return fallback||'Alltag & Haushalt';
}
function shippingXml(price){const deCost=Number(price)>=50?'0.00':'6.99';return `<g:shipping><g:country>DE</g:country><g:service>Standard Shipping (5-10 days)</g:service><g:price>${deCost} EUR</g:price></g:shipping>`+['AT'].map(country=>`<g:shipping><g:country>${country}</g:country><g:service>EU Standard Shipping</g:service><g:price>14.99 EUR</g:price></g:shipping>`).join('');}
function cleanTitle(p){
 const title=cleanText(p.title,150).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').trim();
 const type=productType(p);
 return [title,type&&!title.toLowerCase().includes(type.toLowerCase())?type:''].filter(Boolean).join(' – ').slice(0,150);
}
async function googleOrganicXml(graphql){
 const products=[];let after=null;
 do{
  const data=await graphql(QUERY,{after});
  const page=data?.products;if(!page||!Array.isArray(page.nodes))throw new Error('SHOPIFY_ACTIVE_FEED_UNAVAILABLE');
  products.push(...page.nodes);
  if(!page.pageInfo?.hasNextPage)break;
  after=page.pageInfo.endCursor;if(!after)throw new Error('SHOPIFY_FEED_PAGINATION_INVALID');
 }while(true);
 const items=[];
 for(const p of products){
  const image=shopifyJpegUrl(p.featuredMedia?.image?.url);if(!p.onlineStoreUrl||!image)continue;
  for(const v of p.variants?.nodes||[]){
   if(!v.availableForSale||Number(v.price)<=0)continue;
   const link=new URL(p.onlineStoreUrl);link.searchParams.set('variant',String(v.id||'').split('/').pop());
   link.searchParams.set('utm_source','google');link.searchParams.set('utm_medium','organic');link.searchParams.set('utm_campaign','homestro_pilot');
   items.push(`<item><g:id>${esc(v.id)}</g:id><g:title>${esc(cleanTitle(p))}</g:title><g:description>${esc(cleanText(p.description||p.title,5000))}</g:description><g:link>${esc(link.href)}</g:link><g:image_link>${esc(image)}</g:image_link><g:availability>in_stock</g:availability><g:price>${esc(Number(v.price).toFixed(2))} EUR</g:price><g:condition>new</g:condition><g:brand>${esc(cleanText(p.vendor,100)||'Homestro')}</g:brand><g:identifier_exists>false</g:identifier_exists><g:product_type>${esc(productType(p))}</g:product_type>${shippingXml(v.price)}</item>`);
  }
 }
 return `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><title>Homestro</title><link>https://homestro.de</link><description>Homestro Produktfeed</description>${items.join('')}</channel></rss>`;
}
function registerGoogleOrganicFeed(app,graphql,{getPilotFeed,env=process.env}={}){
 const makeHandler=useLegacy=>async(_q,res)=>{let timer;try{const usePilot=useLegacy&&env.PILOT_FEED_LEGACY_ALIAS==='true';const xml=usePilot?await Promise.race([Promise.resolve().then(()=>{if(typeof getPilotFeed!=='function')throw new Error('Pilot feed unavailable');return getPilotFeed();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Feed timeout')),30000);timer.unref?.();})]):await googleOrganicXml(graphql);const itemCount=(xml.match(/<item>/g)||[]).length;res.set('Cache-Control','no-store').set('X-Feed-Item-Count',String(itemCount)).type('application/xml').send(xml);}catch(e){res.status(502).type('text/plain').send('Feed generation failed');}finally{clearTimeout(timer);}};
 app.get('/feeds/google-organic.xml',makeHandler(true));
 app.get('/feed/google-shopping.xml',makeHandler(false));
}
module.exports={googleOrganicXml,registerGoogleOrganicFeed,longTailTitle:cleanTitle,shopifyJpegUrl};

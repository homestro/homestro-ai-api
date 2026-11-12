import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogDecision} from '../modules/catalog-brain.js';
import {buildSalesPlan} from '../modules/ads-sales-plan.js';
import {GoogleTrends} from '../modules/trends.js';
import {GeneratedVideoDrafts} from '../modules/generative-video.js';
import {carouselAssetKey} from '../modules/media.js';

const shopifyVideo='https://cdn.shopify.com/s/files/1/1/products/erazer-xp6.mp4';
const product=(id,title,url,mediaVideo=null,overrides={})=>({status:'ready',document:{
  id,title,status:'ACTIVE',url,handle:url.split('/').pop(),categoryKey:'electronics',
  variants:[{available:true,price:id.endsWith('XP6')?'47.99':'59.99'}],
  media:[{mediaContentType:'IMAGE',status:'READY',image:{url:`https://cdn.shopify.com/${id}.jpg`}},
    ...(mediaVideo?[{mediaContentType:'VIDEO',status:'READY',sources:[{url:mediaVideo,mimeType:'video/mp4',width:720,height:1280}]}]:[])],
  pricing:{costVerified:true,marginEUR:20},priceReviewed:true,
  facts:[{id:'f1',text:'Bluetooth 5.4 für kabellosen Musikgenuss'}],
  localized:{language:'de',title,hook:'Musik hören und Gespräche klar verstehen.',benefits:[{factId:'f1',text:'Bluetooth 5.4 für kabellosen Musikgenuss'}]},
  ...overrides
}});

test('Erazer XP6 ranks first in the catalog and reuses its existing Shopify video',()=>{
  const flagship={id:'gid://shopify/Product/16104466776446',revision:'r1',title:'KI-Kopfhörer Lenovo Erazer XP6 mit Bluetooth 5.4',
    status:'ACTIVE',url:'https://homestro.de/products/erazer-xp6',variants:[{available:true,price:'47.99'}],
    media:[{mediaContentType:'VIDEO',status:'READY',sources:[{url:shopifyVideo,mimeType:'video/mp4'}]}]};
  const ordinary={...flagship,id:'gid://shopify/Product/2',title:'Other product',url:'https://homestro.de/products/other',media:[]};
  const priority=catalogDecision(flagship),other=catalogDecision(ordinary);
  assert.equal(priority.priorityProduct,true);
  assert.ok(priority.priority>other.priority);
  assert.equal(priority.tasks.video,'reuse_native_product_footage');
  assert.equal(priority.creativeBrief.existingVideoURL,shopifyVideo);
  assert.equal(priority.creativeBrief.videoSource,'shopify');
  assert.equal(priority.paidGenerationAuthorized,false);
  assert.equal(priority.adSpendEUR,0);
});

test('Google Trends gives the XP6 first pass an audio and translation relevance boost',async()=>{
  const terms=['Erazer XP6 Bluetooth Kopfhörer Übersetzer','Geschenkideen zum Geburtstag','Wetter Deutschland','Aktuelle Nachrichten heute',
    'Neue Filme im Kino','Fußball Ergebnisse','Rezept schnelle Küche','Urlaub Angebote Sommer','Smartphone Technik Trends','Konzert Tickets',
    'Weihnachtsgeschenke Familie','Sprachübersetzer online','Bluetooth Kopfhörer Test','Laptop Angebote','Mode Herbst',
    'Stau Verkehr heute','Euro Wechselkurs','Künstliche Intelligenz','Kopfhörer Geschenkidee','Deutschland Wahl'];
  const rss=terms.map((title,i)=>`<item><title>${title}</title><ht:approx_traffic>${1000-i*10}</ht:approx_traffic></item>`).join('');
  const trends=new GoogleTrends({geos:['DE','AT'],fetchImpl:async url=>new Response(rss,{status:200})});
  const xp6={title:'KI-Kopfhörer Lenovo Erazer XP6 mit Bluetooth 5.4 und IPX5',url:'https://homestro.de/products/erazer-xp6'};
  const result=await trends.optimize(xp6,{title:xp6.title,seoTitle:xp6.title,searchTitle:xp6.title,seoDescription:'Kabellose Kopfhörer entdecken.'});
  assert.equal(result.matchedQuery,terms[0]);
  assert.equal(result.priorityProduct,'Erazer XP6');
  assert.ok(result.flagshipBoost>0);
  assert.ok(result.matchedTrendGroups.includes('audio'));
  assert.ok(result.matchedTrendGroups.includes('translation'));
});

test('Meta draft ranks Erazer XP6 first and uses its existing video with zero spend',()=>{
  const flagship=product('gid://shopify/Product/16104466776446','KI-Kopfhörer Lenovo Erazer XP6','https://homestro.de/products/erazer-xp6',shopifyVideo);
  const ordinary=product('gid://shopify/Product/2','Faltbare Tasche','https://homestro.de/products/faltbare-tasche',null);
  const plan=buildSalesPlan({products:[ordinary,flagship],productSales:{status:'connected',days:90,
    byTitle:{},byPath:{'/products/erazer-xp6':{sessions:10,carts:0,checkouts:0},'/products/faltbare-tasche':{sessions:80,carts:5,checkouts:1}}}});
  assert.equal(plan.products[0].id,flagship.document.id);
  assert.equal(plan.products[0].priorityRank,1);
  assert.equal(plan.recommendedProductId,flagship.document.id);
  assert.equal(plan.frankensteinAdDraft.status,'draft_only');
  assert.equal(plan.frankensteinAdDraft.creative.videoURL,shopifyVideo);
  assert.equal(plan.frankensteinAdDraft.creative.assetSource,'shopify');
  assert.equal(plan.frankensteinAdDraft.dryRun,true);
  assert.equal(plan.frankensteinAdDraft.adSpendEUR,0);
  assert.equal(plan.executionEnabled,false);
});

test('Erazer XP6 never quotes or submits a duplicate paid Runway video',async()=>{
  const image='https://cdn.shopify.com/erazer-xp6.jpg',productId='gid://shopify/Product/16104466776446';
  let calls=0;
  const worker=new GeneratedVideoDrafts({pool:{query:async()=>({rows:[]})},cfg:{enabled:true,videoGenerationEnabled:true,key:'configured',publicOrigin:'https://pilot.example'},
    fresh:async()=>({id:productId,title:'Lenovo Erazer XP6',handle:'erazer-xp6',status:'ACTIVE',revision:'r1',media:[
      {mediaContentType:'IMAGE',status:'READY',image:{url:image}},
      {mediaContentType:'VIDEO',status:'READY',sources:[{url:shopifyVideo,mimeType:'video/mp4'}]}]}),
    fetchImpl:async()=>{calls++;throw new Error('Runway must not be called');}});
  const input={productId,revision:'r1',promptImage:`https://pilot.example/marketing-assets/${carouselAssetKey(image)}.jpg`,
    promptText:'Show how the existing headphones are used in a natural listening scene.'};
  const quote=await worker.quote(input);
  assert.equal(quote.reuseExisting,true);
  assert.equal(quote.existingVideoURL,shopifyVideo);
  assert.equal(quote.generationPerformed,false);
  await assert.rejects(worker.start(input),{code:'FLAGSHIP_RUNWAY_GENERATION_FORBIDDEN'});
  assert.equal(calls,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {pricing,trackingLink,config} from '../modules/core.js';
import {extractMedia,MediaRenderer,downloadMedia} from '../modules/media.js';
import {Ingestion,snapshot} from '../modules/ingestion.js';
import {compilePost} from '../modules/localization.js';
import {generateFeed,validGTIN} from '../modules/feed.js';
import {MetaOrganic} from '../modules/meta.js';
import {fetchProduct,syncCatalog} from '../modules/shopify.js';

const germanCopy={language:'de',title:'Kühlschrank-Organizer im 4er-Set',description:'Vier transparente Boxen für deinen Kühlschrank.',
  hook:'Mehr Übersicht in deinem Kühlschrank',searchTitle:'Kühlschrank-Organizer 4er-Set für übersichtliche Aufbewahrung',
  seoTitle:'Kühlschrank-Organizer 4er-Set | Homestro',seoDescription:'Entdecke vier transparente Aufbewahrungsboxen bei Homestro.',
  benefits:[{factId:'1',text:'Vier Boxen im Set'},{factId:'2',text:'Transparente Ausführung'},{factId:'3',text:'Für den Kühlschrank'}]};
const inputs={supplierReference:'supplier-1',landedCost:15,priceReviewed:true,rightsVerified:true,contentReviewed:true,
  germanCopy,facts:[{id:'1',text:'Vier Boxen'},{id:'2',text:'Transparent'},{id:'3',text:'Kühlschrank'}],unbranded:true};
const raw={id:'gid://shopify/Product/1',title:'Organizer',description:'Organizer',status:'ACTIVE',
  onlineStoreUrl:'https://homestro.de/products/organizer',variants:[{id:'gid://shopify/ProductVariant/2',price:'39.00',inventoryQuantity:2,inventoryPolicy:'DENY'}],
  media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/a.jpg'}}]};
const cfg=config({PILOT_PUBLIC_ORIGIN:'https://pilot.example',PILOT_PUBLISH_ENABLED:'true',META_PAGE_ACCESS_TOKEN:'test-page-token'});
const img=i=>`https://pilot.example/marketing-assets/${String(i).repeat(64)}.jpg`;
const asset={format:'carousel',videoURL:null,imageURLs:[img(1),img(2)]};
function product(){const p=snapshot(raw,inputs);p.localized=germanCopy;return p;}
function job(channel='instagram',media=asset){return {id:'job',channel,status:'publishing',approved_by:'Mirko',approved_at:new Date(),payload:compilePost(product(),channel,media)};}
function mockAPI(responses,inspect=()=>{}){
  const calls=[];
  const fetcher=async(url,options={})=>{const c={url:new URL(url).toString(),method:options.method||'GET',body:Object.fromEntries(new URLSearchParams(options.body||'')),headers:options.headers};calls.push(c);inspect(c);const next=responses.shift();if(next instanceof Error)throw next;assert.ok(next,'Unexpected API call');return new Response(JSON.stringify(next),{status:200,headers:{'Content-Type':'application/json'}});};
  return {fetcher,calls};
}
test('unknown supplier cost never turns into a verified zero-cost margin',()=>{
  const p=pricing(39,null);assert.equal(p.costForCalculation,0);assert.equal(p.marginEUR,null);assert.equal(p.mayReprice,false);
  assert.equal(pricing(39,15).marginEUR,24);
});
test('UTM preserves variant and uses carousel format',()=>{
  const u=new URL(trackingLink('https://homestro.de/products/a?variant=2','facebook','carousel'));
  assert.equal(u.searchParams.get('variant'),'2');assert.equal(u.searchParams.get('utm_content'),'carousel');
});
test('organic defaults allow three posts per channel while keeping a six-post total cap',()=>{
  const c=config({});
  assert.equal(c.maxDailyPosts,6);
  assert.equal(c.maxDailyPerChannel,3);
});
test('bad daily limits cannot disable the cap',()=>{
  assert.throws(()=>config({PILOT_MAX_DAILY_POSTS:'NaN'}));
  assert.throws(()=>config({PILOT_MAX_DAILY_PER_CHANNEL:'6'}));
});
test('highest-resolution MP4 wins; external and processing videos ignored',()=>{
  const m=extractMedia([{mediaContentType:'VIDEO',status:'READY',sources:[{url:'low',format:'mp4',width:540,height:960},{url:'high',mimeType:'video/mp4',width:1080,height:1920}]},{mediaContentType:'EXTERNAL_VIDEO',status:'READY',originUrl:'youtube'}]);
  assert.equal(m.videoURL,'high');
});
test('no video routes directly to image carousel, no slideshow',async()=>{
  const renderer=new MediaRenderer(cfg);renderer.carousel=async images=>({format:'image',imageURLs:images});
  const r=await renderer.render({...product(),media:raw.media});assert.equal(r.format,'image');
});
test('SSRF host rejected before fetch',async()=>{
  let called=false;await assert.rejects(downloadMedia('https://127.0.0.1/a','/tmp/a',['cdn.shopify.com'],async()=>{called=true;}));assert.equal(called,false);
});
test('missing supplier reference preserves reviewed organic preparation without inventing provenance',async()=>{
  const saved=[];const store={product:async()=>null,saveProduct:async(...a)=>saved.push(a),queue:async()=> 'new'};
  const i=new Ingestion({store,renderer:{render:async()=>asset}});
  const r=await i.process(raw,{...inputs,supplierReference:null});assert.equal(r.processed,1);assert.equal(r.status,'draft_queued');assert.equal(r.queued,2);assert.equal(saved.at(-1)[1],'ready');assert.equal(saved.at(-1)[0].supplierReference,null);
});
test('complete product creates two drafts and never calls Meta',async()=>{
  const queued=[];const store={product:async()=>null,saveProduct:async()=>{},queue:async(...a)=>{queued.push(a);return 'new';}};
  const i=new Ingestion({store,renderer:{render:async()=>asset}});const r=await i.process(raw,inputs);
  assert.equal(r.queued,2);assert.deepEqual(queued.map(x=>x[1]),['facebook','instagram']);assert.equal(queued[0][3].format,'carousel');
});
test('reviewed product is ready without media permission tag and keeps provenance truthful',async()=>{
  const saved=[],queued=[];const store={product:async()=>null,saveProduct:async(...a)=>saved.push(a),queue:async(...a)=>{queued.push(a);return 'new';}};
  const r=await new Ingestion({store,renderer:{render:async()=>asset}}).process(raw,{...inputs,rightsVerified:false});
  assert.equal(r.status,'draft_queued');assert.equal(r.queued,2);
  assert.equal(saved.at(-1)[1],'ready');assert.equal(saved.at(-1)[0].rightsVerified,false);
  assert.deepEqual(saved.at(-1)[2],[]);assert.equal(queued.length,2);
});
test('organic transport blocks all ads endpoints',async()=>{
  const api=new MetaOrganic(cfg,()=>assert.fail('Network must not be called'));
  for(const path of ['act_123/campaigns','123/adsets','123/ads','123/adcreatives'])await assert.rejects(api.request(path));
});
test('draft or publishing switch off never issues network mutation',async()=>{
  const api=new MetaOrganic(cfg,()=>assert.fail('Network must not be called'));
  await assert.rejects(api.publish({...job(),status:'draft_queued'},async()=>{}));
  await assert.rejects(new MetaOrganic({...cfg,publishingEnabled:false}).publish(job(),async()=>{}));
});
test('Instagram carousel: two child containers, parent, publish',async()=>{
  const m=mockAPI([{id:'11'},{status_code:'FINISHED'},{id:'12'},{status_code:'FINISHED'},{id:'13'},{status_code:'FINISHED'},{id:'14'}]);
  const checkpoints=[];const result=await new MetaOrganic(cfg,m.fetcher).publish(job(),async s=>checkpoints.push({...s}));
  assert.equal(result,'14');assert.equal(m.calls[0].body.is_carousel_item,'true');assert.equal(m.calls[4].body.media_type,'CAROUSEL');assert.equal(m.calls[4].body.children,'11,12');assert.equal(m.calls.at(-1).body.creation_id,'13');assert.equal(checkpoints.at(-1).phase,'published');
});
test('Instagram single image has no carousel parent',async()=>{
  const m=mockAPI([{id:'11'},{status_code:'FINISHED'},{id:'12'}]);
  await new MetaOrganic(cfg,m.fetcher).publish(job('instagram',{format:'image',videoURL:null,imageURLs:[img(1)]}),async()=>{});
  assert.equal(m.calls.length,3);assert.equal(m.calls[0].body.media_type,undefined);assert.equal(m.calls[0].body.is_carousel_item,undefined);
});
test('Facebook carousel is organic multi-photo feed post',async()=>{
  const m=mockAPI([{id:'11'},{id:'12'},{id:'187533961115946_14'}]);
  await new MetaOrganic(cfg,m.fetcher).publish(job('facebook'),async()=>{});
  assert.equal(m.calls[0].body.published,'false');assert.equal(m.calls.at(-1).body.published,'true');
  assert.deepEqual(JSON.parse(m.calls.at(-1).body.attached_media),[{media_fbid:'11'},{media_fbid:'12'}]);
});
test('Facebook Reel finish precedes encoding completion check',async()=>{
  const m=mockAPI([{video_id:'11',upload_url:'https://rupload.facebook.com/video-upload/v26.0/11'},
    {success:true},{status:{uploading_phase:{status:'complete'}}},{success:true},{status:{publishing_phase:{status:'complete'}}}]);
  await new MetaOrganic(cfg,m.fetcher).publish(job('facebook',{format:'reels',videoURL:`https://pilot.example/marketing-assets/${'a'.repeat(64)}.mp4`,imageURLs:[]}),async()=>{});
  assert.equal(m.calls[3].body.upload_phase,'finish');
});
test('ambiguous publication is not automatically repeated',async()=>{
  const m=mockAPI([{id:'11'},{status_code:'FINISHED'},new Error('timeout')]);let phase;
  await assert.rejects(new MetaOrganic(cfg,m.fetcher).publish(job('instagram',{format:'image',videoURL:null,imageURLs:[img(1)]}),async s=>{phase=s.phase;}));
  assert.equal(phase,'ig_publish_intent');assert.equal(m.calls.length,3);
});
test('feed escapes XML, caps offers and recalculates shipping at 50 EUR',()=>{
  const p=product();p.localized.searchTitle='Box & Ordnung';p.variants.push({...p.variants[0],id:'gid://shopify/ProductVariant/3',price:50});
  const xml=generateFeed([p],{...cfg,feedCap:2});assert.equal((xml.match(/<item>/g)||[]).length,2);assert.ok(xml.includes('Box &amp; Ordnung'));assert.ok(xml.includes('0.00 EUR'));assert.ok(xml.includes('6.99 EUR'));assert.ok(!xml.includes('<g:gtin>'));
  assert.equal(validGTIN('4006381333931'),true);assert.equal(validGTIN('4006381333932'),false);
});
test('media and variants are fully paginated',async()=>{
  let n=0;const graphql=async()=>{n++;return {product:{...raw,media:{nodes:[{mediaContentType:'IMAGE',status:'READY',image:{url:`image${n}`}}],pageInfo:{hasNextPage:n===1,endCursor:String(n)}},variants:{nodes:raw.variants,pageInfo:{hasNextPage:false,endCursor:'1'}}}};};
  const p=await fetchProduct(graphql,raw.id);assert.equal(p.media.length,2);assert.equal(p.variants.length,1);
});
test('catalog continues beyond first product and reports honest metrics',async()=>{
  const r=await syncCatalog(async()=>({products:{nodes:[{id:'1'},{id:'2'}],pageInfo:{hasNextPage:false}}}),async id=>({processed:id==='1'?1:0,status:'pending_marketing'}));
  assert.deepEqual(r,{processed:1,errors:1,pending:2});
});

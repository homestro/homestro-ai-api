import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceLocalizer} from '../modules/source-localizer.js';
import {prepareExistingInputs} from '../modules/bridge.js';
import {Ingestion} from '../modules/ingestion.js';
import {Worker} from '../modules/worker.js';

const raw={id:'gid://shopify/Product/8',title:'Boxen für die Küche',description:'Zwei Boxen aus Kunststoff.',descriptionHtml:'<p>Zwei Boxen aus Kunststoff.</p>',
  status:'ACTIVE',onlineStoreUrl:'https://homestro.de/products/boxen',tags:[],variants:[{id:'v',price:'20',availableForSale:true}],
  media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/box.jpg'}}]};
test('unreviewed product prepares factual German copy before approval without encoding or API calls',async()=>{
  const saved=[],posts=[];const inputs=prepareExistingInputs(raw);
  assert.equal(inputs.contentReviewed,false);assert.equal(inputs.rightsVerified,false);
  const store={product:async()=>null,saveProduct:async(...a)=>saved.push(a),queue:async(...a)=>{posts.push(a);return 'new';}};
  const i=new Ingestion({store,localizer:createSourceLocalizer(),renderer:{render:()=>assert.fail('No encoding while reviews pending')}});
  const r=await i.process(raw,inputs,{prepareOnly:true});
  assert.equal(r.processed,1);assert.equal(r.queued,2);assert.equal(r.status,'pending_marketing');
  const p=saved.at(-1)[0];assert.equal(p.localizationPrepared,true);
  assert.equal(p.localized.benefits.length,1);assert.equal(p.localized.benefits[0].text,'Zwei Boxen aus Kunststoff.');
  assert.equal(p.contentReviewed,false);assert.equal(p.rightsVerified,false);
  assert.equal(posts[0][3].previewOnly,true);
  assert.ok(r.reasons.includes('MEDIA_RIGHTS_REVIEW_REQUIRED'));assert.ok(r.reasons.includes('CONTENT_REVIEW_REQUIRED'));
});
test('missing facts produces a clear hold instead of three repeated product titles',async()=>{
  const saved=[];const i=new Ingestion({store:{product:async()=>null,saveProduct:async(...a)=>saved.push(a)},localizer:createSourceLocalizer(),renderer:{render:()=>assert.fail('No media on missing copy')}});
  const r=await i.process({...raw,description:'',descriptionHtml:''},prepareExistingInputs({...raw,description:'',descriptionHtml:''}),{prepareOnly:true});
  assert.ok(r.reasons.includes('SOURCE_COPY_REQUIRED'));assert.equal(r.queued,0);assert.equal(saved.at(-1)[0].localized,undefined);
});
test('source formatter does not pretend to translate English',async()=>{
  await assert.rejects(createSourceLocalizer()({title:'Storage boxes',description:'Two plastic boxes.',facts:[{id:'1',text:'Two plastic boxes.'}]}),{code:'GERMAN_TRANSLATION_REQUIRED'});
});
test('already processed paragraph copy does not require three bullet points',()=>{
  const inputs=prepareExistingInputs({...raw,tags:['homestro-ai-processed']});
  assert.equal(inputs.contentReviewed,true);assert.equal(inputs.germanCopy.benefits.length,1);
});
test('draft preparation cannot publish even if its preview was incorrectly approved',async()=>{
  const statuses=[],job={id:'preview',product_id:raw.id,payload:{previewOnly:true}};
  const store={withWorkerLock:fn=>fn({query:async sql=>({rows:sql.includes('count(*)')?[{count:0}]:[job]})}),
    setStatus:async(...args)=>statuses.push(args)};
  const worker=new Worker({store,cfg:{workerEnabled:true,publishingEnabled:true,maxDailyPosts:2},
    meta:{verifyConnection:()=>assert.fail('No Meta call for review preview')}});
  await worker.tick();assert.deepEqual(statuses,[['preview','superseded','PREVIEW_NOT_PUBLISHABLE']]);
});

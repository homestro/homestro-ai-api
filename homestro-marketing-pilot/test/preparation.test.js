import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceLocalizer} from '../modules/source-localizer.js';
import {prepareExistingInputs} from '../modules/bridge.js';
import {Ingestion} from '../modules/ingestion.js';
import {Worker} from '../modules/worker.js';
import {localize} from '../modules/localization.js';
import {Store} from '../modules/store.js';
import {CATALOG_QUERY} from '../modules/shopify.js';

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
  assert.equal(p.contentReviewed,true);assert.equal(p.rightsVerified,false);
  assert.equal(posts[0][3].previewOnly,true);
  assert.ok(!r.reasons.includes('MEDIA_RIGHTS_REVIEW_REQUIRED'));assert.ok(!r.reasons.includes('CONTENT_REVIEW_REQUIRED'));
});
test('OpenAI localizer translates English supplier copy into validated German without losing fact links',async()=>{
  let request;
  const localizer=createSourceLocalizer({apiKey:'test-key',model:'test-model',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/chat/completions');
    request={url,options,body:JSON.parse(options.body)};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      language:'de',title:'Aufbewahrungsboxen im 2er-Set',description:'Zwei Boxen aus Kunststoff für die Küche.',
      hook:'Mehr Ordnung in der Küche',searchTitle:'Küchenboxen im 2er-Set',
      seoTitle:'Küchenboxen im 2er-Set | Homestro',
      seoDescription:'Zwei Aufbewahrungsboxen aus Kunststoff entdecken.',
      benefits:[{factId:'f1',text:'Zwei Boxen im Set'}]
    })}}]}),{status:200,headers:{'Content-Type':'application/json'}});
  }});
  const result=await localizer({title:'Storage boxes',description:'Two plastic boxes for the kitchen.',
    facts:[{id:'f1',text:'Two boxes'}]});
  assert.equal(result.language,'de');assert.equal(result.benefits[0].factId,'f1');
  assert.equal(request.options.headers.Authorization,'Bearer test-key');
  assert.equal(request.body.model,'test-model');assert.equal(request.body.max_completion_tokens,1000);
  assert.equal(request.body.messages[1].content.includes('Two boxes'),true);
});
test('catalog sync includes new Shopify drafts as well as active products',()=>{
  assert.match(CATALOG_QUERY,/status:active OR status:draft/);
});
test('valid generated German copy is saved as reviewed and produces real media drafts',async()=>{
  const saved=[],reviews=[],posts=[];
  const store={product:async()=>null,saveProduct:async(...args)=>saved.push(args),
    recordGeneratedReview:async(...args)=>reviews.push(args),
    queue:async(...args)=>{posts.push(args);return 'new';}};
  const copy={language:'de',title:'Küchenboxen',description:'Zwei Boxen aus Kunststoff für die Küche.',
    hook:'Mehr Ordnung in der Küche',searchTitle:'Küchenboxen für die Küche',
    seoTitle:'Küchenboxen | Homestro',seoDescription:'Zwei Kunststoffboxen für die Küche.',
    benefits:[{factId:'f1',text:'Zwei Boxen im Set'}]};
  const result=await new Ingestion({store,localizer:async()=>copy,renderer:{render:async()=>({format:'carousel',imageURLs:['https://cdn.shopify.com/a.jpg','https://cdn.shopify.com/b.jpg']})}})
    .process({...raw,description:'Two plastic boxes for the kitchen.'},{priceReviewed:true,contentReviewed:false,
      facts:[{id:'f1',text:'Two boxes'}]});
  assert.equal(result.status,'draft_queued');assert.equal(result.queued,2);
  assert.equal(saved.at(-1)[0].contentReviewed,true);assert.equal(saved.at(-1)[1],'ready');
  assert.equal(reviews.length,1);assert.equal(reviews[0][1].germanCopy.title,'Küchenboxen');
  assert.equal(posts[0][3].format,'carousel');
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
test('automatic text repair removes markup, emoji and duplicate benefits then validates',async()=>{
  const facts=[{id:'1',text:'Zwei Boxen'}];
  const copy={language:'de',title:'<b>Boxen</b> ✨',description:'Zwei&nbsp;Boxen.',hook:' Boxen  ✨ ',
    searchTitle:'Boxen',seoTitle:'B'.repeat(90),seoDescription:'D'.repeat(180),
    benefits:[{factId:'1',text:'Zwei Boxen ✨'},{factId:'1',text:'Zwei Boxen'}]};
  const p=await localize({germanCopy:copy,facts});
  assert.equal(p.title,'Boxen');assert.equal(p.description,'Zwei Boxen.');assert.equal(p.benefits.length,1);
  assert.equal(p.seoTitle.length,70);assert.equal(p.seoDescription.length,160);
});
test('changed products retire obsolete drafts even when no replacement can be prepared',async()=>{
  const q=[];await new Store({query:async(sql,args)=>{q.push({sql,args});return {rows:[]};}})
    .saveProduct({id:'p',revision:'new'},'pending_marketing',['SOURCE_COPY_REQUIRED']);
  assert.match(q[1].sql,/status IN \('draft_queued','approved'\)/);
  assert.match(q[1].sql,/IS DISTINCT FROM/);assert.deepEqual(q[1].args,['p','new']);
});

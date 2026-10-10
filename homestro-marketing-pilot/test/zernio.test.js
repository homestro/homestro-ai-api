import test from 'node:test';
import assert from 'node:assert/strict';
import {ZernioOrganic} from '../modules/zernio.js';

const id='a'.repeat(24),remoteId='b'.repeat(24),origin='https://pilot.example';
const cfg={apiKey:'test-secret',accounts:{tiktok:id,pinterest:id},publicOrigin:origin,shopOrigin:'https://homestro.de',boardIds:['123'],publishingEnabled:true};
const job=()=>({id:'pilot-1',product_id:'shopify-1',channel:'tiktok',status:'publishing',approved_by:'owner',approved_at:'2026-10-09T20:00:00Z',payload:{format:'carousel',caption:'Produktbeschreibung',title:'Produkt',productURL:'https://homestro.de/products/product',adSpendEUR:0,imageURLs:[`${origin}/marketing-assets/${'c'.repeat(64)}.jpg`],tiktokSettings:{content_preview_confirmed:true,express_consent_given:true,privacy_level:'PUBLIC_TO_EVERYONE',allow_comment:false}}});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('missing preview consent blocks submission without network writes',async()=>{
  let calls=0;const api=new ZernioOrganic(cfg,async()=>{calls++;});const j=job();delete j.payload.tiktokSettings;
  await assert.rejects(api.submit(j,async()=>{}),{code:'TIKTOK_PREVIEW_CONSENT_REQUIRED'});assert.equal(calls,0);
});
test('organic allowlist blocks ad endpoints and a third account',async()=>{
  const api=new ZernioOrganic(cfg);await assert.rejects(api.request('ads'),{code:'NON_ORGANIC_ENDPOINT_BLOCKED'});
  assert.throws(()=>new ZernioOrganic({...cfg,accounts:{...cfg.accounts,youtube:id}}),{code:'ZERNIO_ACCOUNT_CONFIG_INVALID'});
});
test('untrusted media and product destinations are rejected',()=>{
  const api=new ZernioOrganic(cfg);const j=job();j.payload.imageURLs=['https://untrusted.example/photo.jpg'];
  assert.throws(()=>api.buildRequest(j),{code:'UNTRUSTED_PUBLISH_ASSET'});
  const pin=job();pin.channel='pinterest';pin.payload.boardId='123';pin.payload.productURL='https://other.example/product';
  assert.throws(()=>api.buildRequest(pin),{code:'INVALID_PRODUCT_URL'});
});
test('TikTok inbox delivery is never reported as public publication',()=>{
  const api=new ZernioOrganic(cfg);
  const state=api.publicationState({platforms:[{platform:'tiktok',accountId:id,status:'published',platformSpecificData:{isDraft:true},platformPostUrl:'https://www.tiktok.com/@homestro/video/123'}]},'tiktok');
  assert.equal(state.status,'draft_delivered');assert.equal(state.permalink,null);
});
test('checkpoint precedes submission and an accepted post without URL stays pending',async()=>{
  const events=[];let postBody;
  const api=new ZernioOrganic(cfg,async(url,options)=>{
    if(url.endsWith('/accounts'))return response({accounts:[{_id:id,platform:'tiktok',isActive:true}]});
    if(url.endsWith('/creator-info'))return response({creator:{canPostMore:true},privacyLevels:[{value:'PUBLIC_TO_EVERYONE'}],commercialContentTypes:[{value:'brand_organic'}]});
    const body=JSON.parse(options.body);if(body.dryRun)return response({dryRun:true,canPublish:true});
    assert.equal(events[0].phase,'zernio_submit_intent');assert.ok(options.headers['Idempotency-Key']);postBody=body;
    return response({post:{_id:remoteId,platforms:[{platform:'tiktok',accountId:id,status:'published',platformPostUrl:null}]}},201);
  });
  const state=await api.submit(job(),async s=>events.push(s));assert.equal(state.status,'verification_pending');
  assert.equal(postBody.tiktokSettings.commercialContentType,'brand_organic');assert.equal(events[1].providerPostId,remoteId);
});
test('HTTP 207 failed platform does not count as publication',async()=>{
  const api=new ZernioOrganic(cfg,async url=>url.endsWith('/accounts')?response({accounts:[{_id:id,platform:'pinterest',isActive:true}]}):response({post:{_id:remoteId,platforms:[{platform:'pinterest',accountId:id,status:'failed'}]}},207));
  const j=job();j.channel='pinterest';j.payload.boardId='123';
  const state=await api.submit(j,async()=>{});assert.equal(state.status,'failed');assert.equal(state.permalink,null);
});
test('network timeout retains intent, emits uncertainty and does not automatically retry',async()=>{
  let writes=0;const checkpoints=[];
  const api=new ZernioOrganic(cfg,async url=>{if(url.endsWith('/accounts'))return response({accounts:[{_id:id,platform:'pinterest',isActive:true}]});writes++;throw new Error('timeout');});
  const j=job();j.channel='pinterest';j.payload.boardId='123';
  await assert.rejects(api.submit(j,async s=>checkpoints.push(s)),{code:'ZERNIO_RESULT_UNCERTAIN'});
  assert.equal(writes,1);assert.equal(checkpoints[0].phase,'zernio_submit_intent');
});
test('reconciliation requires correct account, public permalink and published status',async()=>{
  const api=new ZernioOrganic(cfg,async()=>response({post:{platforms:[{platform:'pinterest',accountId:{_id:id},status:'published',platformPostUrl:'https://www.pinterest.com/pin/123/'}]}}));
  assert.equal((await api.reconcile(remoteId,'pinterest')).status,'published');
  assert.equal(api.publicationState({platforms:[{platform:'pinterest',accountId:'d'.repeat(24),status:'published',platformPostUrl:'https://www.pinterest.com/pin/123/'}]},'pinterest').status,'recovery_required');
});

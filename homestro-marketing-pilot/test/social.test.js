import test from 'node:test';
import assert from 'node:assert/strict';
import {SocialCoordinator,prepareSocial,approvePayload,eligible,socialConfig,berlinWindow} from '../modules/social.js';
import {fail} from '../modules/core.js';

const source=()=>({id:'gid://shopify/Product/1',status:'ACTIVE',contentReviewed:true,revision:'rev',
  url:'https://homestro.de/products/test',variants:[{available:true,price:20}],categoryKey:'home',
  localized:{title:'Artikel',hook:'Entdecke den Artikel',benefits:[{text:'Ein belegtes Merkmal'}]},
  asset:{format:'carousel',imageURLs:['https://pilot.example/marketing-assets/'+ 'a'.repeat(64)+'.jpg',
    'https://pilot.example/marketing-assets/'+ 'b'.repeat(64)+'.jpg']}});
const base={workerEnabled:true,publishingEnabled:true,publicOrigin:'https://pilot.example'};
const providerCfg={accounts:{pinterest:'a'.repeat(24)},boardId:'board',publishingEnabled:true};
const job=()=>({id:'job',product_id:source().id,channel:'pinterest',status:'approved',
  approved_by:'owner',approved_at:new Date(),payload:prepareSocial(source(),'pinterest',providerCfg),remote:{}});

test('disabled connector needs no credentials and cannot change Meta configuration',()=>{
  assert.equal(socialConfig({},base),null);
  assert.throws(()=>socialConfig({PILOT_SOCIAL_ENABLED:'true'},base),{code:'ZERNIO_CREDENTIALS_UNAVAILABLE'});
});
test('existing carousel is reused for TikTok and only first photo for Pinterest',()=>{
  const p=source(),tt=prepareSocial(p,'tiktok',providerCfg),pin=prepareSocial(p,'pinterest',providerCfg);
  assert.equal(tt.imageURLs.length,2);assert.equal(pin.imageURLs.length,1);
  assert.equal(pin.adSpendEUR,0);assert.equal(p.asset.imageURLs.length,2);
  assert.match(pin.productURL,/utm_source=pinterest/);assert.equal(tt.tiktokSettings,undefined);
});
test('rejected, archived, excluded and sold out sources are blocked',()=>{
  for(const patch of [{rejected:true},{status:'ARCHIVED'},{variants:[{available:false,price:20}]}]){
    const p={...source(),...patch};assert.equal(eligible(p,base),false);
    assert.throws(()=>prepareSocial(p,'tiktok',providerCfg),{code:'SOCIAL_SOURCE_NOT_READY'});
  }
  assert.equal(eligible(source(),{excludedProductIds:[source().id]}),false);
});
test('TikTok approval binds actual revision, preview and explicit controls',()=>{
  const j={...job(),channel:'tiktok',status:'draft_queued'};
  assert.throws(()=>approvePayload(j,{reviewer:'owner'},'rev'),{code:'TIKTOK_PREVIEW_CONSENT_REQUIRED'});
  const body={reviewer:'owner',tiktokSettings:{content_preview_confirmed:true,express_consent_given:true,
    privacy_level:'PUBLIC_TO_EVERYONE',allow_comment:false}};
  assert.throws(()=>approvePayload(j,body,'changed'),{code:'SOCIAL_REVIEW_STALE'});
  assert.equal(approvePayload(j,body,'rev').payload.tiktokSettings.allow_comment,false);
  j.payload.format='reels';
  assert.throws(()=>approvePayload(j,body,'rev'),{code:'TIKTOK_SETTINGS_REQUIRED'});
});
test('Berlin window observes daylight saving boundaries',()=>{
  assert.equal(berlinWindow(new Date('2026-10-10T06:59:00Z')),false);
  assert.equal(berlinWindow(new Date('2026-10-10T07:00:00Z')),true);
  assert.equal(berlinWindow(new Date('2026-10-10T20:00:00Z')),false);
  assert.equal(berlinWindow(new Date('2026-12-10T08:00:00Z')),true);
});

function fixture({current=source(),used=0,duplicate=false,pending=[],submitError,enabled=true}={}){
  const queries=[],j=job();let submits=0,reconciles=0;
  const client={release(){},async query(sql,args=[]){
    queries.push({sql,args});
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.includes("remote ? 'providerPostId'"))return {rows:pending};
    if(sql.includes("status='approved' ORDER BY"))return {rows:[j]};
    if(sql.includes('count(*)::int AS n'))return {rows:[{n:used}]};
    if(sql.includes('AND id<>$3'))return {rows:duplicate?[{id:'other'}]:[]};
    return {rows:[],rowCount:1};
  }};
  const pool={connect:async()=>client,query:client.query};
  const provider={async submit(post,checkpoint){
    submits++;
    assert.ok(queries.some(q=>q.sql.includes("SET status='publishing'")));
    await checkpoint({phase:'zernio_submit_intent'});
    if(submitError)fail(submitError);
    await checkpoint({providerPostId:'b'.repeat(24)});
    return {status:'verification_pending',permalink:null};
  },async reconcile(){reconciles++;return {status:'published',permalink:'https://www.pinterest.com/pin/123/'};}};
  const c=new SocialCoordinator({pool,cfg:{...base,publishingEnabled:enabled},providerCfg,freshSnapshot:async()=>current,provider});
  return {c,queries,get submits(){return submits;},get reconciles(){return reconciles;}};
}
const midday=new Date('2026-10-10T12:00:00Z');
test('worker submits once and accepted response remains remote pending',async()=>{
  const f=fixture();await f.c.tick(midday);assert.equal(f.submits,1);
  const settlement=f.queries.find(q=>q.sql.includes('published_at=CASE'));
  assert.equal(settlement.args[1],'remote_pending');
});
test('source changes and historical product duplicate prevent a new publication',async()=>{
  for(const options of [{current:{...source(),revision:'new'}},{current:{...source(),rejected:true}},{duplicate:true}]){
    const f=fixture(options);await f.c.tick(midday);assert.equal(f.submits,0);
    assert.ok(f.queries.some(q=>q.sql.includes("SET status='superseded'")));
  }
});
test('quota counts unresolved publications and stops new submissions',async()=>{
  const f=fixture({used:1});await f.c.tick(midday);assert.equal(f.submits,0);
});
test('reconciliation can settle a restart without publishing enabled',async()=>{
  const f=fixture({enabled:false,pending:[{...job(),remote:{providerPostId:'b'.repeat(24)}}]});
  await f.c.tick(midday);assert.equal(f.submits,0);assert.equal(f.reconciles,1);
  assert.ok(f.queries.some(q=>q.sql.includes('published_at=CASE')&&q.args[1]==='published'));
});
test('uncertain submission enters recovery and no second submit occurs in a tick',async()=>{
  const f=fixture({submitError:'ZERNIO_RESULT_UNCERTAIN'});await f.c.tick(midday);
  assert.equal(f.submits,1);assert.ok(f.queries.some(q=>q.sql.includes("SET status=$3,error_code=$2")&&q.args[2]==='recovery_required'));
});
test('temporary Shopify read failure preserves approval without consuming publication quota',async()=>{
  const f=fixture();f.c.freshSnapshot=async()=>{throw new Error('timeout');};
  await f.c.tick(midday);assert.equal(f.submits,0);
  assert.ok(f.queries.some(q=>q.sql.includes('SET status=$3,error_code=$2')&&q.args[2]==='approved'));
  assert.equal(f.queries.some(q=>q.sql.includes("SET status='publishing'")),false);
});
test('pool failure releases local busy guard for the next worker tick',async()=>{
  const f=fixture();f.c.pool.connect=async()=>{throw new Error('pool unavailable');};
  await assert.rejects(f.c.tick(midday));assert.equal(f.c.busy,false);
});

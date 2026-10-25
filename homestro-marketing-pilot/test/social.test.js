import test from 'node:test';
import assert from 'node:assert/strict';
import {SocialCoordinator,prepareSocial,approvePayload,eligible,socialConfig,berlinWindow,publicPostURL} from '../modules/social.js';
import {fail} from '../modules/core.js';
import {ZernioOrganic} from '../modules/zernio.js';

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

function fixture({current=source(),used=0,recent=0,duplicate=false,repeated=false,channel='pinterest',pending=[],submitError,enabled=true}={}){
  const queries=[],j=job();let submits=0,reconciles=0;
  j.channel=channel;
  const client={release(){},async query(sql,args=[]){
    queries.push({sql,args});
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.includes("remote ? 'providerPostId'"))return {rows:pending};
    if(sql.includes('AS queue_rank'))return {rows:[j]};
    if(sql.includes('count(*)::int AS n'))return {rows:[{n:used}]};
    if(sql.includes('count(*)::int AS recent'))return {rows:[{recent}]};
    if(sql.includes("interval '30 days'"))return {rows:repeated?[{id:'other-product'}]:[]};
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
  const c=new SocialCoordinator({pool,cfg:{...base,publishingEnabled:enabled},providerCfg:{...providerCfg,accounts:{[channel]:'a'.repeat(24)}},freshSnapshot:async()=>current,provider});
  return {c,queries,get submits(){return submits;},get reconciles(){return reconciles;}};
}
const midday=new Date('2026-10-10T12:00:00Z');
test('Pinterest post with production click tracking passes strict destination validation',()=>{
  const cfg={...providerCfg,publicOrigin:'https://pilot.example',shopOrigin:'https://homestro.de',
    adminKey:'owner-secret-for-tests-only-'.repeat(2),boardIds:['board']};
  const payload=prepareSocial(source(),'pinterest',cfg);
  assert.match(payload.link,/\/marketing-click\//);
  const request=new ZernioOrganic(cfg).buildRequest({...job(),status:'publishing',payload});
  const link=new URL(request.platforms[0].platformSpecificData.link);
  assert.equal(link.origin,'https://homestro.de');
  assert.equal(link.pathname,'/products/test');
  assert.equal(link.searchParams.get('utm_source'),'pinterest');
  assert.equal(link.searchParams.get('utm_campaign'),'homestro_pilot');
});
test('only locally rejected Pinterest destinations without remote state are retired',async()=>{
  const f=fixture();await f.c.prepare();
  const repair=f.queries.find(q=>q.sql.includes("error_code='LOCAL_DESTINATION_REJECTED'"));
  assert.ok(repair);
  assert.match(repair.sql,/channel='pinterest'.*status='recovery_required'/s);
  assert.match(repair.sql,/error_code='INVALID_PRODUCT_URL'.*remote='\{\}'::jsonb/s);
  assert.match(repair.sql,/SET status='rejected'/);
  assert.equal(f.submits,0);
});
test('historical uncertainty is held separately from the rolling daily quota',async()=>{
  const f=fixture();const client=await f.c.pool.connect(),query=client.query;
  client.query=async(sql,args)=>{
    if(sql.includes('count(*)::int AS n')){
      assert.match(sql,/attempted_at>now\(\)-interval '24 hours'/);
      assert.match(sql,/attempted_at IS NULL AND created_at>now\(\)-interval '24 hours'/);
      assert.doesNotMatch(sql,/channel=\$1 AND \(status IN/);
    }
    return query(sql,args);
  };
  await f.c.tick(midday);assert.equal(f.submits,1);
  const duplicateGuard=f.queries.find(q=>q.sql.includes('AND id<>$3'));
  assert.match(duplicateGuard.sql,/recovery_required/);
  assert.equal(/interval '24 hours'/.test(duplicateGuard.sql),false);
});
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
test('four-hour social cadence permits an older daily post but blocks a recent attempt',async()=>{
  for(const [recent,expected] of [[0,1],[1,0]]){
    const f=fixture({used:1,recent});f.c.cfg={...f.c.cfg,publishEveryHours:4,publishAroundClock:true};
    await f.c.tick(new Date('2026-10-10T23:00:00Z'));assert.equal(f.submits,expected);
    assert.ok(f.queries.some(q=>q.sql.includes('AS recent')&&q.args[1]===4));
  }
});
test('six daily social attempts still exhaust four-hour cadence quota',async()=>{
  const f=fixture({used:6});f.c.cfg={...f.c.cfg,publishEveryHours:4,publishAroundClock:true};
  await f.c.tick(midday);assert.equal(f.submits,0);
});
test('batch consent cannot approve a changed draft revision',()=>{
  const j={...job(),revision:'draft-new',status:'draft_queued'};
  assert.throws(()=>approvePayload(j,{reviewer:'owner',expectedRevision:'draft-old'},'rev'),{code:'SOCIAL_REVIEW_STALE'});
  assert.equal(approvePayload(j,{reviewer:'owner',expectedRevision:'draft-new'},'rev').reviewer,'owner');
});

test('balanced social limits and gaps differ by platform',async()=>{
  for(const [channel,daily,hours] of [['pinterest',6,2],['tiktok',4,4]]){
    const below=fixture({channel,used:daily-1});below.c.cfg.organicPolicy='balanced-v1';below.c.cfg.publishEveryHours=8;
    await below.c.tick(midday);assert.equal(below.submits,1);
    assert.ok(below.queries.some(q=>q.sql.includes('AS recent')&&q.args[1]===hours));
    const capped=fixture({channel,used:daily});capped.c.cfg.organicPolicy='balanced-v1';
    await capped.c.tick(midday);assert.equal(capped.submits,0);
    const spaced=fixture({channel,recent:1});spaced.c.cfg.organicPolicy='balanced-v1';
    await spaced.c.tick(midday);assert.equal(spaced.submits,0);
  }
});
test('balanced social publishing stops overnight and rejects reused media from another product',async()=>{
  const night=fixture();night.c.cfg.organicPolicy='balanced-v1';await night.c.tick(new Date('2026-10-10T23:00:00Z'));assert.equal(night.submits,0);
  const f=fixture({repeated:true});f.c.cfg.organicPolicy='balanced-v1';await f.c.tick(midday);assert.equal(f.submits,0);
  assert.ok(f.queries.some(q=>q.sql.includes("error_code='REPEATED_MEDIA'")));
});
test('long Pinterest copy retains destination link and price without exceeding description limit',()=>{
  const p=source();p.localized.hook='H'.repeat(100);p.localized.benefits=Array.from({length:3},(_,i)=>({text:String(i).repeat(200)}));
  p.url='https://homestro.de/products/'+ 'x'.repeat(200);
  const pin=prepareSocial(p,'pinterest',providerCfg);
  assert.ok(pin.caption.length<=800);assert.match(pin.caption,/20,00/);
  assert.equal(pin.caption.includes('https://'),false);assert.match(pin.productURL,/utm_source=pinterest/);
  assert.equal(p.localized.benefits.length,3);
});
test('TikTok cap does not stop an eligible Pinterest job in the same tick',async()=>{
  const f=fixture(),client=await f.c.pool.connect(),query=client.query;
  const pin=job(),tik={...job(),id:'tik',channel:'tiktok'};
  client.query=async(sql,args=[])=>{
    if(sql.includes('AS queue_rank'))return {rows:[tik,pin]};
    if(sql.includes('count(*)::int AS n'))return {rows:[{n:args[0]==='tiktok'?4:0}]};
    return query(sql,args);
  };
  f.c.cfg.organicPolicy='balanced-v1';f.c.providerCfg.accounts.tiktok='b'.repeat(24);
  const submitted=[],submit=f.c.provider.submit;
  f.c.provider.submit=async(j,checkpoint)=>{submitted.push(j.channel);return submit(j,checkpoint);};
  await f.c.tick(midday);assert.deepEqual(submitted,['pinterest']);
});


test('publication report distinguishes accepted jobs from published links and strips unsafe URLs',async()=>{
  const f=fixture();
  f.c.pool.query=async sql=>({rows:sql.includes('AS count')?(sql.includes('error_code')?
    [{channel:'tiktok',error_code:'ZERNIO_RATE_LIMIT',count:1},{channel:'tiktok',error_code:'Bearer secret',count:1}]:
    [{channel:'tiktok',status:'remote_pending',count:1},{channel:'pinterest',status:'published',count:1}]):
    [{channel:'pinterest',permalink:'https://www.pinterest.com/pin/123/?token=secret',published_at:'now'},
     {channel:'tiktok',permalink:'https://evil.example/video/1',published_at:'now'}]});
  const r=await f.c.report();assert.equal(r.counts[0].status,'remote_pending');
  assert.equal(r.publications.length,1);assert.equal(r.publications[0].permalink,'https://www.pinterest.com/pin/123/');
  assert.equal(r.failures.length,1);assert.equal(JSON.stringify(r).includes('secret'),false);
  assert.equal(publicPostURL('https://www.tiktok.com/@homestroo/photo/123','tiktok'),'https://www.tiktok.com/@homestroo/photo/123');
  assert.equal(publicPostURL('https://www.tiktok.com/login?token=secret','tiktok'),null);
});
test('template changes preserve approved TikTok previews while preparing new Pinterest drafts',async()=>{
  const f=fixture(),p=source(),queries=[];
  f.c.providerCfg.accounts.tiktok='b'.repeat(24);
  f.c.pool.query=async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.includes('SELECT document'))return {rows:[{document:p}]};
    if(sql.includes("channel='tiktok' AND status='approved'"))return {rows:[{id:'approved-tiktok'}]};
    return {rows:[],rowCount:1};
  };
  await f.c.prepare();
  assert.equal(queries.filter(q=>q.sql.includes('INSERT INTO marketing_social_posts')).length,1);
  assert.equal(queries.find(q=>q.sql.includes('INSERT INTO marketing_social_posts')).args[2],'pinterest');
  assert.equal(queries.some(q=>q.sql.includes("SET status='superseded'")&&q.args[1]==='tiktok'),false);
});

test('TikTok connection check uses an approved preview for dry-run and never submits a public post',async()=>{
  const j={...job(),channel:'tiktok',status:'approved'};
  j.payload={...prepareSocial(source(),'tiktok',{...providerCfg,accounts:{tiktok:'a'.repeat(24)}}),
    productRevision:'rev',
    tiktokSettings:{content_preview_confirmed:true,express_consent_given:true,
      privacy_level:'PUBLIC_TO_EVERYONE',allow_comment:false}};
  let checked=null;
  const coordinator=new SocialCoordinator({
    pool:{query:async()=>({rows:[j]})},cfg:base,
    providerCfg:{accounts:{tiktok:'a'.repeat(24)},publishingEnabled:true},
    freshSnapshot:async()=>source(),
    provider:{preflightTikTok:async post=>{checked=post;return {dryRun:true,canPublish:true};}}
  });
  assert.deepEqual(await coordinator.checkTikTokPreflight(),{ok:true,channel:'tiktok',format:'carousel'});
  assert.equal(checked.status,'publishing');
  assert.equal(checked.payload.tiktokSettings.express_consent_given,true);
});


test('Pinterest signs only the submitted copy and keeps reviewed draft preparation stable',async()=>{
  const f=fixture();f.c.cfg.adminKey='o'.repeat(40);
  const before=prepareSocial(source(),'pinterest',{...base,...providerCfg,adminKey:f.c.cfg.adminKey});
  assert.equal(new URL(before.productURL).searchParams.has('pilot_ref'),false);
  let submitted;
  const submit=f.c.provider.submit;
  f.c.provider.submit=async(post,checkpoint)=>{submitted=post.payload;return submit(post,checkpoint);};
  await f.c.tick(new Date('2026-10-25T12:00:00Z'));
  assert.equal(f.submits,1);
  assert.ok(new URL(submitted.productURL).searchParams.has('pilot_ref'));
  assert.equal(new URL(submitted.productURL).hostname,'homestro.de');
  assert.deepEqual(prepareSocial(source(),'pinterest',{...base,...providerCfg,adminKey:f.c.cfg.adminKey}),before);
});

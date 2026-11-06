import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketingOperations,publicationSlot,queueReadback,videoScenario} from '../modules/operations.js';
import {Store} from '../modules/store.js';
import {Worker} from '../modules/worker.js';
const date=new Date('2026-10-27T10:00:00Z');
const product={id:'gid://shopify/Product/1',revision:'rev',status:'ACTIVE',variants:[{available:true,price:39}],media:[]};
function database(){
 const state={products:[{id:product.id,document:product,status:'ready'}],queues:[],imports:[],generated:[],schedules:new Map(),reports:new Map(),events:[]};
 const query=async(sql,args=[])=>{
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.startsWith('CREATE ')||sql.startsWith('SELECT pg_advisory_unlock'))return {rows:[]};
  if(sql.startsWith('SELECT id,document,status FROM marketing_products'))return {rows:state.products};
  if(sql.includes("'marketing_posts' AS queue"))return {rows:state.queues.filter(r=>r.queue==='marketing_posts')};
  if(sql.includes("'marketing_social_posts' AS queue"))return {rows:state.queues.filter(r=>r.queue==='marketing_social_posts')};
  if(sql.startsWith('SELECT job_id,product_id'))return {rows:state.imports};
  if(sql.startsWith('SELECT job_key,product_id'))return {rows:state.generated};
  if(sql.startsWith('SELECT * FROM marketing_publication_schedule'))return {rows:[...state.schedules.values()]};
  if(sql.startsWith('INSERT INTO marketing_publication_schedule')){
   const k=args[0]+':'+args[1];if(!state.schedules.has(k))state.schedules.set(k,{queue:args[0],post_id:args[1],product_revision:args[2],channel:args[3],scheduled_for:args[4].toISOString()});return {rows:[],rowCount:1};
  }
  if(sql.startsWith('INSERT INTO marketing_daily_operations')){state.reports.set(args[0],structuredClone(args[1]));return {rows:[]};}
  if(sql.startsWith('SELECT report FROM marketing_daily_operations'))return {rows:state.reports.has(args[0])?[{report:state.reports.get(args[0])}]:[]};
  if(sql.startsWith('SELECT count(*)'))return {rows:[{count:0}]};
  if(sql.includes('SELECT s.* FROM marketing_posts')||sql.startsWith("SELECT * FROM marketing_posts WHERE status='approved'")){
   // Simulate actual queue eligibility, including the persisted earliest send time.
   assert.match(sql,/marketing_publication_schedule/);
   return {rows:state.queues.filter(r=>r.queue==='marketing_posts'&&r.status==='approved'&&(!args[0]||Array.isArray(args[0])||r.id===args[0])&&
    new Date(state.schedules.get(r.queue+':'+r.id)?.scheduled_for||0)<=date).slice(0,1)};
  }
  if(sql.startsWith('SELECT * FROM marketing_products WHERE'))return {rows:state.products.filter(p=>p.id===args[0])};
  if(sql.startsWith('UPDATE marketing_posts SET status=')){
   const row=state.queues.find(r=>r.id===args[0]);row.status=args[1];
   if(args[1]==='publishing')row.attempted_at ||= date.toISOString();
   if(args[1]==='published')row.published_at ||= date.toISOString();
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith('UPDATE marketing_posts SET remote=')){state.queues.find(r=>r.id===args[0]).remote=args[1];return {rows:[]};}
  if(sql.startsWith('INSERT INTO marketing_events')){state.events.push(args);return {rows:[]};}
  throw Error('Unexpected SQL: '+sql);
 };
 return {state,query,connect:async()=>({query,release(){}})};
}
const post=(id='one',overrides={})=>({id,queue:'marketing_posts',channel:'facebook',product_id:product.id,status:'approved',
 payload:{productRevision:'rev',videoURL:'https://publisher.example/existing.mp4',importedJobId:'existing-video'},remote:{},...overrides});
const cfg={workerEnabled:true,publishingEnabled:true,publishAroundClock:true,maxDailyPosts:4,maxDailyPerChannel:2};
test('existing video inventory → persistent schedule → native publisher → platform ID → restart/daily report, with no generation',async()=>{
 const pool=database();pool.state.queues.push(post());
 pool.state.imports.push({metadata:{kind:'video'},state:'queued'});let sends=0;
 const operations=new MarketingOperations({pool,cfg,clock:()=>date});await operations.migrate();
 const prepared=await operations.tick();
 assert.equal(prepared.media.importedVideos,1);assert.equal(prepared.media.importedImages,0);
 assert.equal(prepared.receipts[0].mediaKind,'video');assert.equal(prepared.receipts[0].scheduledFor,date.toISOString());assert.equal(prepared.newPublicationConfirmed,false);
 const store=new Store(pool);store.withWorkerLock=async fn=>fn({query:pool.query});
 const worker=new Worker({store,cfg:{...cfg,autonomyEnabled:true},freshSnapshot:async()=>product,isPublishingWindow:()=>true,
  meta:{verifyConnection:async()=>{},publish:async(_,checkpoint)=>{sends++;await checkpoint({postId:'12345'});},request:async()=>({id:'12345',permalink_url:'https://www.facebook.com/123/posts/12345'})}});
 await worker.tick();assert.equal(sends,1);assert.equal(pool.state.queues[0].status,'published');
 const restarted=new MarketingOperations({pool,cfg,clock:()=>date});const report=await restarted.tick();
 assert.equal(report.receipts[0].scheduledFor,null);assert.equal(report.receipts[0].platformId,'12345');
 assert.equal(report.receipts[0].recordedPublished,true);assert.match(report.receipts[0].permalink,/12345/);
 await worker.tick();assert.equal(sends,1);assert.equal(pool.state.schedules.size,1);assert.equal(pool.state.reports.size,1);
 assert.equal((await restarted.report()).economics.netProfitEUR,null);assert.equal(report.generationPerformed,false);
});
test('lost provider response survives restart as uncertainty; does not become a publication or another send',async()=>{
 const pool=database();pool.state.queues.push(post());let sends=0;
 const store=new Store(pool);store.withWorkerLock=async fn=>fn({query:pool.query});
 const worker=new Worker({store,cfg,freshSnapshot:async()=>product,
  meta:{verifyConnection:async()=>{},publish:async(_,checkpoint)=>{sends++;await checkpoint({phase:'publish_intent'});throw Error('lost');}}});
 const ops=new MarketingOperations({pool,cfg,clock:()=>date});await ops.tick();await worker.tick();
 const report=await new MarketingOperations({pool,cfg,clock:()=>date}).tick();await worker.tick();
 assert.equal(sends,1);assert.equal(report.receipts[0].status,'recovery_required');assert.equal(report.receipts[0].recordedPublished,false);assert.equal(report.receipts[0].scheduledFor,null);
});
test('unreviewed imports, stale revisions and TikTok missing consent get no schedule',async()=>{
 const pool=database();pool.state.queues.push(post('visual',{payload:{productRevision:'rev',requiresVisualReview:true}}),
 post('stale',{payload:{productRevision:'old'}}),post('consent',{queue:'marketing_social_posts',channel:'tiktok'}));
 const report=await new MarketingOperations({pool,cfg,socialEnabled:true,clock:()=>date}).tick();
 assert.equal(pool.state.schedules.size,0);assert.equal(report.planning.blockers.length,3);
});
test('Berlin DST and overnight slots stay inside publication window; snapshots distinguish image from video',()=>{
 for(const input of ['2026-10-25T01:30:00Z','2026-03-29T01:30:00Z','2026-10-27T22:59:00Z']){
  const slot=publicationSlot(input),hour=Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(slot));
  assert.ok(hour>=9&&hour<22);assert.ok(slot>=new Date(input));
 }
 assert.equal(queueReadback(post('image',{payload:{imageURLs:['https://publisher.example/p.jpg']}})).mediaKind,'image');
});

test('video story uses only source-bound facts and never grants generation authority',()=>{
 const plan=videoScenario({...product,facts:[{id:'real',text:'Belegtes Merkmal'}],localized:{language:'de',title:'Box',benefits:[
  {factId:'invented',text:'Nicht belegt'},{factId:'real',text:'Belegtes Merkmal'}]},media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/box.jpg'}}]});
 assert.deepEqual(plan.sourceFactIds,['real']);assert.equal(plan.readyForQuote,true);
 assert.equal(JSON.stringify(plan).includes('Nicht belegt'),false);assert.equal(plan.generationAuthorized,false);
 assert.equal(plan.shots.reduce((n,s)=>n+s.seconds,0),5);
});

test('a future durable slot prevents the existing worker from sending early, including after restart',async()=>{
 const pool=database();pool.state.queues.push(post());
 pool.state.schedules.set('marketing_posts:one',{queue:'marketing_posts',post_id:'one',product_revision:'rev',channel:'facebook',scheduled_for:'2026-10-27T18:00:00.000Z'});
 const ops=new MarketingOperations({pool,cfg,clock:()=>date});const report=await ops.tick();
 assert.equal(report.receipts[0].scheduledFor,'2026-10-27T18:00:00.000Z');
 const store=new Store(pool);store.withWorkerLock=async fn=>fn({query:pool.query});
 const worker=new Worker({store,cfg,freshSnapshot:async()=>assert.fail('must not even read source before slot'),meta:{publish:async()=>assert.fail('must not send early')}});
 await worker.tick();assert.equal(pool.state.queues[0].status,'approved');
 assert.equal((await new MarketingOperations({pool,cfg,clock:()=>date}).tick()).planning.added,0);
});

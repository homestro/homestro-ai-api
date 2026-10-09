import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from '../modules/worker.js';

const cfg={workerEnabled:true,publishingEnabled:true,maxDailyPosts:2};
function setup({metaError=false,changed=false,tokenError=false}={}) {
  const statuses=[];let writes=0;
  const job={id:'1',product_id:'p1',status:'approved',approved_by:'Mirko',approved_at:new Date(),payload:{productRevision:'rev'},remote:{}};
  const client={query:async q=>({rows:q.includes('count(*)')?[{count:0}]:[job]})};
  const store={withWorkerLock:fn=>fn(client),product:async()=>({status:'ready'}),
    setStatus:async(_,s)=>statuses.push(s),checkpoint:async()=>{}};
  const meta={verifyConnection:async()=>{if(tokenError)throw new Error('expired');},
    publish:async(_,checkpoint)=>{writes++;await checkpoint({phase:'publish_intent'});if(metaError)throw new Error('timeout');}};
  const freshSnapshot=async()=>({revision:changed?'new':'rev',status:'ACTIVE',variants:[{available:true,price:39}]});
  return {worker:new Worker({store,meta,cfg,freshSnapshot}),statuses,writes:()=>writes};
}
test('autonomy enforces the configured per-channel daily cap',async()=>{
  let selectionQuery,selectionParams;
  const client={query:async(sql,params)=>{
    if(String(sql).includes("SELECT count(*) FROM marketing_posts WHERE"))return {rows:[{count:0}]};
    selectionQuery=String(sql);selectionParams=params;return {rows:[]};
  }};
  const store={withWorkerLock:fn=>fn(client)};
  const worker=new Worker({store,cfg:{...cfg,autonomyEnabled:true,maxDailyPerChannel:3,excludedProductIds:[]},
    meta:{},freshSnapshot:async()=>null,isPublishingWindow:()=>true});
  await worker.tick();
  assert.match(selectionQuery,/SELECT count\(\*\) FROM marketing_posts recent WHERE recent.channel=s.channel/);
  assert.deepEqual(selectionParams,[[],3]);
});
test('worker explains when the rolling daily publication cap blocks the queue',async()=>{
  const entries=[],original=console.log;
  console.log=line=>entries.push(JSON.parse(line));
  try {
    const worker=new Worker({store:{withWorkerLock:fn=>fn({query:async()=>({rows:[{count:6}]})})},
      cfg:{...cfg,autonomyEnabled:true,maxDailyPosts:6},meta:{},freshSnapshot:async()=>null,isPublishingWindow:()=>true});
    await worker.tick();
  } finally {console.log=original;}
  assert.ok(entries.some(x=>x.code==='PUBLISH_BLOCKED' && x.reason==='DAILY_TOTAL_LIMIT' &&
    x.publishedOrUncertainLast24h===6 && x.limit===6));
});
test('worker explains when the database advisory lock is held elsewhere',async()=>{
  const entries=[],original=console.log;console.log=line=>entries.push(JSON.parse(line));
  try {
    const worker=new Worker({store:{withWorkerLock:async()=>false},cfg:{...cfg},meta:{},freshSnapshot:async()=>null});
    await worker.tick();
  } finally {console.log=original;}
  assert.ok(entries.some(x=>x.code==='PUBLISH_BLOCKED' && x.reason==='WORKER_DATABASE_LOCK_BUSY'));
});
test('worker records published only after publisher confirms',async()=>{
  const s=setup();await s.worker.tick();assert.deepEqual(s.statuses,['publishing','published']);
});
test('uncertain remote mutation is isolated and held for recovery',async()=>{
  const s=setup({metaError:true});await assert.doesNotReject(s.worker.tick());assert.deepEqual(s.statuses,['publishing','recovery_required']);
});
test('expired token in preflight does not reach mutation or throw into main pipeline',async()=>{
  const s=setup({tokenError:true});await assert.doesNotReject(s.worker.tick());assert.equal(s.writes(),0);
});
test('changed product invalidates old approval without publishing',async()=>{
  const s=setup({changed:true});await s.worker.tick();assert.equal(s.writes(),0);assert.deepEqual(s.statuses,['superseded']);
});

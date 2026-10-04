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

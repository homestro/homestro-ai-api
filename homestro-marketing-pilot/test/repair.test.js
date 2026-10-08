import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceReviewReasons} from '../modules/autonomy.js';
import {queueEditorial} from '../modules/editorial.js';
import {Worker} from '../modules/worker.js';
import {Store} from '../modules/store.js';

test('review diagnostics name missing evidence without requiring supplier reference',()=>{
  assert.deepEqual(sourceReviewReasons({}),['CONTENT_REVIEW_REQUIRED']);
  assert.deepEqual(sourceReviewReasons({rightsVerified:true,contentReviewed:true,priceReviewed:true,germanCopy:{}}),[]);
  assert.deepEqual(sourceReviewReasons({contentReviewed:true,germanCopy:{}}),[]);
});
test('disabled editorial retires queued approvals while preserving published history',async()=>{
  const old=process.env.PILOT_BRAND_EDITORIAL_ENABLED;process.env.PILOT_BRAND_EDITORIAL_ENABLED='false';
  try {
    let sql;await queueEditorial({pool:{query:async q=>{sql=q;return {rowCount:2};}}},{autonomyEnabled:true});
    assert.match(sql,/status IN \('draft_queued','approved'\)/);
    assert.match(sql,/EDITORIAL_DISABLED/);
  }finally{if(old===undefined)delete process.env.PILOT_BRAND_EDITORIAL_ENABLED;else process.env.PILOT_BRAND_EDITORIAL_ENABLED=old;}
});
test('targeted worker rejects disabled editorial before contacting Meta',async()=>{
  const old=process.env.PILOT_BRAND_EDITORIAL_ENABLED;process.env.PILOT_BRAND_EDITORIAL_ENABLED='false';
  try {
    const statuses=[];const job={id:'1',product_id:'editorial:homestro:v1:01',payload:{kind:'brand_editorial'}};
    const store={withWorkerLock:fn=>fn({query:async sql=>({rows:sql.includes('count(*)')?[{count:0}]:[job]})}),setStatus:async(...args)=>statuses.push(args)};
    const worker=new Worker({store,cfg:{workerEnabled:true,publishingEnabled:true,maxDailyPosts:2},meta:{verifyConnection:async()=>assert.fail('No Meta call')}});
    await worker.tick('1');assert.deepEqual(statuses,[['1','superseded','EDITORIAL_DISABLED']]);
  }finally{if(old===undefined)delete process.env.PILOT_BRAND_EDITORIAL_ENABLED;else process.env.PILOT_BRAND_EDITORIAL_ENABLED=old;}
});
test('published timestamp is assigned only once and survives status checks',async()=>{
  const queries=[];const store=new Store({query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};}});
  await store.setStatus('1','published');assert.match(queries[0].sql,/COALESCE\(published_at,now\(\)\)/);
  assert.match(queries[0].sql,/ELSE published_at/);
});

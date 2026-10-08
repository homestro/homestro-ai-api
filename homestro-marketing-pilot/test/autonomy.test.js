import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedSource,publicationWindow,verifyHistory} from '../modules/autonomy.js';

test('automatic preparation rejects each missing source review',()=>{
  const good={rightsVerified:true,contentReviewed:true,priceReviewed:true,germanCopy:{language:'de'}};
  assert.equal(reviewedSource(good),true);
  assert.equal(reviewedSource({...good,rightsVerified:false}),true);
  for(const field of ['contentReviewed','priceReviewed','germanCopy'])
    assert.equal(reviewedSource({...good,[field]:false}),false);
});
test('publication uses Berlin local time in summer and winter',()=>{
  assert.equal(publicationWindow(new Date('2026-10-06T07:00:00Z')),true);
  assert.equal(publicationWindow(new Date('2026-10-06T20:00:00Z')),false);
  assert.equal(publicationWindow(new Date('2026-12-06T08:00:00Z')),true);
  assert.equal(publicationWindow(new Date('2026-12-06T07:59:00Z')),false);
});
test('read-only history verification never retries unmatched or ambiguous Instagram writes',async()=>{
  for(const data of [[],[{id:'1',caption:'same',timestamp:'2026-10-05T10:00:00Z'}],
    [{id:'1',caption:'same',timestamp:'2026-10-06T11:00:00Z'},{id:'2',caption:'same',timestamp:'2026-10-06T11:00:00Z'}]]) {
    let changes=0;
    const job={id:'job',channel:'instagram',status:'recovery_required',created_at:'2026-10-06T10:00:00Z',payload:{caption:'same'}};
    const store={withWorkerLock:fn=>fn({query:async()=>({rows:[job]})}),checkpoint:async()=>{changes++;},setStatus:async()=>{changes++;}};
    const meta={request:async(_,opts)=>{assert.equal(opts.method,undefined);return {data};}};
    await verifyHistory(store,meta,{instagramId:'123'});assert.equal(changes,0);
  }
});
test('confirmed historical publication does not change its daily-limit timestamp',async()=>{
  let update;
  const job={id:'job',channel:'facebook',status:'published',remote:{postId:'123'}};
  const store={withWorkerLock:fn=>fn({query:async sql=>{if(sql.startsWith('SELECT'))return {rows:[job]};update=sql;return {rows:[]};}})};
  await verifyHistory(store,{request:async()=>({id:'123',permalink_url:'https://www.facebook.com/123'})},{});
  assert.equal(update.includes('updated_at'),false);
});

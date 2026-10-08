import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedSource,publicationWindow,verifyHistory,approveReviewed} from '../modules/autonomy.js';

test('automatic preparation requires validated German content but not a separate price review',()=>{
  const good={rightsVerified:true,contentReviewed:true,priceReviewed:true,germanCopy:{language:'de'}};
  assert.equal(reviewedSource(good),true);
  assert.equal(reviewedSource({...good,rightsVerified:false}),true);
  assert.equal(reviewedSource({...good,priceReviewed:false}),true);
  for(const field of ['contentReviewed','germanCopy'])
    assert.equal(reviewedSource({...good,[field]:false}),false);
});
test('automatic approval uses an available current Shopify price and does not require supplier-cost review',async()=>{
  let sql,params;await approveReviewed({pool:{query:async(q,p)=>{sql=q;params=p;return {rowCount:0};}}},{autonomyEnabled:true,excludedProductIds:['excluded']});
  assert.doesNotMatch(sql,/priceReviewed/);
  assert.match(sql,/p\.document->>'contentReviewed'='true'/);
  assert.match(sql,/jsonb_array_elements\(p\.document->'variants'\)/);
  assert.match(sql,/COALESCE\(\(v->>'price'\)::numeric,0\)>0/);
  assert.deepEqual(params,[['excluded']]);
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

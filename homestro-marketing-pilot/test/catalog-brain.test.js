import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogBrain,catalogDecision} from '../modules/catalog-brain.js';
const now=new Date('2026-10-25T12:00:00Z');
const product=(id='1')=>({id:'gid://shopify/Product/'+id,revision:'revision-'+id,status:'ACTIVE',url:'https://homestro.de/products/p-'+id,
  variants:[{available:true,price:39.9}],media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/photo-'+id+'.jpg'}}]});
test('whole-catalog decision reuses product photos/native footage and cannot authorize paid generation',()=>{
  const p=product(),d=catalogDecision(p,{now});
  assert.equal(d.eligible,true);assert.equal(d.sourceImageCount,1);assert.equal(d.paidGenerationAuthorized,false);
  assert.equal(d.tasks.video,'MOTION_VIDEO_COST_APPROVAL_REQUIRED');
  p.media.push({mediaContentType:'VIDEO',status:'READY',sources:[{url:'https://cdn.shopify.com/real.mp4',mimeType:'video/mp4',width:720,height:1280}]});
  assert.equal(catalogDecision(p,{now}).tasks.video,'reuse_native_product_footage');
  for(const patch of [{status:'DRAFT'},{rejected:true},{url:'https://other.example/products/test'},{variants:[{available:false,price:39.9}]}]){
    assert.equal(catalogDecision({...p,...patch},{now}).eligible,false);
  }
});
test('fresh human checkout evidence can prioritize preparation; stale/invalid data cannot become intent',()=>{
  const demand={status:'partial',byPath:{'/products/p-1':{sessions:12,carts:2,checkouts:1}}};
  assert.equal(catalogDecision(product(),{demand,demandUpdatedAt:now,now}).priority,152);
  assert.equal(catalogDecision(product(),{demand,demandUpdatedAt:new Date(now-3*3600000),now}).priority,0);
  demand.byPath['/products/p-1'].checkouts=Infinity;
  assert.equal(catalogDecision(product(),{demand,demandUpdatedAt:now,now}).priority,52);
});
function fixture({locked=true,failFirst=false}={}){
  let consumerRan=false;
  const queries=[],processed=[],products=Array.from({length:24},(_,i)=>product(String(i+1)));
  const query=async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked}]};
    if(sql==='SELECT document FROM marketing_products ORDER BY id')return {rows:products.map(document=>({document}))};
    if(sql.includes('to_regclass'))return {rows:[{present:null}]};
    if(sql.includes('SELECT product_id,source_revision'))return {rows:products.slice(0,2).map(p=>({product_id:p.id,source_revision:p.revision}))};
    if(sql.includes('GROUP BY channel,status'))return {rows:[{channel:'facebook',status:consumerRan?'approved':'draft_queued',count:1}]};
    return {rows:[],rowCount:1};
  };
  const client={query,release(){}};
  const pool={query,connect:async()=>client};
  const brain=new CatalogBrain({pool,clock:()=>now,processProduct:async id=>{
    processed.push(id);if(failFirst&&processed.length===1)throw new Error('temporary');
    return {processed:1,status:'draft_queued'};
  }});
  return {brain,queries,processed,afterConsumer(){consumerRan=true;}};
}
test('coordinator covers more than eleven products, reserves work, records queue receipts and isolates a failure',async()=>{
  const f=fixture({failFirst:true});await f.brain.migrate();
  const result=await f.brain.tick();
  assert.equal(result.catalogRecords,24);assert.equal(result.sourceImages,24);assert.equal(result.higgsfieldImportLimitApplied,false);
  assert.equal(result.processed,2);assert.equal(result.newPublicationConfirmed,false);assert.equal(result.paidGenerationPerformed,false);
  assert.equal(result.outcomes[0].status,'failed');assert.equal(result.outcomes[1].status,'draft_queued');
  assert.deepEqual(result.outcomes[1].receipts,[{channel:'facebook',status:'draft_queued',count:1}]);
  const reserves=f.queries.filter(x=>x.sql.includes("state='processing'"));assert.equal(reserves.length,2);
  assert.ok(reserves.every(x=>x.args[2]>now));
  assert.ok(f.queries.some(x=>x.sql.includes('pg_advisory_unlock(73341002)')));
  assert.ok(f.queries.find(x=>x.sql.includes('SELECT product_id,source_revision')).sql.includes('(last_attempt_at IS NOT NULL)'));
});
test('existing catalog lock and disabled mode prevent duplicate preparation or any provider work',async()=>{
  const f=fixture({locked:false});assert.equal((await f.brain.tick()).status,'catalog_sync_busy');
  assert.equal(f.processed.length,0);assert.equal(f.brain.busy,false);
  f.brain.enabled=false;assert.equal((await f.brain.tick()).status,'disabled');
});

test('existing consumers run once after preparation and ledger refreshes their actual approval receipts',async()=>{
  const f=fixture();let calls=0;
  f.brain.afterPrepare=async()=>{calls++;f.afterConsumer();};
  f.brain.autoApprovalEnabled=true;
  const result=await f.brain.tick();
  assert.equal(calls,1);assert.equal(result.consumerPreparation.status,'existing_consumers_checked');
  assert.ok(result.outcomes.every(x=>x.receipts[0].status==='approved'));
  assert.equal(result.newPublicationConfirmed,false);
});

test('brain report reads current native queues and excludes receipts from older source revisions',async()=>{
  const p=product(),queries=[];
  const pool={query:async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.includes('SELECT state,count'))return {rows:[{state:'prepared',count:1}]};
    if(sql.includes('SELECT product_id,decision,state,outcome'))return {rows:[{product_id:p.id,decision:catalogDecision(p),state:'prepared',outcome:{receipts:[{channel:'facebook',status:'published',count:99}]}}]};
    if(sql.includes('to_regclass'))return {rows:[{present:'marketing_social_posts'}]};
    if(sql.includes("payload->>'productRevision'"))return {rows:sql.includes('FROM marketing_social_posts')?[
      {product_id:p.id,revision:p.revision,channel:'pinterest',status:'draft_queued',count:1}]:[
      {product_id:p.id,revision:'old',channel:'facebook',status:'published',count:99},
      {product_id:p.id,revision:p.revision,channel:'facebook',status:'approved',count:1}]};
    throw Error(sql);
  }};
  const brain=new CatalogBrain({pool,processProduct:async()=>assert.fail('readback must not prepare')});
  const result=await brain.report();
  assert.deepEqual(result.products[0].currentReceipts,[{channel:'facebook',status:'approved',count:1},
    {channel:'pinterest',status:'draft_queued',count:1}]);
  assert.equal(queries.filter(q=>q.sql.includes("payload->>'productRevision'")).length,2);
  assert.equal(result.paidGenerationAuthorized,false);
});

test('catalog report paginates every product with stable cursors and page-local receipt reads',async()=>{
  const rows=Array.from({length:239},(_,i)=>{
    const p=product(String(i+1).padStart(4,'0'));
    return {product_id:p.id,decision:catalogDecision(p),state:'prepared',outcome:{}};
  });
  const queries=[],receiptBatches=[];
  const pool={query:async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.includes('SELECT state,count'))return {rows:[{state:'prepared',count:rows.length}]};
    if(sql.includes('SELECT product_id,decision,state,outcome')){
      assert.match(sql,/ORDER BY product_id ASC LIMIT 101/);
      assert.match(sql,/product_id>\$1/);assert.equal(args.length,1);
      return {rows:rows.filter(r=>args[0]===null||r.product_id>args[0]).slice(0,101)};
    }
    if(sql.includes('to_regclass'))return {rows:[{present:null}]};
    if(sql.includes("payload->>'productRevision'")){
      assert.ok(args[0].length<=100);receiptBatches.push([...args[0]]);
      return {rows:args[0].map(id=>({product_id:id,revision:rows.find(r=>r.product_id===id).decision.revision,
        channel:'facebook',status:'approved',count:1}))};
    }
    throw Error(sql);
  }};
  const brain=new CatalogBrain({pool,clock:()=>now,processProduct:async()=>assert.fail('read only')});
  const seen=[];let after=null;
  for(let page=0;page<3;page++){
    const result=await brain.report({after});
    assert.equal(result.counts[0].count,239);
    assert.equal(result.products.length,page<2?100:39);
    assert.equal(result.pageInfo.hasNextPage,page<2);
    assert.equal(result.pageInfo.endCursor,result.products.at(-1).product_id);
    assert.ok(result.products.every(p=>p.currentReceipts[0].status==='approved'));
    assert.deepEqual(receiptBatches[page],result.products.map(p=>p.product_id));
    seen.push(...result.products.map(p=>p.product_id));after=result.pageInfo.endCursor;
  }
  assert.equal(new Set(seen).size,239);assert.deepEqual(seen,rows.map(r=>r.product_id));
  assert.equal(seen.at(-1),product('0239').id);
  const empty=await brain.report({after});
  assert.deepEqual(empty.products,[]);assert.deepEqual(empty.pageInfo,{hasNextPage:false,endCursor:null});
  assert.equal(receiptBatches.length,3);
  assert.ok(queries.every(q=>!/^\s*(?:INSERT|UPDATE|DELETE|CREATE)/i.test(q.sql)));
});

test('catalog report rejects malformed cursors before any query and binds accepted cursors as SQL values',async()=>{
  let calls=0;
  const rejected=new CatalogBrain({pool:{query:async()=>{calls++;assert.fail('invalid cursor queried database');}}});
  for(const after of ['',false,1,[],{},'a'.repeat(257),'bad\u0000cursor','bad\ncursor']){
    await assert.rejects(rejected.report({after}),{code:'INVALID_CATALOG_CURSOR'});
  }
  assert.equal(calls,0);
  const after="gid://shopify/Product/1' OR true; --",queries=[];
  const brain=new CatalogBrain({pool:{query:async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.includes('to_regclass'))return {rows:[{present:null}]};
    return {rows:[]};
  }}});
  const result=await brain.report({after});
  assert.deepEqual(result.products,[]);
  const page=queries.find(q=>q.sql.includes('LIMIT 101'));
  assert.deepEqual(page.args,[after]);assert.ok(!page.sql.includes(after));
  assert.equal(result.pageInfo.hasNextPage,false);
});


test('catalog decisions preserve the existing owner exclusion policy',async()=>{
  const p=product();
  const decision=catalogDecision(p,{excludedProductIds:[p.id]});
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('PRODUCT_EXCLUDED_BY_POLICY'));
  assert.equal(catalogDecision(p,{excludedProductIds:[]}).eligible,true);
  const f=fixture();f.brain.excludedProductIds=[p.id];
  const result=await f.brain.tick();
  assert.equal(result.eligible,23);
  const update=f.queries.find(q=>q.sql.includes('INSERT INTO marketing_catalog_brain')&&q.args[0]===p.id);
  assert.equal(update.args[2].eligible,false);
  assert.equal(update.args[3],'blocked');
});

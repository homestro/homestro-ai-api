import test from 'node:test';
import assert from 'node:assert/strict';
import {runOneShot} from '../modules/one-shot.js';

const request={productId:'gid://shopify/Product/16104467562878',channel:'instagram',publish:true,
  reviewer:'Miroslav Skop',inputs:{rightsVerified:true,contentReviewed:true,priceReviewed:true,
    facts:[{id:'1',text:'four'},{id:'2',text:'square'},{id:'3',text:'plastic'}],
    germanCopy:{},reviewEvidence:'Owner requested supplier-image organic test'}};
function fixture({previous=null,changed=false}={}) {
  const cfg={workerEnabled:false,publishingEnabled:false};
  const calls=[];let released=0;
  const job={id:'11111111-1111-4111-8111-111111111111',product_id:request.productId,channel:'instagram',
    status:'draft_queued',payload:{format:'carousel',adSpendEUR:0,productRevision:'r1',imageURLs:['a','b']},remote:{}};
  const product={status:'ready',document:{revision:'r1'}};
  const client={release(){released++;},async query(sql,args=[]) {
    calls.push({sql,args});
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.includes("status IN ('publishing','published','recovery_required')"))return {rows:previous?[previous]:[]};
    if(sql.includes('SELECT count(*)'))return {rows:[{count:0}]};
    if(sql.includes("WHERE status='approved'")) {
      assert.match(sql,/AND id=\$1/);assert.equal(args[0],job.id);return {rows:job.status==='approved'?[job]:[]};
    }
    if(sql.includes("payload->>'productRevision'"))return {rows:[job]};
    if(sql.includes('SELECT id,status,remote,error_code'))return {rows:[{...job}]};
    return {rows:[],rowCount:1};
  }};
  const store={async product(){return product;},async approve(id,reviewer){
    assert.equal(id,job.id);job.status='approved';job.approved_by=reviewer;job.approved_at=new Date();},
    async withWorkerLock(fn){return fn(client);},
    async setStatus(id,status,error){assert.equal(id,job.id);job.status=status;job.error_code=error;},
    async checkpoint(id,remote){job.remote=remote;}};
  let publishes=0;
  const meta={cfg,async verifyConnection(){},async publish(j,checkpoint){publishes++;
    assert.equal(j.id,job.id);assert.equal(this.cfg.publishingEnabled,true);
    await checkpoint({phase:'published',postId:'123456789'});
  },async request(){return {id:'123456789',permalink:'https://www.instagram.com/p/test/',media_type:'CAROUSEL_ALBUM',children:{data:[{},{}]}};}};
  const args={request,instance:{store,async processProduct(){return {processed:1};}},
    pool:{async connect(){return client;}},cfg,meta,
    freshSnapshot:async()=>({revision:changed?'changed':'r1',status:'ACTIVE',variants:[{available:true,price:13.08}]})};
  return {args,calls,job,cfg,get publishes(){return publishes;},get released(){return released;}};
}
test('publishes only the requested draft and leaves background switches off',async()=>{
  const f=fixture();const result=await runOneShot(f.args);
  assert.equal(result.status,'published');assert.equal(f.publishes,1);
  assert.equal(f.cfg.workerEnabled,false);assert.equal(f.cfg.publishingEnabled,false);
  assert.equal(result.permalink,'https://www.instagram.com/p/test/');assert.equal(f.released,1);
});
for(const status of ['published','publishing','recovery_required'])test('restart never republishes '+status,async()=>{
  const f=fixture({previous:{id:'old',status,remote:{postId:'123'}}});
  assert.equal((await runOneShot(f.args)).status,status);assert.equal(f.publishes,0);
  assert.ok(!f.calls.some(c=>c.sql.includes('INSERT INTO marketing_inputs')));
});
test('changed product is superseded without publication',async()=>{
  const f=fixture({changed:true});const result=await runOneShot(f.args);
  assert.equal(result.status,'superseded');assert.equal(f.publishes,0);
});
test('missing reviewed inputs is rejected before database access',async()=>{
  const f=fixture();f.args.request={...request,inputs:{...request.inputs,rightsVerified:false}};
  await assert.rejects(runOneShot(f.args),/ONE_SHOT_REVIEW_REQUIRED/);assert.equal(f.calls.length,0);
});

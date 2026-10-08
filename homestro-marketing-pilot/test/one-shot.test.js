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
    pool:{async connect(){return client;},query:(sql,args)=>client.query(sql,args)},cfg,meta,
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
  const f=fixture();f.args.request={...request,inputs:{...request.inputs,contentReviewed:false}};
  await assert.rejects(runOneShot(f.args),/ONE_SHOT_REVIEW_REQUIRED/);assert.equal(f.calls.length,0);
});

function recoveryFixture({containerStatus='FINISHED',alreadyAttempted=false,found=false}={}) {
  const previous={id:'11111111-1111-4111-8111-111111111111',product_id:request.productId,channel:'instagram',
    status:'recovery_required',approved_by:'owner',approved_at:new Date(),
    payload:{format:'carousel',adSpendEUR:0,productRevision:'r1',caption:'expected caption'},
    remote:{containerId:'1234',children:['1','2'],recoveryAttempted:alreadyAttempted}};
  const f=fixture({previous});f.args.request={...request,recover:true};const requests=[];
  f.args.cfg.instagramId='5678';
  f.args.meta.request=async(path,options={})=>{
    requests.push({path,options});
    if(path==='1234')return {status_code:containerStatus};
    if(path==='5678/media')return {data:found?[{id:'999',caption:'expected caption',permalink:'https://www.instagram.com/p/actual/',media_type:'CAROUSEL_ALBUM'}]:[]};
    if(path==='5678/media_publish')return {id:'999'};
    if(path==='999')return {id:'999',permalink:'https://www.instagram.com/p/actual/',media_type:'CAROUSEL_ALBUM',children:{data:[{},{}]}};
    throw new Error('Unexpected recovery request');
  };
  return {f,requests};
}
test('recovery resumes only the existing FINISHED parent once',async()=>{
  const {f,requests}=recoveryFixture();const result=await runOneShot(f.args);
  assert.equal(result.status,'published');
  const writes=requests.filter(r=>r.options.method==='POST');
  assert.equal(writes.length,1);assert.equal(writes[0].options.body.creation_id,'1234');
  assert.ok(!requests.some(r=>r.options.method==='POST' && r.path.endsWith('/media')));
});
test('published matching caption is reconciled without another mutation',async()=>{
  const {f,requests}=recoveryFixture({containerStatus:'PUBLISHED',found:true});
  assert.equal((await runOneShot(f.args)).status,'published');
  assert.equal(requests.filter(r=>r.options.method==='POST').length,0);
});
for(const options of [{containerStatus:'PUBLISHED'},{alreadyAttempted:true}])test('uncertain or already retried parent is not published again '+JSON.stringify(options),async()=>{
  const {f,requests}=recoveryFixture(options);
  assert.equal((await runOneShot(f.args)).status,'recovery_required');
  assert.equal(requests.filter(r=>r.options.method==='POST').length,0);
});

test('Facebook test uses only its requested draft and verifies the Facebook permalink',async()=>{
  const f=fixture();f.args.request={...request,channel:'facebook'};f.job.channel='facebook';
  f.args.meta.publish=async(job,checkpoint)=>{
    assert.equal(job.channel,'facebook');assert.equal(f.args.meta.cfg.maxDailyPosts,2);
    await checkpoint({phase:'published',postId:'187533961115946_999'});
  };
  f.args.meta.request=async(path,options)=>{
    assert.equal(path,'187533961115946_999');
    assert.match(options.fields,/permalink_url/);
    return {id:path,permalink_url:'https://www.facebook.com/187533961115946/posts/999',attachments:{data:[{subattachments:{data:[{},{}]}}]}};
  };
  const result=await runOneShot(f.args);
  assert.equal(result.status,'published');
  assert.equal(result.permalink,'https://www.facebook.com/187533961115946/posts/999');
  assert.equal(f.cfg.publishingEnabled,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {GeneratedVideoDrafts} from '../modules/generative-video.js';
import {carouselAssetKey} from '../modules/media.js';
const image='https://cdn.shopify.com/real.jpg',origin='https://pilot.example',task='12e3a630-4f0c-4135-bc67-ff4378aa9c14';
const input={productId:'p',revision:'r',promptImage:origin+'/marketing-assets/'+carouselAssetKey(image)+'.jpg',promptText:'A hand gently uses the referenced brush while the cat naturally moves.'};
function fixture({enabled=true,key='test',spent=0,lost=false,imported=false,native=false}={}){
 let row=null,calls=0,quote=null;const query=async(sql,args=[])=>{
  if(sql.includes('pg_try'))return {rows:[{locked:true}]};
  if(sql.startsWith('INSERT INTO marketing_video_quotes')){quote={quote:args[1],expires_at:args[2]};return {rows:[]};}
  if(sql.startsWith('SELECT quote,expires_at'))return {rows:quote?[quote]:[]};
  if(sql.startsWith('SELECT *'))return {rows:row?.job_key===args[0]?[row]:[]};
  if(sql.startsWith('SELECT job_id'))return {rows:imported?[{job_id:task}]:[]};
  if(sql.startsWith('SELECT job_key FROM marketing_generated_videos WHERE product_id'))return {rows:row?[{job_key:row.job_key}]:[]};
  if(sql.startsWith('SELECT COALESCE'))return {rows:[{spent}]};
  if(sql.startsWith('INSERT INTO marketing_generated_videos'))row={job_key:args[0],product_id:args[1],revision:args[2],state:'submit_intent',cost_cents:25};
  if(sql.includes("state='pending'")){row.state='pending';row.task_id=args[1];}
  if(sql.includes("state='review_required'")){row.state='review_required';row.video_url=args[1];}
  if(sql.includes("state='recovery_required'")){row.state='recovery_required';row.error_code=args[1];}
  return {rows:[]};
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const worker=new GeneratedVideoDrafts({pool,cfg:{enabled,key,publicOrigin:origin,dailyCents:25},fresh:async()=>({status:'ACTIVE',revision:'r',media:[{mediaContentType:'IMAGE',status:'READY',image:{url:image}},...(native?[{mediaContentType:'VIDEO',status:'READY',sources:[{url:'https://cdn.shopify.com/existing.mp4',mimeType:'video/mp4'}]}]:[])]}),fetchImpl:async(url,options)=>{
  if(options.method==='GET')return new Response(JSON.stringify({id:task,status:'SUCCEEDED',output:['https://cdn.runwayml.com/clip.mp4']}),{status:200});
  calls++;assert.equal(url,'https://api.dev.runwayml.com/v1/image_to_video');const body=JSON.parse(options.body);
  assert.equal(body.duration,5);assert.equal(body.model,'gen4_turbo');assert.equal(body.ratio,'720:1280');
  if(lost)throw new Error('network lost');return new Response(JSON.stringify({id:task}),{status:200});
 }});
 return {worker,expireQuote(){quote.expires_at=new Date(0);},get calls(){return calls;}};
}
test('generative motion needs its own key and opt-in and respects the spending cap',async()=>{
 for(const opts of [{enabled:false},{key:''},{spent:25}]){
  const f=fixture(opts);await assert.rejects(()=>f.worker.start(input));assert.equal(f.calls,0);
 }
});
test('one durable scene intent does not charge again for repeated start requests',async()=>{
 const f=fixture();const approved=await approvedInput(f.worker);const first=await f.worker.start(approved),again=await f.worker.start(approved);
 assert.equal(first.taskId,task);assert.equal(first.requiresReview,true);assert.equal(first.estimatedUSD,.25);
 assert.equal(again.jobKey,first.jobKey);assert.equal(f.calls,1);
});
test('a lost generation response stays held and is never blindly retried',async()=>{
 const f=fixture({lost:true});const approved=await approvedInput(f.worker);await assert.rejects(()=>f.worker.start(approved));
 const held=await f.worker.start(approved);assert.equal(held.state,'recovery_required');assert.equal(f.calls,1);
});

test('completed generated motion remains a review draft and is never auto-published',async()=>{
 const f=fixture();const started=await f.worker.start(await approvedInput(f.worker)),done=await f.worker.poll(started.jobKey);
 assert.equal(done.state,'review_required');assert.equal(done.requiresReview,true);assert.equal(done.videoURL,'https://cdn.runwayml.com/clip.mp4');assert.equal(f.calls,1);
});

test('automatic completion polling reads only persisted tasks, isolates failures and never starts generation',async()=>{
 const keys=['a'.repeat(64),'b'.repeat(64)],tasks=[task,'11111111-1111-1111-1111-111111111111'];
 const jobs=new Map(keys.map((key,i)=>[key,{job_key:key,task_id:tasks[i],state:'pending',cost_cents:25}]));let gets=0;
 const pool={query:async(sql,args=[])=>{
  if(sql.startsWith('SELECT job_key')){assert.match(sql,/LIMIT 10/);return {rows:keys.map(job_key=>({job_key}))};}
  if(sql.startsWith('SELECT *'))return {rows:[jobs.get(args[0])]};
  if(sql.includes('SET updated_at=now()'))return {rowCount:1};
  if(sql.includes("state='review_required'")){assert.match(sql,/AND state='pending' AND task_id=/);Object.assign(jobs.get(args[0]),{state:'review_required',video_url:args[1]});return {rowCount:1};}
  throw Error(sql);
 }};
 const worker=new GeneratedVideoDrafts({pool,cfg:{key:'existing',enabled:false},fetchImpl:async(url,options)=>{
  gets++;assert.equal(options.method,'GET');assert.match(url,/\/tasks\//);
  if(url.endsWith(tasks[0]))return new Response('{}',{status:503});
  return new Response(JSON.stringify({id:tasks[1],status:'SUCCEEDED',output:['https://cdn.runwayml.com/completed.mp4']}));
 }});
 const result=await worker.pollPending();
 assert.equal(gets,2);assert.equal(result.checked,2);assert.equal(result.generationPerformed,false);
 assert.equal(result.outcomes[0].state,'verification_pending');assert.equal(result.outcomes[1].state,'review_required');
 assert.equal(worker.pollBusy,false);
});

test('a late provider read cannot downgrade a task that already reached its native queues',async()=>{
 const key='a'.repeat(64),row={job_key:key,task_id:task,state:'pending',cost_cents:25};
 const pool={query:async(sql)=>{
  if(sql.startsWith('SELECT *'))return {rows:[{...row}]};
  assert.match(sql,/AND state='pending'/);return {rowCount:0};
 }};
 const worker=new GeneratedVideoDrafts({pool,cfg:{key:'existing'},fetchImpl:async()=>{
  row.state='queued';return new Response(JSON.stringify({id:task,status:'SUCCEEDED',output:['https://cdn.runwayml.com/completed.mp4']}));
 }});
 assert.equal((await worker.poll(key)).state,'queued');
});

async function approvedInput(worker){
 const quote=await worker.quote(input);
 return {...input,costApproval:{quoteId:quote.quoteId,approved:true,approvedCostCents:25,currency:'USD',reviewer:'test-owner'}};
}
test('quote is a persisted no-charge step; unquoted, expired or mismatched approvals never call provider',async()=>{
 const f=fixture();
 await assert.rejects(()=>f.worker.start(input),{code:'GENERATION_PRICE_APPROVAL_REQUIRED'});
 const approved=await approvedInput(f.worker);assert.equal(f.calls,0);
 for(const change of [{approved:false},{approvedCostCents:26},{currency:'EUR'},{quoteId:'x'},{reviewer:''}]){
  await assert.rejects(()=>f.worker.start({...approved,costApproval:{...approved.costApproval,...change}}),{code:'GENERATION_PRICE_APPROVAL_REQUIRED'});
 }
 assert.equal(f.calls,0);
 f.expireQuote();await assert.rejects(()=>f.worker.start(approved),{code:'GENERATION_PRICE_APPROVAL_REQUIRED'});
});

test('native/imported video or another in-flight prompt for the same source is reused before any new charge',async()=>{
 const native=fixture({native:true});await assert.rejects(()=>native.worker.quote(input),{code:'EXISTING_NATIVE_VIDEO_AVAILABLE'});assert.equal(native.calls,0);
 const imported=fixture({imported:true});const reuse=await imported.worker.quote(input);
 assert.equal(reuse.reuseExisting,true);assert.equal(reuse.importedJobId,task);assert.equal(imported.calls,0);
 const f=fixture();await f.worker.start(await approvedInput(f.worker));
 const alternative=await f.worker.quote({...input,promptText:input.promptText+' Keep the original colors.'});
 assert.equal(alternative.reuseExisting,true);assert.ok(alternative.existingJobKey);assert.equal(f.calls,1);
});

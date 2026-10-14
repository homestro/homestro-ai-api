import test from 'node:test';
import assert from 'node:assert/strict';
import {GeneratedVideoDrafts} from '../modules/generative-video.js';
import {carouselAssetKey} from '../modules/media.js';
const image='https://cdn.shopify.com/real.jpg',origin='https://pilot.example',task='12e3a630-4f0c-4135-bc67-ff4378aa9c14';
const input={productId:'p',revision:'r',promptImage:origin+'/marketing-assets/'+carouselAssetKey(image)+'.jpg',promptText:'A hand gently uses the referenced brush while the cat naturally moves.'};
function fixture({enabled=true,key='test',spent=0,lost=false}={}){
 let row=null,calls=0;const query=async(sql,args=[])=>{
  if(sql.includes('pg_try'))return {rows:[{locked:true}]};
  if(sql.startsWith('SELECT *'))return {rows:row?[row]:[]};
  if(sql.startsWith('SELECT COALESCE'))return {rows:[{spent}]};
  if(sql.startsWith('INSERT'))row={job_key:args[0],state:'submit_intent',cost_cents:25};
  if(sql.includes("state='pending'")){row.state='pending';row.task_id=args[1];}
  if(sql.includes("state='review_required'")){row.state='review_required';row.video_url=args[1];}
  if(sql.includes("state='recovery_required'")){row.state='recovery_required';row.error_code=args[1];}
  return {rows:[]};
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const worker=new GeneratedVideoDrafts({pool,cfg:{enabled,key,publicOrigin:origin,dailyCents:25},fresh:async()=>({status:'ACTIVE',revision:'r',media:[{mediaContentType:'IMAGE',status:'READY',image:{url:image}}]}),fetchImpl:async(url,options)=>{
  if(options.method==='GET')return new Response(JSON.stringify({id:task,status:'SUCCEEDED',output:['https://cdn.runwayml.com/clip.mp4']}),{status:200});
  calls++;assert.equal(url,'https://api.dev.runwayml.com/v1/image_to_video');const body=JSON.parse(options.body);
  assert.equal(body.duration,5);assert.equal(body.model,'gen4_turbo');assert.equal(body.ratio,'720:1280');
  if(lost)throw new Error('network lost');return new Response(JSON.stringify({id:task}),{status:200});
 }});
 return {worker,get calls(){return calls;}};
}
test('generative motion needs its own key and opt-in and respects the spending cap',async()=>{
 for(const opts of [{enabled:false},{key:''},{spent:25}]){
  const f=fixture(opts);await assert.rejects(()=>f.worker.start(input));assert.equal(f.calls,0);
 }
});
test('one durable scene intent does not charge again for repeated start requests',async()=>{
 const f=fixture();const first=await f.worker.start(input),again=await f.worker.start(input);
 assert.equal(first.taskId,task);assert.equal(first.requiresReview,true);assert.equal(first.estimatedUSD,.25);
 assert.equal(again.jobKey,first.jobKey);assert.equal(f.calls,1);
});
test('a lost generation response stays held and is never blindly retried',async()=>{
 const f=fixture({lost:true});await assert.rejects(()=>f.worker.start(input));
 const held=await f.worker.start(input);assert.equal(held.state,'recovery_required');assert.equal(f.calls,1);
});

test('completed generated motion remains a review draft and is never auto-published',async()=>{
 const f=fixture();const started=await f.worker.start(input),done=await f.worker.poll(started.jobKey);
 assert.equal(done.state,'review_required');assert.equal(done.requiresReview,true);assert.equal(done.videoURL,'https://cdn.runwayml.com/clip.mp4');assert.equal(f.calls,1);
});

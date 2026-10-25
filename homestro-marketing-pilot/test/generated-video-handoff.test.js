import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {downloadGeneratedVideo,handoffGeneratedVideo} from '../modules/generated-video-handoff.js';
import {ImportedMediaCoordinator,importMetadata} from '../modules/imported-media.js';

const task='12e3a630-4f0c-4135-bc67-ff4378aa9c14',key='a'.repeat(64),url='https://cdn.runwayml.com/clip.mp4?signature=private';
const product={id:'gid://shopify/Product/1',revision:'rev',status:'ACTIVE',contentReviewed:true,categoryKey:'home',
  url:'https://homestro.de/products/box',variants:[{available:true,price:39.9}],
  localized:{title:'Aufbewahrungsbox',hook:'Entdecke die Aufbewahrungsbox',benefits:[{text:'Mit Deckel.'}]}};
const review={reviewer:'owner',content_preview_confirmed:true,product_fidelity_confirmed:true,
  expectedRevision:'rev',expectedTaskId:task,expectedVideoURL:url};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'generated-handoff-'));
  execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=180x320:d=5',
    '-c:v','libx264','-pix_fmt','yuv420p','-threads','1',join(dir,'valid.mp4')]);
  const bytes=await readFile(join(dir,'valid.mp4')),imports=new Map(),posts=new Map();let downloads=0,failFinal=false;
  const job={job_key:key,task_id:task,product_id:product.id,revision:product.revision,video_url:url,state:'review_required',review:{},handoff:{}};
  const query=async(q,args=[])=>{
    if(q.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(q.includes('SELECT * FROM marketing_generated_videos'))return {rows:[job]};
    if(q.includes("SET state='handoff_pending'")){Object.assign(job,{state:'handoff_pending',review:args[1],handoff:args[2]});}
    if(q.includes("UPDATE marketing_generated_videos SET state='queued'")){
      if(failFinal){failFinal=false;throw Error('lost local acknowledgement');}
      Object.assign(job,{state:'queued',handoff:args[1]});
    }
    if(q.includes('SELECT * FROM marketing_imported_media'))return {rows:imports.has(args[0])?[imports.get(args[0])]:[]};
    if(q.includes('SELECT document,status FROM marketing_products'))return {rows:[{document:product,status:'ready'}]};
    if(q.includes('INSERT INTO marketing_imported_media'))imports.set(args[0],{job_id:args[0],checksum:args[1],product_id:args[2],product_revision:args[3],metadata:args[4],state:'receiving'});
    if(q.includes('INSERT INTO marketing_posts')||q.includes('INSERT INTO marketing_social_posts')){
      const identity=[args[1],args[2],args[3]].join('|');
      if(!posts.has(identity))posts.set(identity,{id:args[0],status:'draft_queued',payload:args[4],channel:args[2]});
    }
    if(q.includes('SELECT id,status FROM marketing_'))return {rows:[posts.get(args.join('|'))].filter(Boolean)};
    if(q.includes("UPDATE marketing_imported_media SET state='queued'"))Object.assign(imports.get(args[0]),{state:'queued',asset:args[1],receipt:args[2]});
    if(q.includes('SELECT receipt,state FROM marketing_imported_media'))return {rows:[imports.get(args[0])].filter(Boolean)};
    if(q.includes('SELECT id,status,remote,payload FROM marketing_'))return {rows:[...posts.values()].filter(p=>p.id===args[0])};
    return {rows:[],rowCount:1};
  };
  const pool={query,connect:async()=>({query,release(){}})},cfg={dataDir:dir,publicOrigin:'https://publisher.example'};
  const importer=new ImportedMediaCoordinator({pool,cfg,fresh:async()=>product,social:{providerCfg:{accounts:{tiktok:'t',pinterest:'p'},boardId:'board'}}});
  const input={pool,cfg,key,fresh:async()=>product,importedMedia:importer,body:review,
    fetchImpl:async(_url,options)=>{
      downloads++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['X-Runway-Version'],undefined);
      return new Response(bytes,{headers:{'content-type':'video/mp4'}});
    }};
  return {dir,job,bytes,imports,posts,input,get downloads(){return downloads;},interruptFinal(){failFinal=true;}};
}

test('safe generated download rejects foreign/private hosts, redirects and oversized streams without credentials',async()=>{
  for(const bad of ['http://cdn.runwayml.com/v.mp4','https://127.0.0.1/v.mp4','https://localhost/v.mp4',
    'https://cdn.runwayml.com.attacker.example/v.mp4','https://name:password@cdn.runwayml.com/v.mp4','https://cdn.runwayml.com:8443/v.mp4']){
    await assert.rejects(downloadGeneratedVideo(bad,{fetchImpl:()=>assert.fail('must not fetch')}),{code:'UNTRUSTED_GENERATED_DOWNLOAD'});
  }
  await assert.rejects(downloadGeneratedVideo(url,{maxBytes:3,fetchImpl:async()=>new Response('large',{headers:{'content-type':'video/mp4'}})}),{code:'GENERATED_DOWNLOAD_SIZE_LIMIT'});
  await assert.rejects(downloadGeneratedVideo(url,{fetchImpl:async()=>new Response('html',{headers:{'content-type':'text/html'}})}),{code:'GENERATED_DOWNLOAD_TYPE_INVALID'});
});

test('handoff requires real exact visual review and current source before any download',async()=>{
  const f=await fixture();try{
    for(const body of [{...review,content_preview_confirmed:false},{...review,product_fidelity_confirmed:false},
      {...review,expectedTaskId:'other'},{...review,expectedVideoURL:'https://cdn.runwayml.com/other.mp4'},{...review,expectedRevision:'changed'}]){
      await assert.rejects(handoffGeneratedVideo({...f.input,body}),{code:'GENERATED_VISUAL_REVIEW_REQUIRED'});
    }
    await assert.rejects(handoffGeneratedVideo({...f.input,fresh:async()=>({...product,revision:'changed'})}),{code:'SOCIAL_REVIEW_STALE'});
    f.job.state='pending';await assert.rejects(handoffGeneratedVideo(f.input),{code:'GENERATED_VIDEO_NOT_COMPLETED'});
    assert.equal(f.downloads,0);assert.equal(f.posts.size,0);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('reviewed real MP4 reaches all native draft queues and replay neither downloads nor duplicates',async()=>{
  const f=await fixture();try{
    const result=await handoffGeneratedVideo(f.input);
    assert.equal(result.state,'queued');assert.equal(result.queueReceipt.posts.length,4);assert.equal(f.posts.size,4);
    assert.equal(result.publicationConfirmed,false);assert.equal(result.newPaidRequestPerformed,false);
    assert.equal(f.imports.get(task).metadata.provider,'runway');
    for(const post of f.posts.values()){
      assert.equal(post.status,'draft_queued');assert.equal(post.payload.requiresVisualReview,true);
      assert.equal(post.payload.format,'reels');assert.equal(post.payload.tiktokSettings,undefined);
    }
    assert.equal(f.job.review.tiktokConsentTransferred,false);assert.equal(f.downloads,1);
    await rm(join(f.dir,'generated-downloads'),{recursive:true,force:true});
    const replay=await handoffGeneratedVideo(f.input);
    assert.equal(replay.state,'queued');assert.equal(f.downloads,1);assert.equal(f.posts.size,4);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('lost local acknowledgement recovers existing receiver receipt without another download or queue row',async()=>{
  const f=await fixture();try{
    f.interruptFinal();await assert.rejects(handoffGeneratedVideo(f.input));
    assert.equal(f.job.state,'handoff_pending');assert.equal(f.posts.size,4);
    assert.equal((await handoffGeneratedVideo(f.input)).state,'queued');
    assert.equal(f.downloads,1);assert.equal(f.posts.size,4);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('public import cannot impersonate Runway and internal import rejects missing persisted review',async()=>{
  const f=await fixture();try{
    const metadata={provider:'runway',job_id:task,generation_job_key:key,kind:'video',sha256:sha(f.bytes),
      product_url:product.url,product_id:product.id,product_revision:'rev',source_video_url:url};
    assert.throws(()=>importMetadata(Buffer.from(JSON.stringify(metadata)).toString('base64'),f.bytes));
    await assert.rejects(f.input.importedMedia.receiveGenerated(metadata,f.bytes),{code:'GENERATED_VISUAL_REVIEW_REQUIRED'});
    assert.equal(f.posts.size,0);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('invalid downloaded media never enters a native queue and cannot be marked queued',async()=>{
  const f=await fixture();try{
    await assert.rejects(handoffGeneratedVideo({...f.input,fetchImpl:async()=>new Response('not an MP4',{headers:{'content-type':'video/mp4'}})}),{code:'IMPORTED_MEDIA_PROBE_FAILED'});
    assert.equal(f.posts.size,0);assert.equal(f.job.state,'handoff_pending');
    assert.equal(f.job.handoff.receipt,undefined);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('internal generated import verifies persisted task and checksum instead of trusting request metadata',async()=>{
  const f=await fixture();try{
    const metadata={provider:'runway',job_id:task,generation_job_key:key,kind:'video',sha256:sha(f.bytes),
      product_url:product.url,product_id:product.id,product_revision:'rev',source_video_url:url};
    f.job.state='handoff_pending';f.job.review={...review};f.job.handoff={sha256:metadata.sha256};
    for(const altered of [{...metadata,source_video_url:'https://cdn.runwayml.com/foreign.mp4'},
      {...metadata,product_id:'gid://shopify/Product/2'},{...metadata,product_revision:'other'},
      {...metadata,job_id:'11111111-1111-1111-1111-111111111111'}]){
      await assert.rejects(f.input.importedMedia.receiveGenerated(altered,f.bytes),{code:'GENERATED_VISUAL_REVIEW_REQUIRED'});
    }
    assert.equal(f.posts.size,0);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

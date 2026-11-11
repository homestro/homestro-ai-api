import {randomUUID} from 'node:crypto';
import {handoffGeneratedVideo} from './generated-video-handoff.js';
import {hash,fail,codeOf,log} from './core.js';
import {extractMedia,carouselAssetKey} from './media.js';
const uuid=v=>/^[a-f0-9-]{36}$/.test(v||'');
const view=r=>({jobKey:r.job_key,state:r.state,taskId:r.task_id||null,videoURL:r.video_url||null,
  estimatedUSD:r.cost_cents/100,error:r.error_code||null,requiresReview:true});
const aspectRatio=value=>({ '9:16':'720:1280','16:9':'1280:720' })[value]||null;

// The studio only returns a draft asset. It never approves claims or publishes.
export class GeneratedVideoDrafts {
  constructor({pool,cfg,fresh,fetchImpl=fetch}){Object.assign(this,{pool,cfg,fresh,fetch:fetchImpl});}
  async migrate(){
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_generated_videos(
      job_key text PRIMARY KEY,product_id text NOT NULL,revision text NOT NULL,request jsonb NOT NULL,
      state text NOT NULL,task_id text,video_url text,error_code text,cost_cents integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_video_quotes(job_key text PRIMARY KEY,quote jsonb NOT NULL,expires_at timestamptz NOT NULL)`);
    await this.pool.query("ALTER TABLE marketing_generated_videos ADD COLUMN IF NOT EXISTS review jsonb NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS handoff jsonb NOT NULL DEFAULT '{}'");
  }
  async handoff(key,body,importedMedia){
    const row=(await this.pool.query('SELECT request FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0];
    if(row?.request?.studio?.style==='cartoon')fail('VIDEO_STUDIO_THEME_CANNOT_HANDOFF_TO_PRODUCT');
    return handoffGeneratedVideo({pool:this.pool,cfg:this.cfg,fresh:this.fresh,fetchImpl:this.fetch,key,body,importedMedia});
  }
  async request(path,body){
    if(!/^(?:image_to_video|text_to_video|tasks\/[a-f0-9-]{36})$/.test(path))fail('GENERATIVE_ENDPOINT_BLOCKED');
    const r=await this.fetch('https://api.dev.runwayml.com/v1/'+path,{method:body?'POST':'GET',redirect:'error',
      headers:{Authorization:'Bearer '+this.cfg.key,'X-Runway-Version':'2024-11-06','Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    if(!r.ok)fail(r.status===401||r.status===403?'RUNWAY_AUTH_FAILED':r.status===429?'RUNWAY_RATE_LIMIT':'RUNWAY_REQUEST_FAILED');
    return r.json();
  }
  async specification(input){
    const {productId,revision,promptImage,promptText,topic}=input||{};
    const style=({realistic:'real',animated:'cartoon'})[input?.style]||input?.style||'real';
    const ratio=aspectRatio(input?.aspectRatio||'9:16');
    if(!['real','cartoon'].includes(style)||!ratio)fail('INVALID_VIDEO_STUDIO_OPTIONS');
    const text=String(promptText||topic||'').trim();
    if(text.length<30||text.length>650)fail('INVALID_GENERATIVE_SCENE');
    const duration=5;
    if(style==='real'){
      if(!/^gid:\/\/shopify\/Product\/\d+$/.test(productId||'')||typeof revision!=='string')fail('INVALID_PRODUCT_ID');
      let u;try{u=new URL(promptImage);}catch{fail('UNTRUSTED_PUBLISH_ASSET');}
      if(u.origin!==this.cfg.publicOrigin||u.search||u.hash||u.username||u.password||!/^\/marketing-assets\/[a-f0-9]{64}\.jpg$/.test(u.pathname))fail('UNTRUSTED_PUBLISH_ASSET');
      const product=await this.fresh(productId);
      if(product.status!=='ACTIVE'||product.rejected||product.revision!==revision)fail('SOCIAL_REVIEW_STALE');
      if(!extractMedia(product.media).images.some(image=>u.pathname.endsWith('/'+carouselAssetKey(image)+'.jpg')))fail('GENERATIVE_SOURCE_MISMATCH');
      const nativeVideo=extractMedia(product.media).videoURL;
      const body={model:'gen4_turbo',promptImage:u.href,ratio,duration,
        promptText:'Photorealistic product video. '+text+
          ' Keep the referenced product shape, color, proportions and branding unchanged. Show natural product movement and lighting, not only camera zoom. Do not invent specifications, people endorsements, text, logos, reviews or product claims.'};
      return {style,productId,revision,body,path:'image_to_video',key:hash({style,productId,revision,body}),nativeVideo,duration,creditsPerSecond:5};
    }
    const themeId=String(input?.themeId||'custom').trim().slice(0,80)||'custom';
    const productKey='studio:'+hash({themeId,text});
    const body={model:'gen4.5',ratio,duration,promptText:'Illustrated / animated 2D scene. '+text+
      ' Use original fictional visuals, smooth movement, coherent scene continuity, and no copyrighted characters or logos.'};
    return {style,productId:productKey,revision:'theme-v1',body,path:'text_to_video',
      key:hash({style,productKey,body}),nativeVideo:null,duration,creditsPerSecond:12};
  }
  async quote(input){
    const spec=await this.specification(input);
    if(spec.nativeVideo)return {reuseExisting:true,existingVideoURL:spec.nativeVideo,
      source:'Shopify product media',generationPerformed:false,requiresReview:false};
    const existing=(await this.pool.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[spec.key])).rows[0];
    if(existing)return {reuseExisting:true,existing:view(existing),generationPerformed:false};
    if(spec.style==='real'){
      const imported=(await this.pool.query("SELECT job_id FROM marketing_imported_media WHERE product_id=$1 AND product_revision=$2 AND metadata->>'kind'='video' AND state='queued' LIMIT 1",[spec.productId,spec.revision])).rows;
      if(imported.length)return {reuseExisting:true,importedJobId:imported[0].job_id,generationPerformed:false};
      const other=(await this.pool.query("SELECT job_key FROM marketing_generated_videos WHERE product_id=$1 AND revision=$2 AND state NOT IN ('failed') LIMIT 1",[spec.productId,spec.revision])).rows;
      if(other.length)return {reuseExisting:true,existingJobKey:other[0].job_key,generationPerformed:false};
    }
    const costCents=spec.creditsPerSecond*spec.duration;
    const expires=new Date(Date.now()+30*60000);
    const quote={quoteId:randomUUID(),requestKey:spec.key,productId:spec.productId,style:spec.style,
      model:spec.body.model,durationSeconds:spec.duration,aspectRatio:input?.aspectRatio||'9:16',
      estimatedCostCents:costCents,currency:'USD',taxIncluded:false,additionalAttemptsIncluded:false,
      pricingSource:'https://docs.dev.runwayml.com/guides/pricing/',creditsPerSecond:spec.creditsPerSecond,
      priceVersion:'Runway-1-cent-per-credit-2026-11-11',expiresAt:expires.toISOString(),generationPerformed:false};
    await this.pool.query(`INSERT INTO marketing_video_quotes(job_key,quote,expires_at) VALUES($1,$2,$3)
      ON CONFLICT(job_key) DO UPDATE SET quote=$2,expires_at=$3`,[spec.key,quote,expires]);
    return quote;
  }
  async start(input){
    if(!this.cfg.videoGenerationEnabled||!this.cfg.enabled)fail('VIDEO_GENERATION_DISABLED');
    if(!this.cfg.key)fail('RUNWAY_API_KEY_REQUIRED');
    const spec=await this.specification(input),{productId,revision,body,key,nativeVideo}=spec;
    let client,locked=false;
    try{
      client=await this.pool.connect();locked=(await client.query('SELECT pg_try_advisory_lock(73341009) AS locked')).rows[0]?.locked;
      if(!locked)fail('GENERATIVE_VIDEO_BUSY');
      const existing=(await client.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0];
      if(existing)return view(existing);
      const quote=(await client.query('SELECT quote,expires_at FROM marketing_video_quotes WHERE job_key=$1',[key])).rows[0];
      const approval=input.costApproval,costCents=spec.creditsPerSecond*spec.duration;
      if(!quote||!Number.isFinite(new Date(quote.expires_at).getTime())||new Date(quote.expires_at).getTime()<=Date.now()||
        quote.quote.estimatedCostCents!==costCents||quote.quote.currency!=='USD'||!uuid(quote.quote?.quoteId)||
        approval?.quoteId!==quote.quote.quoteId||approval.approved!==true||approval.approvedCostCents!==costCents||
        approval.currency!=='USD'||typeof approval.reviewer!=='string'||!approval.reviewer.trim()||approval.reviewer.length>100)
        fail('GENERATION_PRICE_APPROVAL_REQUIRED');
      if(nativeVideo)fail('EXISTING_NATIVE_VIDEO_AVAILABLE');
      if(spec.style==='real'){
        const imported=(await client.query("SELECT job_id FROM marketing_imported_media WHERE product_id=$1 AND product_revision=$2 AND metadata->>'kind'='video' AND state='queued' LIMIT 1",[productId,revision])).rows;
        const other=(await client.query("SELECT job_key FROM marketing_generated_videos WHERE product_id=$1 AND revision=$2 AND state<>'failed' LIMIT 1",[productId,revision])).rows;
        if(imported.length||other.length)fail('EXISTING_VIDEO_REUSE_REQUIRED');
      }
      const spent=Number((await client.query(`SELECT COALESCE(sum(cost_cents),0)::int AS spent FROM marketing_generated_videos
        WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`)).rows[0]?.spent);
      if(!Number.isFinite(spent)||spent+costCents>Number(this.cfg.dailyCents||60))fail('GENERATIVE_VIDEO_DAILY_LIMIT');
      // Record intent before the provider call; an uncertain response is never retried blindly.
      await client.query(`INSERT INTO marketing_generated_videos(job_key,product_id,revision,request,state,cost_cents)
        VALUES($1,$2,$3,$4,'submit_intent',$5)`,[key,productId,revision,JSON.stringify({...body,
          studio:{style:spec.style,aspectRatio:input.aspectRatio||'9:16'},costApproval:{...approval,approvedAt:new Date().toISOString()}}),costCents]);
      try{
        const result=await this.request(spec.path,body);if(!uuid(result.id))fail('RUNWAY_RESULT_UNCERTAIN');
        await client.query("UPDATE marketing_generated_videos SET state='pending',task_id=$2,updated_at=now() WHERE job_key=$1",[key,result.id]);
        return view({job_key:key,state:'pending',task_id:result.id,cost_cents:costCents});
      }catch(e){await client.query("UPDATE marketing_generated_videos SET state='recovery_required',error_code=$2,updated_at=now() WHERE job_key=$1",[key,codeOf(e)]);throw e;}
    }finally{if(locked)await client.query('SELECT pg_advisory_unlock(73341009)').catch(()=>{});client?.release();}
  }
  startPolling(){
    if(this.pollTimer||!this.cfg.key)return;
    const run=()=>this.pollPending().catch(e=>log('GENERATED_VIDEO_POLL_PENDING',{reason:codeOf(e)}));
    this.pollTimer=setInterval(()=>void run(),60000);this.pollTimer.unref();void run();
  }
  stopPolling(){clearInterval(this.pollTimer);this.pollTimer=null;}
  async pollPending(){
    if(this.pollBusy||!this.cfg.key)return {status:this.pollBusy?'busy':'not_configured',checked:0,generationPerformed:false};
    this.pollBusy=true;
    try{
      const rows=(await this.pool.query("SELECT job_key FROM marketing_generated_videos WHERE state='pending' AND task_id IS NOT NULL ORDER BY updated_at LIMIT 10")).rows;
      const outcomes=[];
      for(const row of rows){
        try{outcomes.push(await this.poll(row.job_key));}
        catch(e){outcomes.push({jobKey:row.job_key,state:'verification_pending',reason:codeOf(e)});}
        await this.pool.query("UPDATE marketing_generated_videos SET updated_at=now() WHERE job_key=$1 AND state='pending'",[row.job_key]);
      }
      const result={status:'checked',checked:rows.length,outcomes,generationPerformed:false};
      if(rows.length)log('GENERATED_VIDEO_POLL',{checked:rows.length,states:outcomes.map(x=>({jobKey:x.jobKey,state:x.state,...(x.reason?{reason:x.reason}:{})})),generationPerformed:false});
      return result;
    }finally{this.pollBusy=false;}
  }
  async poll(key){
    if(!this.cfg.key)fail('RUNWAY_API_KEY_REQUIRED');
    if(!/^[a-f0-9]{64}$/.test(key))fail('INVALID_GENERATIVE_JOB');
    const job=(await this.pool.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0];
    if(!job)fail('GENERATIVE_JOB_NOT_FOUND');
    if(job.state!=='pending'||!uuid(job.task_id))return view(job);
    const result=await this.request('tasks/'+job.task_id);
    if(result.id&&result.id!==job.task_id)fail('RUNWAY_TASK_MISMATCH');
    if(result.status==='SUCCEEDED'){
      let u;try{u=new URL(result.output?.[0]);}catch{fail('RUNWAY_OUTPUT_UNCONFIRMED');}
      if(u.protocol!=='https:'||u.username||u.password)fail('RUNWAY_OUTPUT_UNCONFIRMED');
      const updated=await this.pool.query("UPDATE marketing_generated_videos SET state='review_required',video_url=$2,updated_at=now() WHERE job_key=$1 AND state='pending' AND task_id=$3",[key,u.href,job.task_id]);
      if(updated.rowCount===0)return view((await this.pool.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0]||job);
      return view({...job,state:'review_required',video_url:u.href});
    }
    if(['FAILED','CANCELED'].includes(result.status)){
      const updated=await this.pool.query("UPDATE marketing_generated_videos SET state='failed',error_code='RUNWAY_GENERATION_FAILED',updated_at=now() WHERE job_key=$1 AND state='pending' AND task_id=$2",[key,job.task_id]);
      if(updated.rowCount===0)return view((await this.pool.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0]||job);
      return view({...job,state:'failed',error_code:'RUNWAY_GENERATION_FAILED'});
    }
    return view(job);
  }
}

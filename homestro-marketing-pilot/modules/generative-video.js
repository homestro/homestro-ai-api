import {randomUUID} from 'node:crypto';
import {handoffGeneratedVideo} from './generated-video-handoff.js';
import {hash,fail,codeOf,log} from './core.js';
import {extractMedia,carouselAssetKey} from './media.js';
const uuid=v=>/^[a-f0-9-]{36}$/.test(v||'');
const view=r=>({jobKey:r.job_key,state:r.state,taskId:r.task_id||null,videoURL:r.video_url||null,estimatedUSD:r.cost_cents/100,error:r.error_code||null,requiresReview:true});

// A generated scene is a draft, never an approved product claim or social post.
export class GeneratedVideoDrafts {
  constructor({pool,cfg,fresh,fetchImpl=fetch}){Object.assign(this,{pool,cfg,fresh,fetch:fetchImpl});}
  async migrate(){await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_generated_videos(
    job_key text PRIMARY KEY,product_id text NOT NULL,revision text NOT NULL,request jsonb NOT NULL,
    state text NOT NULL,task_id text,video_url text,error_code text,cost_cents integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_video_quotes(job_key text PRIMARY KEY,quote jsonb NOT NULL,expires_at timestamptz NOT NULL)`);
    await this.pool.query("ALTER TABLE marketing_generated_videos ADD COLUMN IF NOT EXISTS review jsonb NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS handoff jsonb NOT NULL DEFAULT '{}'");}
  async handoff(key,body,importedMedia){return handoffGeneratedVideo({pool:this.pool,cfg:this.cfg,fresh:this.fresh,fetchImpl:this.fetch,key,body,importedMedia});}
  async request(path,body){
    if(!/^(?:image_to_video|tasks\/[a-f0-9-]{36})$/.test(path))fail('GENERATIVE_ENDPOINT_BLOCKED');
    const r=await this.fetch('https://api.dev.runwayml.com/v1/'+path,{method:body?'POST':'GET',redirect:'error',
      headers:{Authorization:'Bearer '+this.cfg.key,'X-Runway-Version':'2024-11-06','Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    if(!r.ok)fail(r.status===401||r.status===403?'RUNWAY_AUTH_FAILED':r.status===429?'RUNWAY_RATE_LIMIT':'RUNWAY_REQUEST_FAILED');
    return r.json();
  }
  async specification({productId,revision,promptImage,promptText,style='realistic'}){
    if(!['realistic','animated'].includes(style)||typeof promptText!=='string'||promptText.length<30||promptText.length>650)fail('INVALID_GENERATIVE_SCENE');
    const u=new URL(promptImage);
    if(u.origin!==this.cfg.publicOrigin||u.search||u.hash||u.username||u.password||!/^\/marketing-assets\/[a-f0-9]{64}\.jpg$/.test(u.pathname))fail('UNTRUSTED_PUBLISH_ASSET');
    const product=await this.fresh(productId);
    if(product.status!=='ACTIVE'||product.rejected||product.revision!==revision)fail('SOCIAL_REVIEW_STALE');
    if(!extractMedia(product.media).images.some(image=>u.pathname.endsWith('/'+carouselAssetKey(image)+'.jpg')))fail('GENERATIVE_SOURCE_MISMATCH');
    const body={model:'gen4_turbo',promptImage,ratio:'720:1280',duration:5,
      promptText:(style==='animated'?'Stylized animated scene. ':'Realistic scene. ')+promptText+
        ' Keep the referenced product shape, color and proportions unchanged. Show genuine movement of subjects and interaction, not only camera zoom. No added claims, text, logos, reviews or impossible effects.'};
    return {productId,revision,body,key:hash({productId,revision,body}),nativeVideo:extractMedia(product.media).videoURL};
  }
  async quote(input){
    const spec=await this.specification(input);
    const existing=(await this.pool.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[spec.key])).rows[0];
    if(existing)return {reuseExisting:true,existing:view(existing),generationPerformed:false};
    if(spec.nativeVideo)fail('EXISTING_NATIVE_VIDEO_AVAILABLE');
    const imported=(await this.pool.query("SELECT job_id FROM marketing_imported_media WHERE product_id=$1 AND product_revision=$2 AND metadata->>'kind'='video' AND state='queued' LIMIT 1",[spec.productId,spec.revision])).rows;
    if(imported.length)return {reuseExisting:true,importedJobId:imported[0].job_id,generationPerformed:false};
    const other=(await this.pool.query("SELECT job_key FROM marketing_generated_videos WHERE product_id=$1 AND revision=$2 AND state NOT IN ('failed') LIMIT 1",[spec.productId,spec.revision])).rows;
    if(other.length)return {reuseExisting:true,existingJobKey:other[0].job_key,generationPerformed:false};
    const expires=new Date(Date.now()+30*60000);
    const quote={quoteId:randomUUID(),requestKey:spec.key,productId:spec.productId,revision:spec.revision,model:'gen4_turbo',durationSeconds:5,
      estimatedCostCents:25,currency:'USD',taxIncluded:false,additionalAttemptsIncluded:false,
      pricingSource:'https://docs.dev.runwayml.com/guides/pricing/',priceVersion:'gen4-turbo-5credits-second-usd001-20261027',
      expiresAt:expires.toISOString(),generationPerformed:false};
    await this.pool.query(`INSERT INTO marketing_video_quotes(job_key,quote,expires_at) VALUES($1,$2,$3)
      ON CONFLICT(job_key) DO UPDATE SET quote=$2,expires_at=$3`,[spec.key,quote,expires]);
    return quote;
  }
  async start(input){
    if(!this.cfg.enabled)fail('GENERATIVE_VIDEO_DISABLED');
    if(!this.cfg.key)fail('RUNWAY_API_KEY_REQUIRED');
    const {productId,revision,body,key,nativeVideo}=await this.specification(input);
    let client,locked=false;
    try{
      client=await this.pool.connect();locked=(await client.query('SELECT pg_try_advisory_lock(73341009) AS locked')).rows[0]?.locked;
      if(!locked)fail('GENERATIVE_VIDEO_BUSY');
      const existing=(await client.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0];
      if(existing)return view(existing);
      const quote=(await client.query('SELECT quote,expires_at FROM marketing_video_quotes WHERE job_key=$1',[key])).rows[0];
      const approval=input.costApproval;
      if(!quote||!Number.isFinite(new Date(quote.expires_at).getTime())||new Date(quote.expires_at).getTime()<=Date.now()||quote.quote.estimatedCostCents!==25||quote.quote.currency!=='USD'||
        !uuid(quote.quote?.quoteId)||approval?.quoteId!==quote.quote.quoteId||approval.approved!==true||approval.approvedCostCents!==25||approval.currency!=='USD'||
        typeof approval.reviewer!=='string'||!approval.reviewer.trim()||approval.reviewer.length>100)fail('GENERATION_PRICE_APPROVAL_REQUIRED');
      if(nativeVideo)fail('EXISTING_NATIVE_VIDEO_AVAILABLE');
      const imported=(await client.query("SELECT job_id FROM marketing_imported_media WHERE product_id=$1 AND product_revision=$2 AND metadata->>'kind'='video' AND state='queued' LIMIT 1",[productId,revision])).rows;
      const other=(await client.query("SELECT job_key FROM marketing_generated_videos WHERE product_id=$1 AND revision=$2 AND state<>'failed' LIMIT 1",[productId,revision])).rows;
      if(imported.length||other.length)fail('EXISTING_VIDEO_REUSE_REQUIRED');

      const spent=Number((await client.query(`SELECT COALESCE(sum(cost_cents),0)::int AS spent FROM marketing_generated_videos
        WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`)).rows[0]?.spent);
      if(!Number.isFinite(spent)||spent+25>Number(this.cfg.dailyCents||25))fail('GENERATIVE_VIDEO_DAILY_LIMIT');
      // Persist the spending intent before POST. A lost response is never blindly retried.
      await client.query(`INSERT INTO marketing_generated_videos(job_key,product_id,revision,request,state,cost_cents)
        VALUES($1,$2,$3,$4,'submit_intent',25)`,[key,productId,revision,JSON.stringify({...body,costApproval:{...approval,approvedAt:new Date().toISOString()}})]);
      try{
        const result=await this.request('image_to_video',body);if(!uuid(result.id))fail('RUNWAY_RESULT_UNCERTAIN');
        await client.query("UPDATE marketing_generated_videos SET state='pending',task_id=$2,updated_at=now() WHERE job_key=$1",[key,result.id]);
        return view({job_key:key,state:'pending',task_id:result.id,cost_cents:25});
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
        // Rotate pending checks so failed old tasks cannot starve later completions.
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

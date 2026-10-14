import {hash,fail,codeOf} from './core.js';
import {extractMedia,carouselAssetKey} from './media.js';
const uuid=v=>/^[a-f0-9-]{36}$/.test(v||'');
const view=r=>({jobKey:r.job_key,state:r.state,taskId:r.task_id||null,videoURL:r.video_url||null,estimatedUSD:r.cost_cents/100,error:r.error_code||null,requiresReview:true});

// A generated scene is a draft, never an approved product claim or social post.
export class GeneratedVideoDrafts {
  constructor({pool,cfg,fresh,fetchImpl=fetch}){Object.assign(this,{pool,cfg,fresh,fetch:fetchImpl});}
  async migrate(){await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_generated_videos(
    job_key text PRIMARY KEY,product_id text NOT NULL,revision text NOT NULL,request jsonb NOT NULL,
    state text NOT NULL,task_id text,video_url text,error_code text,cost_cents integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);}
  async request(path,body){
    if(!/^(?:image_to_video|tasks\/[a-f0-9-]{36})$/.test(path))fail('GENERATIVE_ENDPOINT_BLOCKED');
    const r=await this.fetch('https://api.dev.runwayml.com/v1/'+path,{method:body?'POST':'GET',redirect:'error',
      headers:{Authorization:'Bearer '+this.cfg.key,'X-Runway-Version':'2024-11-06','Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    if(!r.ok)fail(r.status===401||r.status===403?'RUNWAY_AUTH_FAILED':r.status===429?'RUNWAY_RATE_LIMIT':'RUNWAY_REQUEST_FAILED');
    return r.json();
  }
  async start({productId,revision,promptImage,promptText,style='realistic'}){
    if(!this.cfg.enabled)fail('GENERATIVE_VIDEO_DISABLED');
    if(!this.cfg.key)fail('RUNWAY_API_KEY_REQUIRED');
    if(!['realistic','animated'].includes(style)||typeof promptText!=='string'||promptText.length<30||promptText.length>650)fail('INVALID_GENERATIVE_SCENE');
    const u=new URL(promptImage);
    if(u.origin!==this.cfg.publicOrigin||u.search||u.hash||u.username||u.password||!/^\/marketing-assets\/[a-f0-9]{64}\.jpg$/.test(u.pathname))fail('UNTRUSTED_PUBLISH_ASSET');
    const product=await this.fresh(productId);
    if(product.status!=='ACTIVE'||product.rejected||product.revision!==revision)fail('SOCIAL_REVIEW_STALE');
    if(!extractMedia(product.media).images.some(image=>u.pathname.endsWith('/'+carouselAssetKey(image)+'.jpg')))fail('GENERATIVE_SOURCE_MISMATCH');
    const body={model:'gen4_turbo',promptImage,ratio:'720:1280',duration:5,
      promptText:(style==='animated'?'Stylized animated scene. ':'Realistic scene. ')+promptText+
        ' Keep the referenced product shape, color and proportions unchanged. Show genuine movement of subjects and interaction, not only camera zoom. No added claims, text, logos, reviews or impossible effects.'};
    const key=hash({productId,revision,body});let client,locked=false;
    try{
      client=await this.pool.connect();locked=(await client.query('SELECT pg_try_advisory_lock(73341009) AS locked')).rows[0]?.locked;
      if(!locked)fail('GENERATIVE_VIDEO_BUSY');
      const existing=(await client.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0];
      if(existing)return view(existing);
      const spent=Number((await client.query(`SELECT COALESCE(sum(cost_cents),0)::int AS spent FROM marketing_generated_videos
        WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`)).rows[0]?.spent);
      if(!Number.isFinite(spent)||spent+25>Number(this.cfg.dailyCents||25))fail('GENERATIVE_VIDEO_DAILY_LIMIT');
      // Persist the spending intent before POST. A lost response is never blindly retried.
      await client.query(`INSERT INTO marketing_generated_videos(job_key,product_id,revision,request,state,cost_cents)
        VALUES($1,$2,$3,$4,'submit_intent',25)`,[key,productId,revision,JSON.stringify(body)]);
      try{
        const result=await this.request('image_to_video',body);if(!uuid(result.id))fail('RUNWAY_RESULT_UNCERTAIN');
        await client.query("UPDATE marketing_generated_videos SET state='pending',task_id=$2,updated_at=now() WHERE job_key=$1",[key,result.id]);
        return view({job_key:key,state:'pending',task_id:result.id,cost_cents:25});
      }catch(e){await client.query("UPDATE marketing_generated_videos SET state='recovery_required',error_code=$2,updated_at=now() WHERE job_key=$1",[key,codeOf(e)]);throw e;}
    }finally{if(locked)await client.query('SELECT pg_advisory_unlock(73341009)').catch(()=>{});client?.release();}
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
      await this.pool.query("UPDATE marketing_generated_videos SET state='review_required',video_url=$2,updated_at=now() WHERE job_key=$1",[key,u.href]);
      return view({...job,state:'review_required',video_url:u.href});
    }
    if(['FAILED','CANCELED'].includes(result.status)){
      await this.pool.query("UPDATE marketing_generated_videos SET state='failed',error_code='RUNWAY_GENERATION_FAILED',updated_at=now() WHERE job_key=$1",[key]);
      return view({...job,state:'failed',error_code:'RUNWAY_GENERATION_FAILED'});
    }
    return view(job);
  }
}

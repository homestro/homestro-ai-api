import {fail,log} from './core.js';
import {MetaOrganic} from './meta.js';
import {Worker} from './worker.js';

// Explicit owner-requested single test. Background publication remains disabled.
export function validateOneShot(request) {
  if(!request || !/^gid:\/\/shopify\/Product\/\d+$/.test(request.productId) ||
    !['instagram','facebook'].includes(request.channel) || request.publish!==true ||
    typeof request.reviewer!=='string' || !request.reviewer.trim() || request.reviewer.length>100)
    fail('INVALID_ONE_SHOT_REQUEST');
  const x=request.inputs;
  if(!x || x.contentReviewed!==true || x.priceReviewed!==true ||
    !Array.isArray(x.facts) || x.facts.length<1 || x.facts.length>3 || x.facts.some(f=>!f.id || !f.text) ||
    !x.germanCopy || !x.reviewEvidence) fail('ONE_SHOT_REVIEW_REQUIRED');
  return request;
}
export async function runOneShot({request,instance,pool,cfg,freshSnapshot,meta=new MetaOrganic(cfg)}) {
  validateOneShot(request);
  if(cfg.workerEnabled || cfg.publishingEnabled)fail('ONE_SHOT_REQUIRES_BACKGROUND_DISABLED');
  const client=await pool.connect();let locked=false;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(73341003) AS locked')).rows[0].locked;
    if(!locked)return {status:'busy'};
    const previous=(await client.query(`SELECT * FROM marketing_posts WHERE product_id=$1 AND channel=$2
      AND status IN ('publishing','published','recovery_required') ORDER BY updated_at DESC LIMIT 1`,
      [request.productId,request.channel])).rows[0];
    if(previous) {
      if(previous.channel==='instagram' && previous.status==='recovery_required' && request.recover===true)
        return await reconcileOneShot({job:previous,instance,pool,cfg,freshSnapshot,meta});
      log('TARGET_ONE_SHOT_ALREADY_HANDLED',{postId:previous.id,status:previous.status,remotePostId:previous.remote?.postId||null});
      return {status:previous.status,postId:previous.id,remote:previous.remote};
    }
    await client.query(`INSERT INTO marketing_inputs(product_id,inputs) VALUES($1,$2)
      ON CONFLICT(product_id) DO UPDATE SET inputs=$2,updated_at=now()`,[request.productId,request.inputs]);
    const processed=await instance.processProduct(request.productId);
    const product=await instance.store.product(request.productId);
    if(product?.status!=='ready') {
      log('TARGET_ONE_SHOT_BLOCKED',{productId:request.productId,reasons:product?.reasons||processed.reasons||[]});
      return {status:'blocked',reasons:product?.reasons||processed.reasons||[]};
    }
    const job=(await client.query(`SELECT * FROM marketing_posts WHERE product_id=$1 AND channel=$2
      AND payload->>'productRevision'=$3 AND status IN ('draft_queued','approved')
      ORDER BY created_at DESC LIMIT 1`,[request.productId,request.channel,product.document.revision])).rows[0];
    if(!job || job.payload.format!=='carousel' || job.payload.adSpendEUR!==0 ||
      !Array.isArray(job.payload.imageURLs) || job.payload.imageURLs.length<2)fail('ONE_SHOT_CAROUSEL_REQUIRED');
    if(job.status==='draft_queued')await instance.store.approve(job.id,request.reviewer);
    log('TARGET_ONE_SHOT_APPROVED',{postId:job.id,productId:request.productId,channel:request.channel,imageCount:job.payload.imageURLs.length});
    const oneCfg={...cfg,workerEnabled:true,publishingEnabled:true,publishOnce:true,maxDailyPosts:request.channel==='facebook'?2:1};
    const originalCfg=meta.cfg;meta.cfg=oneCfg;
    try {
      const worker=new Worker({store:instance.store,meta,cfg:oneCfg,freshSnapshot});
      await worker.tick(job.id);
    } finally {meta.cfg=originalCfg;}
    const result=(await client.query('SELECT id,status,remote,error_code FROM marketing_posts WHERE id=$1',[job.id])).rows[0];
    log('TARGET_ONE_SHOT_RESULT',{postId:job.id,status:result.status,errorCode:result.error_code,remotePostId:result.remote?.postId||null,phase:result.remote?.phase||null});
    if(result.status==='published' && result.remote?.postId) {
      try {
        const published=await meta.request(String(result.remote.postId),{fields:request.channel==='facebook'?'id,permalink_url,attachments{subattachments}':'id,permalink,media_type,children'});
        if(request.channel==='facebook') {
          published.permalink=published.permalink_url;
          published.media_type='FACEBOOK_MULTI_PHOTO';
          published.children={data:published.attachments?.data?.[0]?.subattachments?.data||[]};
        }
        log('TARGET_ONE_SHOT_VERIFIED',{postId:job.id,remotePostId:published.id,permalink:published.permalink,mediaType:published.media_type,childCount:published.children?.data?.length||0});
        result.permalink=published.permalink;
      } catch {log('TARGET_ONE_SHOT_VERIFICATION_PENDING',{remotePostId:result.remote.postId});}
    }
    return result;
  } finally {
    if(locked)await client.query('SELECT pg_advisory_unlock(73341003)').catch(()=>{});
    client.release();
  }
}

async function reconcileOneShot({job,instance,pool,cfg,freshSnapshot,meta}) {
  const current=await freshSnapshot(job.product_id);
  const stored=await instance.store.product(job.product_id);
  if(stored?.status!=='ready' || current.revision!==job.payload.productRevision ||
    !job.approved_by || !job.approved_at || job.payload.adSpendEUR!==0 ||
    !/^\d+$/.test(String(job.remote?.containerId||'')))fail('ONE_SHOT_RECOVERY_NOT_VERIFIED');
  await meta.verifyConnection();
  const container=await meta.request(String(job.remote.containerId),{fields:'status_code,status'});
  const recent=await meta.request(cfg.instagramId+'/media',{fields:'id,caption,permalink,media_type,timestamp'});
  const found=(recent.data||[]).find(p=>p.caption===job.payload.caption);
  log('TARGET_ONE_SHOT_RECOVERY_CHECK',{postId:job.id,containerStatus:container.status_code,matchingPostId:found?.id||null});
  if(found) {
    await instance.store.checkpoint(job.id,{...job.remote,phase:'published',postId:found.id});
    await instance.store.setStatus(job.id,'published');
    log('TARGET_ONE_SHOT_VERIFIED',{postId:job.id,remotePostId:found.id,permalink:found.permalink,mediaType:found.media_type});
    return {status:'published',permalink:found.permalink};
  }
  // Resume only the same confirmed unpublished parent, never create another carousel.
  if(container.status_code!=='FINISHED' || job.remote.recoveryAttempted) {
    log('TARGET_ONE_SHOT_RECOVERY_BLOCKED',{postId:job.id,containerStatus:container.status_code,alreadyAttempted:Boolean(job.remote.recoveryAttempted)});
    return {status:'recovery_required'};
  }
  const others=Number((await pool.query(`SELECT count(*) FROM marketing_posts WHERE id<>$1
    AND ((status='published' AND updated_at>now()-interval '24 hours') OR status IN ('publishing','recovery_required'))`,[job.id])).rows[0].count);
  if(others>=1)fail('ONE_SHOT_RECOVERY_QUOTA_BLOCKED');
  const remote={...job.remote,recoveryAttempted:true,phase:'ig_recovery_publish_intent'};
  await instance.store.checkpoint(job.id,remote);
  await instance.store.setStatus(job.id,'publishing');
  try {
    const post=await meta.request(cfg.instagramId+'/media_publish',{method:'POST',body:{creation_id:job.remote.containerId}});
    if(!/^\d+$/.test(String(post.id)))fail('META_PUBLISH_UNCONFIRMED');
    await instance.store.checkpoint(job.id,{...remote,phase:'published',postId:post.id});
    await instance.store.setStatus(job.id,'published');
    const verified=await meta.request(String(post.id),{fields:'id,permalink,media_type,children'});
    log('TARGET_ONE_SHOT_VERIFIED',{postId:job.id,remotePostId:verified.id,permalink:verified.permalink,mediaType:verified.media_type,childCount:verified.children?.data?.length||0});
    return {status:'published',permalink:verified.permalink};
  } catch(e) {
    // A response-read failure after confirmed publication does not undo published state.
    const result=(await pool.query('SELECT id,status,remote,error_code FROM marketing_posts WHERE id=$1',[job.id])).rows[0];
    if(result.status!=='published')await instance.store.setStatus(job.id,'recovery_required',e.code||'INTERNAL_ERROR');
    log('TARGET_ONE_SHOT_RECOVERY_RESULT',{postId:job.id,status:result.status==='published'?'published':'recovery_required',errorCode:e.code||'INTERNAL_ERROR'});
    return result;
  }
}

import {fail,log} from './core.js';
import {MetaOrganic} from './meta.js';
import {Worker} from './worker.js';

// Explicit owner-requested single test. Background publication remains disabled.
export function validateOneShot(request) {
  if(!request || !/^gid:\/\/shopify\/Product\/\d+$/.test(request.productId) ||
    request.channel!=='instagram' || request.publish!==true ||
    typeof request.reviewer!=='string' || !request.reviewer.trim() || request.reviewer.length>100)
    fail('INVALID_ONE_SHOT_REQUEST');
  const x=request.inputs;
  if(!x || x.rightsVerified!==true || x.contentReviewed!==true || x.priceReviewed!==true ||
    !Array.isArray(x.facts) || x.facts.length!==3 || x.facts.some(f=>!f.id || !f.text) ||
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
    const oneCfg={...cfg,workerEnabled:true,publishingEnabled:true,publishOnce:true,maxDailyPosts:1};
    const originalCfg=meta.cfg;meta.cfg=oneCfg;
    try {
      const worker=new Worker({store:instance.store,meta,cfg:oneCfg,freshSnapshot});
      await worker.tick(job.id);
    } finally {meta.cfg=originalCfg;}
    const result=(await client.query('SELECT id,status,remote,error_code FROM marketing_posts WHERE id=$1',[job.id])).rows[0];
    log('TARGET_ONE_SHOT_RESULT',{postId:job.id,status:result.status,errorCode:result.error_code,remotePostId:result.remote?.postId||null,phase:result.remote?.phase||null});
    if(result.status==='published' && result.remote?.postId) {
      try {
        const published=await meta.request(String(result.remote.postId),{fields:'id,permalink,media_type,children'});
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

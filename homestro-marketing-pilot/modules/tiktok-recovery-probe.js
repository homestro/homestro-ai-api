import {createHash} from 'node:crypto';
import {fail,log,codeOf} from './core.js';
import {eligible,berlinWindow} from './social.js';
import {channelPolicy} from './publishing-policy.js';

// Explicit operator probe, not an automatic retry policy. Only a recent HTTP400
// with its original stored idempotency key can be checked. Zernio retains keys
// for 24h; our stricter 12h bound stays away from that expiry.
export async function runTikTokRecoveryProbe(social,now=new Date(),cutoff=now,expectedAccountId,assetRepairPostId=null) {
  const {pool,cfg,providerCfg,provider}=social;
  if(!cfg.workerEnabled||!cfg.publishingEnabled||!providerCfg.publishingEnabled||
    !providerCfg.accounts.tiktok||(!cfg.publishAroundClock&&!berlinWindow(now)))return {status:'disabled'};
  const repair=assetRepairPostId!==null,marker=repair?'assetRepairProbe':'recoveryProbe';
  let client,locked=false,job;
  try {
    client=await pool.connect();
    locked=(await client.query('SELECT pg_try_advisory_lock(73341003) AS locked')).rows[0]?.locked;
    if(!locked)return {status:'busy'};
    if(!Number.isFinite(cutoff.getTime())||cutoff>now)fail('RECOVERY_CUTOFF_INVALID');
    if(!/^[a-f0-9]{24}$/.test(expectedAccountId||'')||providerCfg.accounts.tiktok!==expectedAccountId)
      fail('RECOVERY_ACCOUNT_UNCONFIRMED');
    if(repair&&!/^[a-f0-9-]{36}$/.test(assetRepairPostId))fail('RECOVERY_TARGET_INVALID');
    job=(await client.query(`SELECT * FROM marketing_social_posts WHERE channel='tiktok'
      AND status='recovery_required' AND error_code='ZERNIO_POST_CREATE_HTTP_400'
      AND attempted_at>now()-interval '12 hours' AND attempted_at<=$1::timestamptz
      AND NOT(remote ? '${marker}') ${repair?"AND remote ? 'recoveryProbe' AND id=$2":''}
      ORDER BY attempted_at DESC LIMIT 1`,repair?[cutoff.toISOString(),assetRepairPostId]:[cutoff.toISOString()])).rows[0];
    if(!job)return {status:'no_candidate'};
    const age=now.getTime()-new Date(job.attempted_at).getTime();
    const key=createHash('sha256').update('homestro:zernio:'+job.id).digest('hex');
    if(!Number.isFinite(age)||age<0||age>=12*60*60*1000||job.remote?.phase!=='zernio_submit_intent'||
      job.remote?.idempotencyKey!==key||job.remote?.providerPostId)fail('RECOVERY_KEY_UNCONFIRMED');
    const used=Number((await client.query(`SELECT count(*)::int AS n FROM marketing_social_posts
      WHERE channel='tiktok' AND (published_at>now()-interval '24 hours'
        OR attempted_at>now()-interval '24 hours')`)).rows[0]?.n);
    if(!Number.isFinite(used)||used>channelPolicy(cfg,'tiktok').daily)fail('RECOVERY_DAILY_LIMIT');
    const current=await social.freshSnapshot(job.product_id);
    if(!eligible(current,cfg)||current.revision!==job.payload.productRevision)fail('SOCIAL_REVIEW_STALE');
    const original={...job,status:'publishing'};
    const body=provider.buildRequest(original); // Exact original preview and express consent.
    if(repair) {
      if(job.id!==assetRepairPostId||!job.remote?.recoveryProbe||!social.ensureAssets)fail('RECOVERY_REPAIR_UNCONFIRMED');
      await social.ensureAssets(job,current);
      const validation=await provider.request('tools/validate/post',{method:'POST',body});
      if(validation?.valid!==true)fail('RECOVERY_MEDIA_VALIDATION_FAILED');
    }
    const reserved=await client.query(`UPDATE marketing_social_posts
      SET remote=remote||jsonb_build_object('${marker}',$2::text),updated_at=now()
      WHERE id=$1 AND status='recovery_required' AND NOT(remote ? '${marker}') RETURNING id`,
      [job.id,now.toISOString()]);
    if(!reserved.rowCount)return {status:'already_checked'};
    const listed=await provider.request('posts');
    if(!Array.isArray(listed?.posts))fail('RECOVERY_LOOKUP_UNCONFIRMED');
    const existing=listed.posts.find(p=>p.metadata?.pilotPostId===job.id);
    let state;
    if(existing) {
      if(!/^[a-f0-9]{24}$/.test(existing._id||''))fail('RECOVERY_LOOKUP_UNCONFIRMED');
      await social.checkpoint(job.id,{providerPostId:existing._id});
      state=await provider.reconcile(existing._id,'tiktok');
    }else {
      // Same logical request and key within the documented replay window.
      // No new job, changed payload, quota reset or unprotected second attempt.
      state=await provider.submit(original,remote=>social.checkpoint(job.id,remote));
    }
    await social.settle(job.id,state);
    log('TIKTOK_RECOVERY_PROBE',{postId:job.id,status:state.status,permalink:state.permalink||null,
      diagnostic:state.diagnostic||null});
    return {status:state.status};
  }catch(e) {
    log('TIKTOK_RECOVERY_PROBE_FAILED',{postId:job?.id||null,reason:codeOf(e),diagnostic:e.diagnostic||null});
    if(job&&e.diagnostic)await social.checkpoint(job.id,{providerDiagnostic:e.diagnostic});
    return {status:'unconfirmed',reason:codeOf(e)};
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(73341003)').catch(()=>{});client?.release();}
}

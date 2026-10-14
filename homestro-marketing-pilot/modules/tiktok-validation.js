import {fail,log,codeOf} from './core.js';
import {providerDiagnostics} from './provider-diagnostics.js';
export async function validateTikTokFailure(social,postId,expectedAccountId) {
  try {
    if(!/^[a-f0-9-]{36}$/.test(postId||'')||social.providerCfg.accounts.tiktok!==expectedAccountId)fail('VALIDATION_TARGET_UNCONFIRMED');
    const job=(await social.pool.query("SELECT * FROM marketing_social_posts WHERE id=$1 AND channel='tiktok'",[postId])).rows[0];
    if(!job)fail('SOCIAL_POST_NOT_FOUND');
    const current=await social.freshSnapshot(job.product_id);
    const assets=social.ensureAssets?await social.ensureAssets(job,current):null;
    const body=social.provider.buildRequest({...job,status:'publishing'});
    const result=await social.provider.request('tools/validate/post',{method:'POST',body});
    log('TIKTOK_PAYLOAD_VALIDATION',{postId,valid:result?.valid===true,errorCount:Array.isArray(result?.errors)?result.errors.length:null,
      diagnostic:providerDiagnostics(result),assets});
    return {valid:result?.valid===true};
  }catch(e){log('TIKTOK_PAYLOAD_VALIDATION_FAILED',{postId,reason:codeOf(e),diagnostic:e.diagnostic||null});return {valid:false};}
}

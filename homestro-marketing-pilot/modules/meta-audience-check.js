import {log,codeOf,fail} from './core.js';
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
export async function checkMetaOrganicAudience(meta,pool,cfg) {
  const reports=[];
  for(const channel of ['facebook','instagram']) {
    let account=null,post=null;
    try {
      const data=await meta.request(channel==='facebook'?cfg.pageId:cfg.instagramId,{fields:channel==='facebook'?'id,followers_count,fan_count':'id,followers_count,media_count'});
      account={followers:count(data.followers_count),pageLikes:count(data.fan_count),mediaCount:count(data.media_count)};
    }catch(e){account={unavailable:codeOf(e)};}
    try {
      const job=(await pool.query("SELECT remote FROM marketing_posts WHERE channel=$1 AND status='published' ORDER BY published_at DESC LIMIT 1",[channel])).rows[0];
      const id=String(job?.remote?.postId||'');
      if(!/^\d+(?:_\d+)?$/.test(id))fail('NO_CONFIRMED_POST_ID');
      const data=await meta.request(id,{fields:channel==='facebook'?'id,is_published,reactions.limit(0).summary(true),comments.limit(0).summary(true),shares':'id,like_count,comments_count'});
      post={published:typeof data.is_published==='boolean'?data.is_published:null,likes:count(data.like_count),reactions:count(data.reactions?.summary?.total_count),comments:count(channel==='instagram'?data.comments_count:data.comments?.summary?.total_count),shares:count(data.shares?.count),reach:null,views:null};
    }catch(e){post={unavailable:codeOf(e),reach:null,views:null};}
    const report={channel,account,post,restrictionStatus:'not_checked',missingMetricsAreZero:false};
    reports.push(report);log('META_ORGANIC_AUDIENCE',report);
  }
  return reports;
}

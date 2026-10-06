import {log} from './core.js';

export const reviewedSource = inputs => inputs?.rightsVerified===true &&
  inputs?.contentReviewed===true && inputs?.priceReviewed===true && Boolean(inputs?.germanCopy);

export function publicationWindow(now=new Date()) {
  const hour=Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(now));
  return hour>=9 && hour<22;
}

// Consent applies to reviewed source material only. Changed copy still passes ingestion gates.
export async function approveReviewed(store,cfg) {
  if(!cfg.autonomyEnabled)return;
  const result=await store.pool.query(`UPDATE marketing_posts s
    SET status='approved',approved_by='Mirko: homestro-reviewed-organic-v1',approved_at=now(),updated_at=now()
    FROM marketing_products p WHERE s.product_id=p.id AND s.status='draft_queued'
    AND p.status='ready' AND s.channel IN ('facebook','instagram')
    AND p.document->>'rightsVerified'='true' AND p.document->>'contentReviewed'='true'
    AND p.document->>'priceReviewed'='true'
    AND s.payload->>'adSpendEUR'='0'
    AND s.payload->>'productRevision'=p.document->>'revision'
    AND NOT (s.product_id=ANY($1::text[]))
    AND NOT EXISTS (SELECT 1 FROM marketing_posts old WHERE old.product_id=s.product_id
      AND old.channel=s.channel AND old.status IN ('published','publishing','recovery_required'))
    RETURNING s.id,s.channel`,[cfg.excludedProductIds||[]]);
  log('AUTONOMY_APPROVAL',{policy:'homestro-reviewed-organic-v1',approved:result.rowCount});
}

// Read-only verification can settle an uncertain Instagram result only with an exact
// caption and a publication timestamp after the stored job was created. Never retry writes.
export async function verifyHistory(store,meta,cfg) {
  try {
    await store.withWorkerLock(async client=>{
      const jobs=(await client.query(`SELECT * FROM marketing_posts WHERE status IN
        ('published','recovery_required') ORDER BY updated_at DESC LIMIT 20`)).rows;
      let recent;
      for(const job of jobs) {
        try {
          if(job.status==='recovery_required' && job.channel==='instagram') {
            recent??=await meta.request(cfg.instagramId+'/media',{fields:'id,caption,permalink,media_type,timestamp'});
            const matches=(recent.data||[]).filter(p=>p.caption===job.payload.caption &&
              Date.parse(p.timestamp)>=new Date(job.created_at).getTime());
            if(matches.length===1) {
              await store.checkpoint(job.id,{...job.remote,phase:'published',postId:matches[0].id,permalink:matches[0].permalink});
              await store.setStatus(job.id,'published');
              log('HISTORY_VERIFIED',{postId:job.id,channel:job.channel,remotePostId:matches[0].id,permalink:matches[0].permalink});
            } else log('HISTORY_RECOVERY_PENDING',{postId:job.id,channel:job.channel});
          } else if(job.status==='published' && job.remote?.postId) {
            const p=await meta.request(String(job.remote.postId),{fields:job.channel==='instagram'?'id,permalink,media_type':'id,permalink_url'});
            const permalink=p.permalink||p.permalink_url||null;
            await client.query('UPDATE marketing_posts SET remote=$2 WHERE id=$1',[job.id,{...job.remote,permalink}]);
            log('HISTORY_VERIFIED',{postId:job.id,channel:job.channel,remotePostId:p.id,permalink});
          }
        } catch {log('HISTORY_VERIFICATION_PENDING',{postId:job.id,channel:job.channel});}
      }
    });
  } catch {log('HISTORY_CHECK_UNAVAILABLE');}
}

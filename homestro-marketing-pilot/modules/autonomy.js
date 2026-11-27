import {log} from './core.js';

// Owner instruction 2026-10-08: media-rights evidence is audit metadata,
// not a required receipt or Shopify tag for organic publication.
export const reviewedSource = inputs => inputs?.contentReviewed===true && Boolean(inputs?.germanCopy);

export function sourceReviewReasons(inputs={}) {
  const reasons=[];
  if(inputs.contentReviewed!==true || !inputs.germanCopy)reasons.push('CONTENT_REVIEW_REQUIRED');
  return reasons;
}

export function publicationWindow(now=new Date()) {
  const hour=Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(now));
  return hour>=9 && hour<22;
}

// Consent applies to reviewed source material only. Changed copy still passes ingestion gates.
export async function approveReviewed(store,cfg) {
  if(!cfg.autonomyEnabled)return;
  const result=await store.pool.query(`UPDATE marketing_posts s
    SET status='approved',approved_by='auto-verified-shopify-organic-v1',approved_at=now(),updated_at=now(),
      payload=jsonb_set(jsonb_set(s.payload,'{requiresReview}','false'::jsonb),'{adSpendEUR}','0'::jsonb)
    FROM marketing_products p WHERE s.product_id=p.id AND s.status='draft_queued'
    AND p.status='ready' AND p.document->>'status'='ACTIVE' AND s.channel IN ('facebook','instagram')
    AND COALESCE(p.document->>'rejected','false')<>'true'
    AND p.document->>'contentReviewed'='true'
    AND jsonb_typeof(p.document->'variants')='array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.document->'variants') v
      WHERE COALESCE((v->>'available')::boolean,false)=true
      AND COALESCE((v->>'price')::numeric,0)>0)
    AND length(COALESCE(s.payload->>'caption','')) BETWEEN 20 AND 2200
    AND COALESCE(s.payload->>'caption','') !~* '(PayPal|Klarna|Gate B14|Was macht .+ im Alltag leichter)'
    AND COALESCE(s.payload->>'importedMedia','false')<>'true'
    AND (COALESCE(s.payload->>'format','')<>'reels'
      OR s.payload->>'videoURL' LIKE $2 || '/marketing-assets/%.mp4')
    AND s.payload->>'productRevision'=p.document->>'revision'
    AND NOT (s.product_id=ANY($1::text[]))
    AND NOT EXISTS (SELECT 1 FROM marketing_posts old WHERE old.product_id=s.product_id
      AND old.channel=s.channel AND old.status IN ('published','publishing','recovery_required')
      AND old.payload->>'caption'=s.payload->>'caption'
      AND old.payload->>'videoURL' IS NOT DISTINCT FROM s.payload->>'videoURL'
      AND old.payload->'imageURLs' IS NOT DISTINCT FROM s.payload->'imageURLs')
    RETURNING s.id,s.channel`,[cfg.excludedProductIds||[],cfg.publicOrigin]);
  if(!result.rowCount) {
    const d=await store.pool.query(`WITH q AS (
      SELECT s.*,p.status AS product_state,p.document AS doc
      FROM marketing_posts s LEFT JOIN marketing_products p ON p.id=s.product_id
      WHERE s.status='draft_queued' AND s.channel IN ('facebook','instagram')
        AND s.product_id LIKE 'gid://shopify/Product/%'
    )
    SELECT count(*) AS queued,
      count(*) FILTER (WHERE product_state='ready') AS product_ready,
      count(*) FILTER (WHERE doc->>'status'='ACTIVE') AS product_active,
      count(*) FILTER (WHERE doc->>'contentReviewed'='true') AS content_reviewed,
      count(*) FILTER (WHERE jsonb_typeof(doc->'variants')='array') AS variants_array,
      count(*) FILTER (WHERE payload->>'adSpendEUR'='0') AS zero_spend_flag,
      count(*) FILTER (WHERE COALESCE(payload->>'requiresReview','false')='false') AS review_clear,
      count(*) FILTER (WHERE COALESCE(payload->>'importedMedia','false')<>'true') AS no_imported_media,
      count(*) FILTER (WHERE payload->>'productRevision'=doc->>'revision') AS revision_match,
      count(*) FILTER (WHERE length(COALESCE(payload->>'caption','')) BETWEEN 20 AND 2200) AS caption_length_ok,
      count(*) FILTER (WHERE COALESCE(payload->>'caption','') !~* '(PayPal|Klarna|Gate B14|Was macht .+ im Alltag leichter)') AS claims_clear
    FROM q`).then(r=>r.rows[0]);
    log('AUTONOMY_APPROVAL_DIAGNOSTIC',d);
  }
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

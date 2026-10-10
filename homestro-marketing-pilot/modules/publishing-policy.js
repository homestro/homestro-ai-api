// Owner-selected experiment, not platform limits or a guarantee of reach.
export function channelPolicy(cfg,channel) {
  if(cfg.organicPolicy==='balanced-v1') {
    const policies={facebook:{hours:8,daily:2},instagram:{hours:8,daily:2},
      tiktok:{hours:4,daily:4},pinterest:{hours:2,daily:6}};
    return {...policies[channel],aroundClock:false};
  }
  const hours=cfg.publishEveryHours||24;
  return {hours,daily:['facebook','instagram'].includes(channel)?cfg.maxDailyPerChannel:
    cfg.publishEveryHours?Math.min(6,Math.ceil(24/hours)):1,aroundClock:!!cfg.publishAroundClock};
}

export async function repeatedMedia(client,table,job,cfg) {
  if(cfg.organicPolicy!=='balanced-v1')return false;
  if(!['marketing_posts','marketing_social_posts'].includes(table))throw new Error('INVALID_QUEUE');
  const video=job.payload.videoURL||'',images=[...new Set(job.payload.imageURLs||[])].sort();
  if(!video&&!images.length)return false;
  // Compare the actual media references across different products on this channel.
  // This does not detect visually similar files hosted at different URLs.
  const result=await client.query(`SELECT id FROM ${table} WHERE channel=$1 AND id<>$2
    AND status IN ('publishing','remote_pending','published','recovery_required')
    AND COALESCE(published_at,updated_at)>now()-interval '30 days'
    AND (($3<>'' AND payload->>'videoURL'=$3) OR
      ($3='' AND COALESCE(payload->>'videoURL','')='' AND
       ARRAY(SELECT jsonb_array_elements_text(COALESCE(payload->'imageURLs','[]'::jsonb)) ORDER BY 1)=$4::text[]))
    LIMIT 1`,[job.channel,job.id,video,images]);
  return result.rows.length>0;
}

import {validateImportedReview} from './imported-media.js';
import {randomUUID} from 'node:crypto';
import {hash,fail,codeOf,log,productURL,trackingLink} from './core.js';
import {compilePost} from './localization.js';
import {trackedDestination} from './tracking.js';
import {ZernioOrganic} from './zernio.js';
import {channelPolicy,repeatedMedia} from './publishing-policy.js';

export function socialConfig(env,base) {
  const enabled=String(env.PILOT_SOCIAL_ENABLED).toLowerCase()==='true';
  if(!enabled)return null;
  const accounts={};
  for(const channel of ['tiktok','pinterest']){
    const id=env['ZERNIO_'+channel.toUpperCase()+'_ACCOUNT_ID'];
    if(id)accounts[channel]=id;
  }
  const boardId=env.ZERNIO_PINTEREST_BOARD_ID||'';
  if(!Object.keys(accounts).length || !env.ZERNIO_API_KEY)fail('ZERNIO_CREDENTIALS_UNAVAILABLE');
  if(accounts.pinterest && !boardId)fail('PINTEREST_BOARD_REQUIRED');
  return {apiKey:env.ZERNIO_API_KEY,accounts,boardId,boardIds:boardId?[boardId]:[],
    publicOrigin:base.publicOrigin,shopOrigin:'https://homestro.de',
    publishingEnabled:String(env.PILOT_SOCIAL_PUBLISH_ENABLED).toLowerCase()==='true'};
}

export function eligible(p,cfg) {
  return p?.status==='ACTIVE' && p.rejected!==true && p.contentReviewed===true &&
    !cfg.excludedProductIds?.includes(p.id) && p.variants?.some(v=>v.available && Number(v.price)>0);
}

export function prepareSocial(p,channel,cfg) {
  if(!eligible(p,cfg)||!p.localized||!p.asset||p.asset.previewOnly)fail('SOCIAL_SOURCE_NOT_READY');
  productURL(p.url);
  const result=compilePost(p,channel,p.asset,cfg);
  result.title=result.title.slice(0,channel==='pinterest'?100:result.format==='reels'?150:90);
  result.productURL=result.link;
  if(channel==='pinterest'){
    result.boardId=cfg.boardId;
    if(result.format!=='reels'){result.imageURLs=result.imageURLs.slice(0,1);result.format='image';}
    // Pinterest accepts the shop destination, not our Railway click redirect.
    // Preserve attribution through Shopify UTM parameters and the strict shop allowlist.
    result.productURL=trackingLink(p.url,'pinterest',result.format);
    if(result.caption.length>800)fail('PINTEREST_COPY_LIMIT');
  }
  return result;
}

export function approvePayload(job,body,revision) {
  if(job.status!=='draft_queued'||job.payload.productRevision!==revision)fail('SOCIAL_REVIEW_STALE');
  if(body.expectedRevision!==undefined && body.expectedRevision!==job.revision)fail('SOCIAL_REVIEW_STALE');
  const reviewer=String(body.reviewer||'').trim();
  if(!reviewer||reviewer.length>100)fail('REVIEWER_REQUIRED');
  validateImportedReview(job,body);
  const payload={...job.payload};
  if(payload.importedMedia)payload.requiresVisualReview=false;
  if(job.channel==='tiktok'){
    const s=body.tiktokSettings;
    if(s?.content_preview_confirmed!==true||s.express_consent_given!==true)fail('TIKTOK_PREVIEW_CONSENT_REQUIRED');
    if(s.privacy_level!=='PUBLIC_TO_EVERYONE'||typeof s.allow_comment!=='boolean'||
      (payload.format==='reels'&&(typeof s.allow_duet!=='boolean'||typeof s.allow_stitch!=='boolean')))fail('TIKTOK_SETTINGS_REQUIRED');
    payload.tiktokSettings={...s};
  }
  return {payload,reviewer};
}

export function berlinWindow(now=new Date()){
  const hour=Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(now));
  return hour>=9&&hour<22;
}

export class SocialCoordinator {
  constructor({pool,cfg,providerCfg,freshSnapshot,provider,ensureAssets}){
    Object.assign(this,{pool,cfg,providerCfg,freshSnapshot});
    this.provider=provider||new ZernioOrganic(providerCfg);
    this.ensureAssets=ensureAssets;
  }
  async migrate(){
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_social_posts (
      id uuid PRIMARY KEY,product_id text NOT NULL REFERENCES marketing_products(id),
      channel text NOT NULL CHECK(channel IN ('tiktok','pinterest')),revision text NOT NULL,
      payload jsonb NOT NULL,status text NOT NULL CHECK(status IN
      ('draft_queued','approved','publishing','remote_pending','published','recovery_required','rejected','superseded')),
      remote jsonb NOT NULL DEFAULT '{}',error_code text,approved_by text,approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,attempted_at timestamptz,UNIQUE(product_id,channel,revision));
      CREATE INDEX IF NOT EXISTS marketing_social_queue ON marketing_social_posts(status,created_at)`);
  }
  async prepare(){
    // INVALID_PRODUCT_URL was thrown by buildRequest before any provider write.
    // Retire only those local failures with no remote checkpoint; never retry an
    // uncertain submission or discard its per-product duplicate protection.
    const retired=await this.pool.query(`UPDATE marketing_social_posts SET status='rejected',
      error_code='LOCAL_DESTINATION_REJECTED',updated_at=now()
      WHERE channel='pinterest' AND status='recovery_required'
        AND error_code='INVALID_PRODUCT_URL' AND remote='{}'::jsonb`);
    if(retired.rowCount)log('SOCIAL_LOCAL_FAILURE_RETIRED',{channel:'pinterest',count:retired.rowCount});
    const products=(await this.pool.query("SELECT document FROM marketing_products WHERE status='ready'")).rows;
    let queued=0;
    for(const {document:p} of products)for(const channel of Object.keys(this.providerCfg.accounts)){
      try{
        // Preserve authentic consent for already approved TikTok content when
        // only our presentation template changed. Source revisions still expire it.
        if(channel==='tiktok'){
          const approved=(await this.pool.query(`SELECT id FROM marketing_social_posts
            WHERE product_id=$1 AND channel='tiktok' AND status='approved'
              AND payload->>'productRevision'=$2 LIMIT 1`,[p.id,p.revision])).rows;
          if(approved.length)continue;
        }
        const payload=prepareSocial(p,channel,{...this.cfg,...this.providerCfg}),revision=hash(payload);
        await this.pool.query(`UPDATE marketing_social_posts SET status='superseded',updated_at=now()
          WHERE product_id=$1 AND channel=$2 AND revision<>$3 AND status IN ('draft_queued','approved')
          AND COALESCE(payload->>'importedMedia','false')<>'true'`,[p.id,channel,revision]);
        const r=await this.pool.query(`INSERT INTO marketing_social_posts(id,product_id,channel,revision,payload,status)
          SELECT $1,$2,$3,$4,$5,'draft_queued' WHERE NOT EXISTS (
            SELECT 1 FROM marketing_social_posts WHERE product_id=$2 AND channel=$3
              AND status IN ('publishing','remote_pending','published','recovery_required'))
          ON CONFLICT(product_id,channel,revision) DO NOTHING`,[randomUUID(),p.id,channel,revision,payload]);
        queued+=r.rowCount;
      }catch(e){log('SOCIAL_PREPARATION_PENDING',{productId:p.id,channel,reason:codeOf(e)});}
    }
    if(this.cfg.autonomyEnabled)await this.pool.query(`UPDATE marketing_social_posts s
      SET status='approved',approved_by='Mirko: homestro-reviewed-organic-v1',approved_at=now(),updated_at=now()
      FROM marketing_products p WHERE s.product_id=p.id AND s.channel='pinterest' AND s.status='draft_queued'
      AND p.status='ready' AND p.document->>'contentReviewed'='true'
      AND p.document->>'status'='ACTIVE' AND COALESCE(p.document->>'rejected','false')<>'true'
      AND s.payload->>'productRevision'=p.document->>'revision'
      AND COALESCE(s.payload->>'importedMedia','false')<>'true'
      AND NOT (s.product_id=ANY($1::text[]))`,[this.cfg.excludedProductIds||[]]);
    return {queued,adSpendEUR:0};
  }
  async list(status='draft_queued'){
    return (await this.pool.query('SELECT * FROM marketing_social_posts WHERE status=$1 ORDER BY created_at LIMIT 100',[status])).rows;
  }
  async checkTikTokPreflight(){
    const job=(await this.list('approved')).find(row=>row.channel==='tiktok'&&
      row.payload?.tiktokSettings?.content_preview_confirmed===true&&
      row.payload?.tiktokSettings?.express_consent_given===true);
    if(!job)fail('TIKTOK_NO_APPROVED_PREVIEW');
    const current=await this.freshSnapshot(job.product_id);
    if(!eligible(current,this.cfg)||current.revision!==job.payload.productRevision)fail('SOCIAL_REVIEW_STALE');
    // Zernio's dryRun checks TikTok permissions and payload validity without
    // creating a public post or consuming a publication slot.
    const result=await this.provider.preflightTikTok({...job,status:'publishing'});
    return {ok:result?.dryRun===true&&result?.canPublish===true,channel:'tiktok',format:job.payload.format};
  }
  async approve(id,body){
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const job=(await client.query('SELECT * FROM marketing_social_posts WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!job)fail('SOCIAL_POST_NOT_FOUND');
      const current=await this.freshSnapshot(job.product_id);
      if(!eligible(current,this.cfg))fail('SOCIAL_SOURCE_NOT_READY');
      const {payload,reviewer}=approvePayload(job,body,current.revision);
      const r=await client.query(`UPDATE marketing_social_posts SET payload=$2,status='approved',
        approved_by=$3,approved_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id,payload,reviewer]);
      await client.query('COMMIT');return r.rows[0];
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async checkpoint(id,remote){
    await this.pool.query('UPDATE marketing_social_posts SET remote=remote||$2::jsonb,updated_at=now() WHERE id=$1',[id,JSON.stringify(remote)]);
  }
  async settle(id,state){
    const status=state.status==='published'?'published':
      state.status==='verification_pending'?'remote_pending':'recovery_required';
    await this.pool.query(`UPDATE marketing_social_posts SET status=$2,remote=remote||$3::jsonb,
      published_at=CASE WHEN $2='published' THEN COALESCE(published_at,now()) ELSE published_at END,
      error_code=$4,updated_at=now() WHERE id=$1`,[id,status,JSON.stringify(state),status==='recovery_required'?'ZERNIO_REVIEW_REQUIRED':null]);
  }
  async report(){
    const counts=(await this.pool.query(`SELECT channel,status,count(*)::int AS count
      FROM (SELECT channel,status FROM marketing_posts UNION ALL
        SELECT channel,status FROM marketing_social_posts) posts GROUP BY channel,status ORDER BY channel,status`)).rows;
    const failures=(await this.pool.query(`SELECT channel,error_code,count(*)::int AS count
      FROM marketing_social_posts WHERE status IN ('approved','recovery_required','remote_pending')
        AND error_code IS NOT NULL GROUP BY channel,error_code ORDER BY channel,error_code`)).rows
      .filter(r=>/^[A-Z0-9_]{1,80}$/.test(r.error_code));
    const published=(await this.pool.query(`SELECT channel,remote->>'permalink' AS permalink,published_at
      FROM (SELECT channel,remote,published_at FROM marketing_posts WHERE status='published'
        UNION ALL SELECT channel,remote,published_at FROM marketing_social_posts WHERE status='published') posts
      ORDER BY published_at DESC NULLS LAST LIMIT 20`)).rows;
    const publications=published.flatMap(r=>{
      const permalink=publicPostURL(r.permalink,r.channel);
      return permalink?[{channel:r.channel,permalink,publishedAt:r.published_at}]:[];
    });
    return {counts,failures,publications,adSpendEUR:0};
  }
  async emitReport(force=false){
    if(!force && Date.now()-(this.lastReportAt||0)<5*60000)return;
    this.lastReportAt=Date.now();
    log('MARKETING_PUBLICATION_REPORT',await this.report());
  }
  async tick(now=new Date()){
    if(this.busy)return;this.busy=true;
    let client,locked=false;
    try{
      client=await this.pool.connect();
      locked=(await client.query('SELECT pg_try_advisory_lock(73341003) AS locked')).rows[0].locked;
      if(!locked)return;
      // A crash after submission must never make the job eligible for another write.
      await client.query(`UPDATE marketing_social_posts SET status='recovery_required',error_code='SOCIAL_INTERRUPTED'
        WHERE status='publishing'`);
      const pending=(await client.query(`SELECT * FROM marketing_social_posts WHERE status IN
        ('remote_pending','recovery_required') AND remote ? 'providerPostId' ORDER BY updated_at LIMIT 20`)).rows;
      for(const job of pending){
        try{await this.settle(job.id,await this.provider.reconcile(job.remote.providerPostId,job.channel));}
        catch(e){log('SOCIAL_VERIFICATION_PENDING',{postId:job.id,reason:codeOf(e)});}
      }
      if(typeof this.provider.recoverMissing==='function'){
        const missing=(await client.query(`SELECT * FROM marketing_social_posts
          WHERE status='recovery_required' AND NOT(remote ? 'providerPostId')
          AND remote ? 'idempotencyKey' ORDER BY updated_at LIMIT 20`)).rows;
        try{
          const recovered=await this.provider.recoverMissing(missing,(id,remote)=>this.checkpoint(id,remote));
          for(const result of recovered)await this.settle(result.id,result.state);
          if(missing.length)log('SOCIAL_RECOVERY_LOOKUP',{inspected:missing.length,recovered:recovered.length,
            unresolved:missing.length-recovered.length,writesPerformed:false});
        }catch(e){log('SOCIAL_RECOVERY_LOOKUP_PENDING',{reason:codeOf(e)});}
      }
      if(!this.cfg.workerEnabled||!this.cfg.publishingEnabled||!this.providerCfg.publishingEnabled||(!this.cfg.publishAroundClock&&!berlinWindow(now)))return;
      // A large approved TikTok batch must not starve Pinterest after TikTok's cap.
      const jobs=(await client.query(`SELECT * FROM (
        SELECT s.*,row_number() OVER (PARTITION BY channel ORDER BY approved_at,id) AS queue_rank
        FROM marketing_social_posts s WHERE status='approved'
          AND NOT EXISTS (SELECT 1 FROM marketing_publication_schedule plan WHERE plan.queue='marketing_social_posts' AND plan.post_id=s.id AND plan.scheduled_for>now())) fair
        WHERE queue_rank<=20 ORDER BY approved_at,id`)).rows;
      for(const job of jobs){
        if(!this.providerCfg.accounts[job.channel])continue;
        const used=(await client.query(`SELECT count(*)::int AS n FROM marketing_social_posts
          WHERE channel=$1 AND (published_at>now()-interval '24 hours'
            OR attempted_at>now()-interval '24 hours'
            OR (status IN ('publishing','remote_pending','recovery_required')
              AND attempted_at IS NULL AND created_at>now()-interval '24 hours'))`,[job.channel])).rows[0].n;
        const policy=channelPolicy(this.cfg,job.channel),spacing=policy.hours,dailyLimit=policy.daily;
        if(used>=dailyLimit)continue;
        if(this.cfg.publishEveryHours||this.cfg.organicPolicy==='balanced-v1') {
          const recent=(await client.query(`SELECT count(*)::int AS recent FROM marketing_social_posts
            WHERE channel=$1 AND COALESCE(attempted_at,published_at)>now()-$2::int*interval '1 hour'`,[job.channel,spacing])).rows[0].recent;
          if(recent>0)continue;
        }
        const duplicate=(await client.query(`SELECT id FROM marketing_social_posts WHERE product_id=$1 AND channel=$2
          AND id<>$3 AND status IN ('publishing','remote_pending','published','recovery_required') LIMIT 1`,
          [job.product_id,job.channel,job.id])).rows.length;
        let claimed=false;
        try{
          if(await repeatedMedia(client,'marketing_social_posts',job,this.cfg)){
            await client.query("UPDATE marketing_social_posts SET status='superseded',error_code='REPEATED_MEDIA' WHERE id=$1",[job.id]);
            log('SOCIAL_PUBLISH_SKIPPED',{postId:job.id,channel:job.channel,reason:'REPEATED_MEDIA'});continue;
          }
          const p=await this.freshSnapshot(job.product_id);
          if(duplicate||!eligible(p,this.cfg)||p.revision!==job.payload.productRevision){
            await client.query("UPDATE marketing_social_posts SET status='superseded',error_code='SOCIAL_SOURCE_CHANGED' WHERE id=$1",[job.id]);continue;
          }
          if(job.payload.requiresVisualReview)fail('IMPORTED_VISUAL_REVIEW_REQUIRED');
          if(this.ensureAssets)await this.ensureAssets(job,p);
          await client.query("UPDATE marketing_social_posts SET status='publishing',attempted_at=now(),updated_at=now() WHERE id=$1",[job.id]);
          claimed=true;
          // Mint only on the actual send; time-dependent tags must never change draft hashes.
          const payload=job.channel==='pinterest'&&this.cfg.adminKey
            ? {...job.payload,productURL:trackedDestination(p,'pinterest',job.payload.format,{secret:this.cfg.adminKey,now})}
            : job.payload;
          const state=await this.provider.submit({...job,payload,status:'publishing'},remote=>this.checkpoint(job.id,remote));
          await this.settle(job.id,state);
        }catch(e){
          // A definitive missing source cannot become publishable without a new draft.
          // Timeouts retain approval; any attempted write remains held for recovery.
          const nextStatus=claimed?'recovery_required':codeOf(e)==='PRODUCT_NOT_FOUND'?'superseded':'approved';
          await client.query(`UPDATE marketing_social_posts SET status=$3,error_code=$2,updated_at=now() WHERE id=$1`,
            [job.id,codeOf(e),nextStatus]);
          log(claimed?'SOCIAL_RECOVERY_REQUIRED':'SOCIAL_SOURCE_CHECK_PENDING',{postId:job.id,reason:codeOf(e)});
        }
      }
    }finally{
      if(locked)await client.query('SELECT pg_advisory_unlock(73341003)').catch(()=>{});
      client?.release();this.busy=false;
      await this.emitReport().catch(e=>log('SOCIAL_REPORT_PENDING',{reason:codeOf(e)}));
    }
  }
  start(){
    if(!this.cfg.workerEnabled)return;
    this.timer=setInterval(()=>void this.tick().catch(e=>log('SOCIAL_WORKER_ERROR',{reason:codeOf(e)})),60000);
    this.timer.unref();
  }
  stop(){clearInterval(this.timer);}
}
export function publicPostURL(value,channel){
  const hosts={facebook:['facebook.com','www.facebook.com'],instagram:['instagram.com','www.instagram.com'],
    tiktok:['tiktok.com','www.tiktok.com'],pinterest:['pinterest.com','www.pinterest.com']};
  try{
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||!hosts[channel]?.includes(u.hostname))return null;
    if(channel==='tiktok'&&!/^\/@[^/]+\/(video|photo)\/\d+\/?$/.test(u.pathname))return null;
    if(channel==='pinterest'&&!/^\/pin\/\d+\/?$/.test(u.pathname))return null;
    // Facebook can use story_fbid/id to identify a post; drop every other query.
    const query=new URLSearchParams();
    if(channel==='facebook')for(const key of ['story_fbid','id']){
      if(/^\d+$/.test(u.searchParams.get(key)||''))query.set(key,u.searchParams.get(key));
    }
    return u.origin+u.pathname+(query.size?'?'+query:'');
  }catch{return null;}
}


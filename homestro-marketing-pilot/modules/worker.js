import {codeOf,log} from './core.js';
import {editorialEnabled,validEditorial} from './editorial.js';
import {publicationWindow} from './autonomy.js';
import {repeatedMedia} from './publishing-policy.js';
import {carouselAssetKey,extractMedia} from './media.js';
import {sourceLooksGerman} from './source-localizer.js';

function sameProductPage(a,b) {
  try {
    const x=new URL(a),y=new URL(b);
    return x.origin==='https://homestro.de'&&y.origin==='https://homestro.de'&&
      x.pathname.replace(/\/$/,'')===y.pathname.replace(/\/$/,'');
  } catch { return false; }
}

async function autoApproveVerifiedDrafts({client,store,freshSnapshot,cfg}) {
  if(!cfg.autonomyEnabled)return 0;
  const candidates=(await client.query(`SELECT * FROM marketing_posts
    WHERE status='draft_queued' AND channel IN ('facebook','instagram')
      AND product_id ~ '^gid://shopify/Product/[0-9]+

export class Worker {
  constructor({store,meta,cfg,freshSnapshot,isPublishingWindow=publicationWindow,ensureImportedAssets}) {Object.assign(this,{store,meta,cfg,freshSnapshot,isPublishingWindow,ensureImportedAssets});this.busy=false;}
  async tick(postId=null) {
    if(this.busy){log('PUBLISH_BLOCKED',{reason:'WORKER_ALREADY_BUSY'});return;}
    if(!this.cfg.workerEnabled || !this.cfg.publishingEnabled){log('PUBLISH_BLOCKED',{reason:'PUBLISHING_DISABLED',workerEnabled:this.cfg.workerEnabled,publishingEnabled:this.cfg.publishingEnabled});return;}
    if(this.cfg.autonomyEnabled && !this.cfg.publishAroundClock && !this.isPublishingWindow()){log('PUBLISH_BLOCKED',{reason:'OUTSIDE_PUBLISHING_WINDOW'});return;}
    this.busy=true;
    try {
      const acquired=await this.store.withWorkerLock(async client=>{
        const count=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE
          (status='published' AND published_at>now()-interval '24 hours') OR (status IN ('publishing','recovery_required') AND COALESCE(attempted_at,updated_at)>now()-interval '24 hours')`)).rows[0].count);
        // Only recent attempts consume daily quota. Same-product uncertainty remains blocked below.
        if(count>=this.cfg.maxDailyPosts){
          log('PUBLISH_BLOCKED',{reason:'DAILY_TOTAL_LIMIT',publishedOrUncertainLast24h:count,limit:this.cfg.maxDailyPosts});
          return;
        }
        await autoApproveVerifiedDrafts({client,store:this.store,freshSnapshot:this.freshSnapshot,cfg:this.cfg});
        const job=(postId
          ? await client.query("SELECT * FROM marketing_posts WHERE status='approved' AND id=$1 AND NOT EXISTS (SELECT 1 FROM marketing_publication_schedule plan WHERE plan.queue='marketing_posts' AND plan.post_id=marketing_posts.id AND plan.scheduled_for>now())",[postId])
          : this.cfg.autonomyEnabled
            ? await client.query(`SELECT s.* FROM marketing_posts s WHERE s.status='approved'
              AND NOT EXISTS (SELECT 1 FROM marketing_publication_schedule plan WHERE plan.queue='marketing_posts' AND plan.post_id=s.id AND plan.scheduled_for>now())
              AND NOT (s.product_id=ANY($1::text[]))
              AND (SELECT count(*) FROM marketing_posts recent WHERE recent.channel=s.channel
                AND ((recent.status='published' AND recent.published_at>now()-interval '24 hours')
                  OR (recent.status IN ('publishing','recovery_required') AND COALESCE(recent.attempted_at,recent.updated_at)>now()-interval '24 hours'))) < $2::int
              AND NOT EXISTS (SELECT 1 FROM marketing_posts old WHERE old.channel=s.channel
                AND old.product_id=s.product_id AND old.id<>s.id AND old.status IN ('published','publishing','recovery_required'))
              AND ($3::int=0 OR NOT EXISTS (SELECT 1 FROM marketing_posts spaced WHERE spaced.channel=s.channel
                AND spaced.status IN ('published','publishing','recovery_required')
                AND COALESCE(spaced.published_at,spaced.attempted_at,spaced.updated_at)>now()-$3::int*interval '1 hour'))
              ORDER BY s.approved_at LIMIT 1`,[this.cfg.excludedProductIds||[],this.cfg.maxDailyPerChannel,this.cfg.publishEveryHours||0])
            : await client.query("SELECT * FROM marketing_posts WHERE status='approved' AND NOT EXISTS (SELECT 1 FROM marketing_publication_schedule plan WHERE plan.queue='marketing_posts' AND plan.post_id=marketing_posts.id AND plan.scheduled_for>now()) ORDER BY approved_at LIMIT 1")).rows[0];
        if(!job){
          log('PUBLISH_BLOCKED',{reason:'NO_ELIGIBLE_APPROVED_POST',publishedOrUncertainLast24h:count,limit:this.cfg.maxDailyPosts});
          return;
        }
        if(this.cfg.organicPolicy==='balanced-v1'){
          const used=Number((await client.query(`SELECT count(*) AS channel_used FROM marketing_posts
            WHERE channel=$1 AND ((status IN ('publishing','recovery_required') AND COALESCE(attempted_at,updated_at)>now()-interval '24 hours') OR
              (status='published' AND published_at>now()-interval '24 hours'))`,[job.channel])).rows[0].channel_used);
          if(used>=this.cfg.maxDailyPerChannel){log('PUBLISH_BLOCKED',{reason:'DAILY_CHANNEL_LIMIT',channel:job.channel});return;}
        }
        if(this.cfg.publishEveryHours) {
          const recent=Number((await client.query(`SELECT count(*) AS recent FROM marketing_posts WHERE channel=$1
            AND status IN ('published','publishing','recovery_required')
            AND COALESCE(published_at,attempted_at,updated_at)>now()-$2::int*interval '1 hour'`,[job.channel,this.cfg.publishEveryHours])).rows[0].recent);
          if(recent>0){log('PUBLISH_BLOCKED',{reason:'CHANNEL_INTERVAL',channel:job.channel,hours:this.cfg.publishEveryHours});return;}
        }
        if(job.payload.requiresVisualReview){log('PUBLISH_BLOCKED',{postId:job.id,reason:'IMPORTED_VISUAL_REVIEW_REQUIRED'});return;}
        if(job.payload.previewOnly===true) {
          await this.store.setStatus(job.id,'superseded','PREVIEW_NOT_PUBLISHABLE');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PREVIEW_NOT_PUBLISHABLE'});return;
        }
        if(this.cfg.excludedProductIds?.includes(job.product_id)) {
          await this.store.setStatus(job.id,'superseded','PRODUCT_EXCLUDED');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PRODUCT_EXCLUDED'});return;
        }
        if(this.cfg.autonomyEnabled) {
          const prior=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE product_id=$1 AND id<>$2 AND channel=$3
            AND (status IN ('publishing','recovery_required') OR
              (status='published' AND published_at>now()-interval '24 hours'))`,
            [job.product_id,job.id,job.channel])).rows[0].count);
          if(prior>0){log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,channel:job.channel,reason:'CHANNEL_OR_PRODUCT_RECENTLY_PUBLISHED',count:prior});return;}
        }
        if((job.product_id.startsWith('editorial:') || job.payload.kind==='brand_editorial') && !editorialEnabled()) {
          await this.store.setStatus(job.id,'superseded','EDITORIAL_DISABLED');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'EDITORIAL_DISABLED'});return;
        }
        if(await repeatedMedia(client,'marketing_posts',job,this.cfg)){
          await this.store.setStatus(job.id,'superseded','REPEATED_MEDIA');
          log('PUBLISH_SKIPPED',{postId:job.id,channel:job.channel,reason:'REPEATED_MEDIA'});return;
        }
        await this.meta.verifyConnection();
        const stored=await this.store.product(job.product_id);
        if(job.product_id.startsWith('editorial:') || job.payload.kind==='brand_editorial') {
          if(!validEditorial(job,stored,this.cfg)) {
            await this.store.setStatus(job.id,'superseded','EDITORIAL_CHANGED');
            log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'EDITORIAL_CHANGED'});return;
          }
        } else {
          const current=await this.freshSnapshot(job.product_id);
          if(!current || stored?.status!=='ready' || current.revision!==job.payload.productRevision ||
            current.rejected===true || current.status!=='ACTIVE' || !current.variants.some(v=>v.available && v.price>0)){
            await this.store.setStatus(job.id,'superseded','PRODUCT_CHANGED');
            log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PRODUCT_CHANGED',storedReady:stored?.status==='ready',currentActive:current?.status==='ACTIVE',revisionMatches:current?.revision===job.payload.productRevision});return;
          }
          if(job.payload.importedMedia){if(!this.ensureImportedAssets)throw new Error('IMPORTED_ASSET_VERIFIER_UNAVAILABLE');await this.ensureImportedAssets(job,current);}
        }
        log('PUBLISH_SELECTED',{postId:job.id,productId:job.product_id,channel:job.channel,title:job.payload.title||null});
        // Persist all prerequisites before Meta mutations.
        await this.store.setStatus(job.id,'publishing');job.status='publishing';
        let remote=job.remote;
        try {
          await this.meta.publish(job,async state=>{remote=state;await this.store.checkpoint(job.id,state);});
          await this.store.setStatus(job.id,'published');log('PUBLISHED',{postId:job.id,productId:job.product_id,channel:job.channel,title:job.payload.title||null});
          if(this.cfg.autonomyEnabled && remote?.postId) {
            try {
              const p=await this.meta.request(String(remote.postId),{fields:job.channel==='instagram'?'id,permalink,media_type':'id,permalink_url'});
              const permalink=p.permalink||p.permalink_url||null;
              await this.store.checkpoint(job.id,{...remote,permalink});
              log('PUBLICATION_VERIFIED',{postId:job.id,channel:job.channel,remotePostId:p.id,permalink});
            } catch {log('PUBLICATION_VERIFICATION_PENDING',{postId:job.id,channel:job.channel});}
          }
          if(this.cfg.publishOnce){this.cfg.publishingEnabled=false;this.cfg.workerEnabled=false;this.stop();log('ONE_SHOT_COMPLETE',{postId:job.id,channel:job.channel});}
        }catch(e){
          // No automatic retry of writes: timeout may mean the platform already accepted publication.
          await this.store.setStatus(job.id,'recovery_required',codeOf(e));
          log('RECOVERY_REQUIRED',{postId:job.id,productId:job.product_id,channel:job.channel,phase:remote?.phase||'preflight',reason:codeOf(e)});
        }
      });
      if(acquired===false)log('PUBLISH_BLOCKED',{reason:'WORKER_DATABASE_LOCK_BUSY'});
    }catch(e){log('PUBLISH_TICK_ERROR',{reason:codeOf(e)});}finally{this.busy=false;}
  }
  start(){if(this.timer)return;log('PUBLISH_WORKER_STARTED',{workerEnabled:this.cfg.workerEnabled,publishingEnabled:this.cfg.publishingEnabled,intervalMs:this.cfg.intervalMs});this.timer=setInterval(()=>void this.tick(),this.cfg.intervalMs);this.timer.unref();void this.tick();}
  stop(){clearInterval(this.timer);this.timer=null;}
}


    ORDER BY created_at LIMIT 20`)).rows;
  let approved=0;
  for(const job of candidates) {
    try {
      const payload=job.payload||{},stored=await store.product(job.product_id);
      const current=await freshSnapshot(job.product_id);
      const localized=current?.localized||current?.germanCopy||stored?.document?.localized||stored?.document?.germanCopy;
      const images=payload.imageURLs;
      if(!current||stored?.status!=='ready'||current.status!=='ACTIVE'||current.rejected===true||
        !current.contentReviewed||current.revision!==payload.productRevision||
        stored.document?.revision!==current.revision||localized?.language!=='de'||
        typeof localized.hook!=='string'||!localized.hook.trim()||
        typeof payload.caption!=='string'||payload.caption.length<20||payload.caption.length>2200||
        !payload.caption.includes(localized.hook)||!sourceLooksGerman(payload.caption)||
        !current.variants?.some(v=>v.available&&Number(v.price)>0)||
        !['image','carousel'].includes(payload.format)||payload.videoURL||
        !Array.isArray(images)||images.length<1||images.length>10) continue;

      const sourceImages=extractMedia(current.media||[]).images;
      if(!sourceImages.length)continue;
      let imageIsProductPhoto=false;
      if(payload.importedMedia===true) {
        const imported=(await client.query(`SELECT checksum,product_id,product_revision,metadata,asset,state
          FROM marketing_imported_media WHERE job_id=$1`,[payload.importedJobId])).rows[0];
        const asset=imported?.asset||{};
        imageIsProductPhoto=Boolean(imported&&imported.state==='queued'&&
          imported.product_id===job.product_id&&imported.product_revision===current.revision&&
          imported.checksum===payload.assetSha256&&imported.metadata?.provider==='higgsfield'&&
          imported.metadata?.kind==='image'&&sameProductPage(imported.metadata?.product_url,current.url)&&
          asset.format==='image'&&Array.isArray(asset.imageURLs)&&
          JSON.stringify(asset.imageURLs)===JSON.stringify(images));
      } else {
        const photoKeys=new Set(sourceImages.map(carouselAssetKey));
        imageIsProductPhoto=images.every(raw=>{
          try {
            const u=new URL(raw),match=u.pathname.match(/^\/marketing-assets\/([a-f0-9]{64})\.jpg$/);
            return u.origin===cfg.publicOrigin&&!u.search&&!u.hash&&!u.username&&!u.password&&
              Boolean(match&&photoKeys.has(match[1]));
          } catch { return false; }
        });
      }
      if(!imageIsProductPhoto)continue;

      const changed=await client.query(`UPDATE marketing_posts SET status='approved',
        approved_by='auto-verified-shopify-product-v1',approved_at=now(),updated_at=now(),
        payload=jsonb_set(payload,'{requiresVisualReview}','false'::jsonb)
        WHERE id=$1 AND status='draft_queued' AND product_id=$2
          AND payload->>'productRevision'=$3 RETURNING id`,
        [job.id,job.product_id,current.revision]);
      approved+=changed.rowCount;
    } catch {
      // A stale or temporarily unavailable source remains in draft_queued.
    }
  }
  if(approved)log('VERIFIED_DRAFTS_AUTO_APPROVED',{count:approved,channels:['facebook','instagram']});
  return approved;
}

export class Worker {
  constructor({store,meta,cfg,freshSnapshot,isPublishingWindow=publicationWindow,ensureImportedAssets}) {Object.assign(this,{store,meta,cfg,freshSnapshot,isPublishingWindow,ensureImportedAssets});this.busy=false;}
  async tick(postId=null) {
    if(this.busy){log('PUBLISH_BLOCKED',{reason:'WORKER_ALREADY_BUSY'});return;}
    if(!this.cfg.workerEnabled || !this.cfg.publishingEnabled){log('PUBLISH_BLOCKED',{reason:'PUBLISHING_DISABLED',workerEnabled:this.cfg.workerEnabled,publishingEnabled:this.cfg.publishingEnabled});return;}
    if(this.cfg.autonomyEnabled && !this.cfg.publishAroundClock && !this.isPublishingWindow()){log('PUBLISH_BLOCKED',{reason:'OUTSIDE_PUBLISHING_WINDOW'});return;}
    this.busy=true;
    try {
      const acquired=await this.store.withWorkerLock(async client=>{
        const count=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE
          (status='published' AND published_at>now()-interval '24 hours') OR (status IN ('publishing','recovery_required') AND COALESCE(attempted_at,updated_at)>now()-interval '24 hours')`)).rows[0].count);
        // Only recent attempts consume daily quota. Same-product uncertainty remains blocked below.
        if(count>=this.cfg.maxDailyPosts){
          log('PUBLISH_BLOCKED',{reason:'DAILY_TOTAL_LIMIT',publishedOrUncertainLast24h:count,limit:this.cfg.maxDailyPosts});
          return;
        }
        const job=(postId
          ? await client.query("SELECT * FROM marketing_posts WHERE status='approved' AND id=$1 AND NOT EXISTS (SELECT 1 FROM marketing_publication_schedule plan WHERE plan.queue='marketing_posts' AND plan.post_id=marketing_posts.id AND plan.scheduled_for>now())",[postId])
          : this.cfg.autonomyEnabled
            ? await client.query(`SELECT s.* FROM marketing_posts s WHERE s.status='approved'
              AND NOT EXISTS (SELECT 1 FROM marketing_publication_schedule plan WHERE plan.queue='marketing_posts' AND plan.post_id=s.id AND plan.scheduled_for>now())
              AND NOT (s.product_id=ANY($1::text[]))
              AND (SELECT count(*) FROM marketing_posts recent WHERE recent.channel=s.channel
                AND ((recent.status='published' AND recent.published_at>now()-interval '24 hours')
                  OR (recent.status IN ('publishing','recovery_required') AND COALESCE(recent.attempted_at,recent.updated_at)>now()-interval '24 hours'))) < $2::int
              AND NOT EXISTS (SELECT 1 FROM marketing_posts old WHERE old.channel=s.channel
                AND old.product_id=s.product_id AND old.id<>s.id AND old.status IN ('published','publishing','recovery_required'))
              AND ($3::int=0 OR NOT EXISTS (SELECT 1 FROM marketing_posts spaced WHERE spaced.channel=s.channel
                AND spaced.status IN ('published','publishing','recovery_required')
                AND COALESCE(spaced.published_at,spaced.attempted_at,spaced.updated_at)>now()-$3::int*interval '1 hour'))
              ORDER BY s.approved_at LIMIT 1`,[this.cfg.excludedProductIds||[],this.cfg.maxDailyPerChannel,this.cfg.publishEveryHours||0])
            : await client.query("SELECT * FROM marketing_posts WHERE status='approved' AND NOT EXISTS (SELECT 1 FROM marketing_publication_schedule plan WHERE plan.queue='marketing_posts' AND plan.post_id=marketing_posts.id AND plan.scheduled_for>now()) ORDER BY approved_at LIMIT 1")).rows[0];
        if(!job){
          log('PUBLISH_BLOCKED',{reason:'NO_ELIGIBLE_APPROVED_POST',publishedOrUncertainLast24h:count,limit:this.cfg.maxDailyPosts});
          return;
        }
        if(this.cfg.organicPolicy==='balanced-v1'){
          const used=Number((await client.query(`SELECT count(*) AS channel_used FROM marketing_posts
            WHERE channel=$1 AND ((status IN ('publishing','recovery_required') AND COALESCE(attempted_at,updated_at)>now()-interval '24 hours') OR
              (status='published' AND published_at>now()-interval '24 hours'))`,[job.channel])).rows[0].channel_used);
          if(used>=this.cfg.maxDailyPerChannel){log('PUBLISH_BLOCKED',{reason:'DAILY_CHANNEL_LIMIT',channel:job.channel});return;}
        }
        if(this.cfg.publishEveryHours) {
          const recent=Number((await client.query(`SELECT count(*) AS recent FROM marketing_posts WHERE channel=$1
            AND status IN ('published','publishing','recovery_required')
            AND COALESCE(published_at,attempted_at,updated_at)>now()-$2::int*interval '1 hour'`,[job.channel,this.cfg.publishEveryHours])).rows[0].recent);
          if(recent>0){log('PUBLISH_BLOCKED',{reason:'CHANNEL_INTERVAL',channel:job.channel,hours:this.cfg.publishEveryHours});return;}
        }
        if(job.payload.requiresVisualReview){log('PUBLISH_BLOCKED',{postId:job.id,reason:'IMPORTED_VISUAL_REVIEW_REQUIRED'});return;}
        if(job.payload.previewOnly===true) {
          await this.store.setStatus(job.id,'superseded','PREVIEW_NOT_PUBLISHABLE');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PREVIEW_NOT_PUBLISHABLE'});return;
        }
        if(this.cfg.excludedProductIds?.includes(job.product_id)) {
          await this.store.setStatus(job.id,'superseded','PRODUCT_EXCLUDED');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PRODUCT_EXCLUDED'});return;
        }
        if(this.cfg.autonomyEnabled) {
          const prior=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE product_id=$1 AND id<>$2 AND channel=$3
            AND (status IN ('publishing','recovery_required') OR
              (status='published' AND published_at>now()-interval '24 hours'))`,
            [job.product_id,job.id,job.channel])).rows[0].count);
          if(prior>0){log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,channel:job.channel,reason:'CHANNEL_OR_PRODUCT_RECENTLY_PUBLISHED',count:prior});return;}
        }
        if((job.product_id.startsWith('editorial:') || job.payload.kind==='brand_editorial') && !editorialEnabled()) {
          await this.store.setStatus(job.id,'superseded','EDITORIAL_DISABLED');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'EDITORIAL_DISABLED'});return;
        }
        if(await repeatedMedia(client,'marketing_posts',job,this.cfg)){
          await this.store.setStatus(job.id,'superseded','REPEATED_MEDIA');
          log('PUBLISH_SKIPPED',{postId:job.id,channel:job.channel,reason:'REPEATED_MEDIA'});return;
        }
        await this.meta.verifyConnection();
        const stored=await this.store.product(job.product_id);
        if(job.product_id.startsWith('editorial:') || job.payload.kind==='brand_editorial') {
          if(!validEditorial(job,stored,this.cfg)) {
            await this.store.setStatus(job.id,'superseded','EDITORIAL_CHANGED');
            log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'EDITORIAL_CHANGED'});return;
          }
        } else {
          const current=await this.freshSnapshot(job.product_id);
          if(!current || stored?.status!=='ready' || current.revision!==job.payload.productRevision ||
            current.rejected===true || current.status!=='ACTIVE' || !current.variants.some(v=>v.available && v.price>0)){
            await this.store.setStatus(job.id,'superseded','PRODUCT_CHANGED');
            log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PRODUCT_CHANGED',storedReady:stored?.status==='ready',currentActive:current?.status==='ACTIVE',revisionMatches:current?.revision===job.payload.productRevision});return;
          }
          if(job.payload.importedMedia){if(!this.ensureImportedAssets)throw new Error('IMPORTED_ASSET_VERIFIER_UNAVAILABLE');await this.ensureImportedAssets(job,current);}
        }
        log('PUBLISH_SELECTED',{postId:job.id,productId:job.product_id,channel:job.channel,title:job.payload.title||null});
        // Persist all prerequisites before Meta mutations.
        await this.store.setStatus(job.id,'publishing');job.status='publishing';
        let remote=job.remote;
        try {
          await this.meta.publish(job,async state=>{remote=state;await this.store.checkpoint(job.id,state);});
          await this.store.setStatus(job.id,'published');log('PUBLISHED',{postId:job.id,productId:job.product_id,channel:job.channel,title:job.payload.title||null});
          if(this.cfg.autonomyEnabled && remote?.postId) {
            try {
              const p=await this.meta.request(String(remote.postId),{fields:job.channel==='instagram'?'id,permalink,media_type':'id,permalink_url'});
              const permalink=p.permalink||p.permalink_url||null;
              await this.store.checkpoint(job.id,{...remote,permalink});
              log('PUBLICATION_VERIFIED',{postId:job.id,channel:job.channel,remotePostId:p.id,permalink});
            } catch {log('PUBLICATION_VERIFICATION_PENDING',{postId:job.id,channel:job.channel});}
          }
          if(this.cfg.publishOnce){this.cfg.publishingEnabled=false;this.cfg.workerEnabled=false;this.stop();log('ONE_SHOT_COMPLETE',{postId:job.id,channel:job.channel});}
        }catch(e){
          // No automatic retry of writes: timeout may mean the platform already accepted publication.
          await this.store.setStatus(job.id,'recovery_required',codeOf(e));
          log('RECOVERY_REQUIRED',{postId:job.id,productId:job.product_id,channel:job.channel,phase:remote?.phase||'preflight',reason:codeOf(e)});
        }
      });
      if(acquired===false)log('PUBLISH_BLOCKED',{reason:'WORKER_DATABASE_LOCK_BUSY'});
    }catch(e){log('PUBLISH_TICK_ERROR',{reason:codeOf(e)});}finally{this.busy=false;}
  }
  start(){if(this.timer)return;log('PUBLISH_WORKER_STARTED',{workerEnabled:this.cfg.workerEnabled,publishingEnabled:this.cfg.publishingEnabled,intervalMs:this.cfg.intervalMs});this.timer=setInterval(()=>void this.tick(),this.cfg.intervalMs);this.timer.unref();void this.tick();}
  stop(){clearInterval(this.timer);this.timer=null;}
}


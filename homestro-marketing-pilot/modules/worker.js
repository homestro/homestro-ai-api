import {codeOf,log} from './core.js';
import {editorialEnabled,validEditorial} from './editorial.js';
import {publicationWindow} from './autonomy.js';

export class Worker {
  constructor({store,meta,cfg,freshSnapshot,isPublishingWindow=publicationWindow}) {Object.assign(this,{store,meta,cfg,freshSnapshot,isPublishingWindow});this.busy=false;}
  async tick(postId=null) {
    if(this.busy || !this.cfg.workerEnabled || !this.cfg.publishingEnabled)return;
    if(this.cfg.autonomyEnabled && !this.isPublishingWindow())return;
    this.busy=true;
    try {
      await this.store.withWorkerLock(async client=>{
        const count=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE
          (status='published' AND published_at>now()-interval '24 hours') OR status='recovery_required'`)).rows[0].count);
        // Uncertain jobs consume quota until reconciled; never trigger a retry storm.
        if(count>=this.cfg.maxDailyPosts){
          log('PUBLISH_BLOCKED',{reason:'DAILY_TOTAL_LIMIT',publishedOrUncertainLast24h:count,limit:this.cfg.maxDailyPosts});
          return;
        }
        const job=(postId
          ? await client.query("SELECT * FROM marketing_posts WHERE status='approved' AND id=$1",[postId])
          : this.cfg.autonomyEnabled
            ? await client.query(`SELECT s.* FROM marketing_posts s WHERE s.status='approved'
              AND NOT (s.product_id=ANY($1::text[]))
              AND (SELECT count(*) FROM marketing_posts recent WHERE recent.channel=s.channel
                AND ((recent.status='published' AND recent.published_at>now()-interval '24 hours')
                  OR recent.status='recovery_required')) < $2::int
              AND NOT EXISTS (SELECT 1 FROM marketing_posts old WHERE old.channel=s.channel
                AND old.product_id=s.product_id AND old.id<>s.id AND old.status IN ('published','publishing','recovery_required'))
              ORDER BY s.approved_at LIMIT 1`,[this.cfg.excludedProductIds||[],this.cfg.maxDailyPerChannel])
            : await client.query("SELECT * FROM marketing_posts WHERE status='approved' ORDER BY approved_at LIMIT 1")).rows[0];
        if(!job){
          log('PUBLISH_BLOCKED',{reason:'NO_ELIGIBLE_APPROVED_POST',publishedOrUncertainLast24h:count,limit:this.cfg.maxDailyPosts});
          return;
        }
        if(job.payload.previewOnly===true) {
          await this.store.setStatus(job.id,'superseded','PREVIEW_NOT_PUBLISHABLE');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PREVIEW_NOT_PUBLISHABLE'});return;
        }
        if(this.cfg.excludedProductIds?.includes(job.product_id)) {
          await this.store.setStatus(job.id,'superseded','PRODUCT_EXCLUDED');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'PRODUCT_EXCLUDED'});return;
        }
        if(this.cfg.autonomyEnabled) {
          const prior=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE channel=$1
            AND ((status='published' AND published_at>now()-interval '24 hours')
              OR (product_id=$2 AND id<>$3 AND status IN ('published','publishing','recovery_required')))`,
            [job.channel,job.product_id,job.id])).rows[0].count);
          if(prior>0)return;
        }
        if((job.product_id.startsWith('editorial:') || job.payload.kind==='brand_editorial') && !editorialEnabled()) {
          await this.store.setStatus(job.id,'superseded','EDITORIAL_DISABLED');
          log('PUBLISH_SKIPPED',{postId:job.id,productId:job.product_id,reason:'EDITORIAL_DISABLED'});return;
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
    }catch(e){log('PUBLISH_TICK_ERROR',{reason:codeOf(e)});}finally{this.busy=false;}
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick(),this.cfg.intervalMs);this.timer.unref();void this.tick();}
  stop(){clearInterval(this.timer);this.timer=null;}
}

import {codeOf,log} from './core.js';
import {editorialEnabled,validEditorial} from './editorial.js';
import {publicationWindow} from './autonomy.js';

export class Worker {
  constructor({store,meta,cfg,freshSnapshot}) {Object.assign(this,{store,meta,cfg,freshSnapshot});this.busy=false;}
  async tick(postId=null) {
    if(this.busy || !this.cfg.workerEnabled || !this.cfg.publishingEnabled)return;
    if(this.cfg.autonomyEnabled && !publicationWindow())return;
    this.busy=true;
    try {
      await this.store.withWorkerLock(async client=>{
        const count=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE
          (status='published' AND published_at>now()-interval '24 hours') OR status='recovery_required'`)).rows[0].count);
        // Uncertain jobs consume quota until reconciled; never trigger a retry storm.
        if(count>=this.cfg.maxDailyPosts)return;
        const job=(postId
          ? await client.query("SELECT * FROM marketing_posts WHERE status='approved' AND id=$1",[postId])
          : this.cfg.autonomyEnabled
            ? await client.query(`SELECT s.* FROM marketing_posts s WHERE s.status='approved'
              AND NOT (s.product_id=ANY($1::text[]))
              AND NOT EXISTS (SELECT 1 FROM marketing_posts old WHERE old.channel=s.channel
                AND ((old.status='published' AND old.published_at>now()-interval '24 hours')
                  OR (old.product_id=s.product_id AND old.id<>s.id AND old.status IN ('published','publishing','recovery_required'))))
              ORDER BY s.approved_at LIMIT 1`,[this.cfg.excludedProductIds||[]])
            : await client.query("SELECT * FROM marketing_posts WHERE status='approved' ORDER BY approved_at LIMIT 1")).rows[0];
        if(!job)return;
        if(job.payload.previewOnly===true) {
          await this.store.setStatus(job.id,'superseded','PREVIEW_NOT_PUBLISHABLE');return;
        }
        if(this.cfg.excludedProductIds?.includes(job.product_id)) {
          await this.store.setStatus(job.id,'superseded','PRODUCT_EXCLUDED');return;
        }
        if(this.cfg.autonomyEnabled) {
          const prior=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE channel=$1
            AND ((status='published' AND published_at>now()-interval '24 hours')
              OR (product_id=$2 AND id<>$3 AND status IN ('published','publishing','recovery_required')))`,
            [job.channel,job.product_id,job.id])).rows[0].count);
          if(prior>0)return;
        }
        if((job.product_id.startsWith('editorial:') || job.payload.kind==='brand_editorial') && !editorialEnabled()) {
          await this.store.setStatus(job.id,'superseded','EDITORIAL_DISABLED');return;
        }
        await this.meta.verifyConnection();
        const stored=await this.store.product(job.product_id);
        if(job.product_id.startsWith('editorial:') || job.payload.kind==='brand_editorial') {
          if(!validEditorial(job,stored,this.cfg)) {
            await this.store.setStatus(job.id,'superseded','EDITORIAL_CHANGED');return;
          }
        } else {
          const current=await this.freshSnapshot(job.product_id);
          if(!current || stored?.status!=='ready' || current.revision!==job.payload.productRevision ||
            current.status!=='ACTIVE' || !current.variants.some(v=>v.available && v.price>0)){
            await this.store.setStatus(job.id,'superseded','PRODUCT_CHANGED');return;
          }
        }
        // Persist all prerequisites before Meta mutations.
        await this.store.setStatus(job.id,'publishing');job.status='publishing';
        let remote=job.remote;
        try {
          await this.meta.publish(job,async state=>{remote=state;await this.store.checkpoint(job.id,state);});
          await this.store.setStatus(job.id,'published');log('PUBLISHED',{postId:job.id,channel:job.channel});
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
          log('RECOVERY_REQUIRED',{postId:job.id,phase:remote?.phase||'preflight'});
        }
      });
    }catch(e){log(codeOf(e));}finally{this.busy=false;}
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick(),this.cfg.intervalMs);this.timer.unref();void this.tick();}
  stop(){clearInterval(this.timer);this.timer=null;}
}

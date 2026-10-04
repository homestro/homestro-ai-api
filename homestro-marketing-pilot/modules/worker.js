import {codeOf,log} from './core.js';

export class Worker {
  constructor({store,meta,cfg,freshSnapshot}) {Object.assign(this,{store,meta,cfg,freshSnapshot});this.busy=false;}
  async tick() {
    if(this.busy || !this.cfg.workerEnabled || !this.cfg.publishingEnabled)return;
    this.busy=true;
    try {
      await this.store.withWorkerLock(async client=>{
        await this.meta.verifyConnection();
        const count=Number((await client.query(`SELECT count(*) FROM marketing_posts WHERE
          (status='published' AND updated_at>now()-interval '24 hours') OR status='recovery_required'`)).rows[0].count);
        // Uncertain jobs consume quota until reconciled; never trigger a retry storm.
        if(count>=this.cfg.maxDailyPosts)return;
        const job=(await client.query("SELECT * FROM marketing_posts WHERE status='approved' ORDER BY approved_at LIMIT 1")).rows[0];
        if(!job)return;
        const current=await this.freshSnapshot(job.product_id);
        const stored=await this.store.product(job.product_id);
        if(!current || stored?.status!=='ready' || current.revision!==job.payload.productRevision ||
          current.status!=='ACTIVE' || !current.variants.some(v=>v.available && v.price>0)){
          await this.store.setStatus(job.id,'superseded','PRODUCT_CHANGED');return;
        }
        // Persist all prerequisites before Meta mutations.
        await this.store.setStatus(job.id,'publishing');job.status='publishing';
        let remote=job.remote;
        try {
          await this.meta.publish(job,async state=>{remote=state;await this.store.checkpoint(job.id,state);});
          await this.store.setStatus(job.id,'published');log('PUBLISHED',{postId:job.id,channel:job.channel});
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

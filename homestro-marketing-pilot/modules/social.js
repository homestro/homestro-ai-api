import {randomUUID} from 'node:crypto';
import {hash,fail,codeOf,log,productURL} from './core.js';
import {compilePost} from './localization.js';
import {ZernioOrganic} from './zernio.js';

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
  const result=compilePost(p,channel,p.asset);
  result.title=result.title.slice(0,channel==='pinterest'?100:result.format==='reels'?150:90);
  result.productURL=result.link;
  if(channel==='pinterest'){
    result.boardId=cfg.boardId;
    if(result.format!=='reels'){result.imageURLs=result.imageURLs.slice(0,1);result.format='image';}
    if(result.caption.length>800)fail('PINTEREST_COPY_LIMIT');
  }
  return result;
}

export function approvePayload(job,body,revision) {
  if(job.status!=='draft_queued'||job.payload.productRevision!==revision)fail('SOCIAL_REVIEW_STALE');
  const reviewer=String(body.reviewer||'').trim();
  if(!reviewer||reviewer.length>100)fail('REVIEWER_REQUIRED');
  const payload={...job.payload};
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
  constructor({pool,cfg,providerCfg,freshSnapshot,provider}){
    Object.assign(this,{pool,cfg,providerCfg,freshSnapshot});
    this.provider=provider||new ZernioOrganic(providerCfg);
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
    const products=(await this.pool.query("SELECT document FROM marketing_products WHERE status='ready'")).rows;
    let queued=0;
    for(const {document:p} of products)for(const channel of Object.keys(this.providerCfg.accounts)){
      try{
        const payload=prepareSocial(p,channel,{...this.cfg,...this.providerCfg}),revision=hash(payload);
        await this.pool.query(`UPDATE marketing_social_posts SET status='superseded',updated_at=now()
          WHERE product_id=$1 AND channel=$2 AND revision<>$3 AND status IN ('draft_queued','approved')`,[p.id,channel,revision]);
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
      AND NOT (s.product_id=ANY($1::text[]))`,[this.cfg.excludedProductIds||[]]);
    return {queued,adSpendEUR:0};
  }
  async list(status='draft_queued'){
    return (await this.pool.query('SELECT * FROM marketing_social_posts WHERE status=$1 ORDER BY created_at LIMIT 100',[status])).rows;
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
      if(!this.cfg.workerEnabled||!this.cfg.publishingEnabled||!this.providerCfg.publishingEnabled||!berlinWindow(now))return;
      const jobs=(await client.query("SELECT * FROM marketing_social_posts WHERE status='approved' ORDER BY approved_at LIMIT 20")).rows;
      for(const job of jobs){
        if(!this.providerCfg.accounts[job.channel])continue;
        const used=(await client.query(`SELECT count(*)::int AS n FROM marketing_social_posts
          WHERE channel=$1 AND (status IN ('publishing','remote_pending','recovery_required')
            OR published_at>now()-interval '24 hours' OR attempted_at>now()-interval '24 hours')`,[job.channel])).rows[0].n;
        if(used>=1)continue; // At most one new product per channel in any rolling 24 hours.
        const duplicate=(await client.query(`SELECT id FROM marketing_social_posts WHERE product_id=$1 AND channel=$2
          AND id<>$3 AND status IN ('publishing','remote_pending','published','recovery_required') LIMIT 1`,
          [job.product_id,job.channel,job.id])).rows.length;
        let claimed=false;
        try{
          const p=await this.freshSnapshot(job.product_id);
          if(duplicate||!eligible(p,this.cfg)||p.revision!==job.payload.productRevision){
            await client.query("UPDATE marketing_social_posts SET status='superseded',error_code='SOCIAL_SOURCE_CHANGED' WHERE id=$1",[job.id]);continue;
          }
          await client.query("UPDATE marketing_social_posts SET status='publishing',attempted_at=now(),updated_at=now() WHERE id=$1",[job.id]);
          claimed=true;
          const state=await this.provider.submit({...job,status:'publishing'},remote=>this.checkpoint(job.id,remote));
          await this.settle(job.id,state);
        }catch(e){
          await client.query(`UPDATE marketing_social_posts SET status=$3,error_code=$2,updated_at=now() WHERE id=$1`,
            [job.id,codeOf(e),claimed?'recovery_required':'approved']);
          log(claimed?'SOCIAL_RECOVERY_REQUIRED':'SOCIAL_SOURCE_CHECK_PENDING',{postId:job.id,reason:codeOf(e)});
        }
      }
    }finally{
      if(locked)await client.query('SELECT pg_advisory_unlock(73341003)').catch(()=>{});
      client?.release();this.busy=false;
    }
  }
  start(){
    if(!this.cfg.workerEnabled)return;
    this.timer=setInterval(()=>void this.tick().catch(e=>log('SOCIAL_WORKER_ERROR',{reason:codeOf(e)})),60000);
    this.timer.unref();
  }
  stop(){clearInterval(this.timer);}
}

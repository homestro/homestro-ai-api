import {fail,log,codeOf} from './core.js';
import {extractMedia} from './media.js';
import {openAiHealth} from './openai-health.js';
import {channelPolicy} from './publishing-policy.js';
import {publicPostURL} from './social.js';

const channels=['facebook','instagram','tiktok','pinterest'];
const berlinDay=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const berlinHour=date=>Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/Berlin',hour:'2-digit',hourCycle:'h23'}).format(date));
export function publicationSlot(after,{aroundClock=false}={}){
  const result=new Date(after);
  if(!Number.isFinite(result.getTime()))fail('INVALID_SCHEDULE_TIME');
  // UTC increments respect Berlin DST gaps and folds without inventing local offsets.
  for(let i=0;i<192;i++){
    if(aroundClock||(berlinHour(result)>=9&&berlinHour(result)<22))return result;
    result.setTime(result.getTime()+15*60000);
  }
  fail('PUBLICATION_WINDOW_UNAVAILABLE');
}
export function videoScenario(product,{importedVideo=false}={}){
  const copy=product.localized||{},facts=Array.isArray(product.facts)?product.facts:[];
  const benefits=(Array.isArray(copy.benefits)?copy.benefits:[]).filter(b=>facts.some(f=>f.id===b.factId)).slice(0,2);
  const media=extractMedia(product.media||[]);
  return {productId:product.id,sourceRevision:product.revision,language:'de',markets:['DE','AT'],
    title:copy.title||null,kind:media.videoURL||importedVideo?'reuse_existing_video':'motion_draft_requires_cost_approval',
    sourceFactIds:benefits.map(b=>b.factId),
    shots:[{seconds:2,visual:'Produkt unverändert anhand der Originalreferenz zeigen',copy:copy.title||null},
      {seconds:2,visual:'Natürliche Bewegung; keine unbelegte Anwendung oder Wirkung erfinden',copy:benefits[0]?.text||null},
      {seconds:1,visual:'Produkt klar zeigen',copy:'Bei Homestro entdecken'}],
    readyForQuote:Boolean(copy.language==='de'&&benefits.length&&media.images.length&&!media.videoURL&&!importedVideo),
    generationAuthorized:false,visualFidelityReviewRequired:true};
}
export function queueReadback(row,schedule=null){
  const payload=row.payload||{},remote=row.remote||{};
  const permalink=publicPostURL(remote.permalink||'',row.channel);
  return {queue:row.queue,id:row.id,productId:row.product_id,channel:row.channel,status:row.status,
    mediaKind:payload.videoURL?'video':payload.imageURLs?.length?'image':'missing',
    importedJobId:payload.importedJobId||null,requiresVisualReview:payload.requiresVisualReview===true,
    scheduledFor:row.status==='approved'?schedule?.scheduled_for||null:null,
    platformId:remote.postId||remote.platformPostId||null,providerPostId:remote.providerPostId||null,permalink,
    recordedPublished:row.status==='published',evidence:'persisted_publisher_receipt_not_fresh_platform_readback'};
}

// Schedules the existing queues. It never approves, creates content or sends to a provider.
export class MarketingOperations{
  constructor({pool,cfg,socialEnabled=false,clock=()=>new Date()}){Object.assign(this,{pool,cfg,socialEnabled,clock});}
  async migrate(){await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_publication_schedule(
    queue text NOT NULL CHECK(queue IN ('marketing_posts','marketing_social_posts')),post_id uuid NOT NULL,
    product_revision text NOT NULL,channel text NOT NULL,scheduled_for timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(queue,post_id));
    CREATE TABLE IF NOT EXISTS marketing_daily_operations(
      day text PRIMARY KEY,report jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);}
  async inventory(db=this.pool){
    const products=(await db.query('SELECT id,document,status FROM marketing_products ORDER BY id')).rows;
    const native=(await db.query("SELECT *, 'marketing_posts' AS queue FROM marketing_posts ORDER BY created_at,id")).rows;
    const social=this.socialEnabled?(await db.query("SELECT *, 'marketing_social_posts' AS queue FROM marketing_social_posts ORDER BY created_at,id")).rows:[];
    const imports=(await db.query('SELECT job_id,product_id,product_revision,metadata,state,receipt FROM marketing_imported_media ORDER BY created_at')).rows;
    const generated=(await db.query('SELECT job_key,product_id,revision,state,task_id,error_code,cost_cents FROM marketing_generated_videos ORDER BY created_at')).rows;
    const schedules=(await db.query('SELECT * FROM marketing_publication_schedule ORDER BY scheduled_for,post_id')).rows;
    return {products,queues:[...native,...social],imports,generated,schedules};
  }
  async schedule(inventory,now,db=this.pool){
    const products=new Map(inventory.products.map(r=>[r.id,r]));
    const scheduled=new Map(inventory.schedules.map(r=>[r.queue+':'+r.post_id,r]));
    const tails=new Map();
    for(const channel of channels){
      const attempts=inventory.queues.filter(r=>r.channel===channel&&['publishing','published','recovery_required','remote_pending'].includes(r.status))
        .map(r=>new Date(r.published_at||r.attempted_at||r.updated_at).getTime()).filter(Number.isFinite);
      const reservations=inventory.schedules.filter(r=>r.channel===channel&&inventory.queues.some(q=>q.id===r.post_id&&q.queue===r.queue&&q.status==='approved'&&q.payload?.productRevision===r.product_revision)).map(r=>new Date(r.scheduled_for).getTime()).filter(Number.isFinite);
      const times=[...attempts,...reservations];tails.set(channel,times.length?Math.max(...times):null);
    }
    let added=0;const blockers=[],reservedProducts=new Set();
    for(const row of inventory.queues){
      if(row.status!=='approved')continue;
      const p=products.get(row.product_id),payload=row.payload||{},identity=row.queue+':'+row.id;
      let reason=null;
      if(!channels.includes(row.channel))reason='CHANNEL_UNSUPPORTED';
      else if(payload.requiresVisualReview||payload.previewOnly)reason='VISUAL_REVIEW_OR_SOURCE_REQUIRED';
      else if(p?.status!=='ready'||p.document.status!=='ACTIVE'||p.document.revision!==payload.productRevision||p.document.rejected||
        this.cfg.excludedProductIds?.includes(row.product_id))reason='SOURCE_NOT_CURRENT_AND_READY';
      else if(inventory.queues.some(other=>other.id!==row.id&&other.product_id===row.product_id&&other.channel===row.channel&&
        ['publishing','published','remote_pending','recovery_required'].includes(other.status)))reason='EXISTING_OR_UNCERTAIN_PUBLICATION';
      else if(row.channel==='tiktok'&&(payload.tiktokSettings?.express_consent_given!==true||payload.tiktokSettings?.content_preview_confirmed!==true))reason='TIKTOK_PREVIEW_CONSENT_REQUIRED';
      if(!reason&&reservedProducts.has(row.product_id+':'+row.channel))reason='SAME_PRODUCT_ALREADY_SCHEDULED';
      if(reason){blockers.push({queue:row.queue,id:row.id,channel:row.channel,reason});continue;}
      reservedProducts.add(row.product_id+':'+row.channel);
      const old=scheduled.get(identity);
      if(old?.product_revision===payload.productRevision){
        const time=new Date(old.scheduled_for).getTime();if(Number.isFinite(time))tails.set(row.channel,Math.max(tails.get(row.channel)||0,time));
        continue;
      }
      const policy=channelPolicy(this.cfg,row.channel),hours=Math.max(1,policy.hours||24);
      const after=Math.max(now.getTime(),(tails.get(row.channel)??now.getTime()-hours*3600000)+hours*3600000);
      const slot=publicationSlot(after,{aroundClock:this.cfg.publishAroundClock===true});
      // A stable assignment survives restart. Changing product revisions requires a new review/queue row.
      await db.query(`INSERT INTO marketing_publication_schedule(queue,post_id,product_revision,channel,scheduled_for)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(queue,post_id) DO NOTHING`,[row.queue,row.id,payload.productRevision,row.channel,slot]);
      tails.set(row.channel,slot.getTime());added++;
    }
    return {added,blockers};
  }
  async tick(){
    if(this.busy)return {status:'busy'};this.busy=true;let client,locked=false;
    try{
      client=await this.pool.connect();locked=(await client.query('SELECT pg_try_advisory_lock(73341023) AS locked')).rows[0]?.locked;
      if(!locked)return {status:'busy'};
      const now=this.clock(),inventory=await this.inventory(client);
      const planning=this.cfg.workerEnabled&&this.cfg.publishingEnabled?await this.schedule(inventory,now,client):{added:0,blockers:[{reason:'PUBLISHING_DISABLED'}]};
      const schedules=(await client.query('SELECT * FROM marketing_publication_schedule ORDER BY scheduled_for,post_id')).rows;
      const scheduleMap=new Map(schedules.map(r=>[r.queue+':'+r.post_id,r]));
      const receipts=inventory.queues.map(r=>queueReadback(r,scheduleMap.get(r.queue+':'+r.id)));
      const media={sourceImages:0,nativeVideoProducts:0,importedImages:0,importedVideos:0,generatedStates:{}};
      const images=new Set();
      for(const p of inventory.products){const source=extractMedia(p.document.media||[]);source.images.forEach(u=>images.add(u));if(source.videoURL)media.nativeVideoProducts++;}
      media.sourceImages=images.size;
      for(const row of inventory.imports){if(row.metadata.kind==='video')media.importedVideos++;else if(row.metadata.kind==='image')media.importedImages++;}
      for(const row of inventory.generated)media.generatedStates[row.state]=(media.generatedStates[row.state]||0)+1;
      const report={version:1,brand:'Homestro',markets:['DE','AT'],day:berlinDay(now),generatedAt:now.toISOString(),
        catalog:{records:inventory.products.length,ready:inventory.products.filter(p=>p.status==='ready').length,scope:'all_persisted_shopify_catalog_states'},
        media,planning,receipts,videoScenarios:inventory.products.filter(p=>p.status==='ready'&&p.document.status==='ACTIVE'&&!p.document.rejected&&!this.cfg.excludedProductIds?.includes(p.id)).map(p=>videoScenario(p.document,{importedVideo:inventory.imports.some(row=>row.product_id===p.id&&row.product_revision===p.document.revision&&row.state==='queued'&&row.metadata.kind==='video')})),openai:await openAiHealth(this.cfg),
        economics:{orders:null,revenueEUR:null,actualCostsEUR:null,netProfitEUR:null,
          reason:'SIGNED_ORDER_AND_EXACT_SPEND_ACCOUNTING_OWNED_BY_ADTECH_SERVICE',source:'/pilot/economics'},
        generationPerformed:false,adSpendAuthorizedEUR:0,newPublicationConfirmed:false};
      await client.query(`INSERT INTO marketing_daily_operations(day,report,updated_at) VALUES($1,$2,now())
        ON CONFLICT(day) DO UPDATE SET report=$2,updated_at=now()`,[report.day,report]);
      log('MARKETING_OPERATIONS',{day:report.day,catalogRecords:report.catalog.records,scheduled:receipts.filter(r=>r.scheduledFor).length,
        importedImages:media.importedImages,importedVideos:media.importedVideos,newPublicationConfirmed:false,generationPerformed:false});
      return report;
    }finally{if(locked)await client.query('SELECT pg_advisory_unlock(73341023)').catch(()=>{});client?.release();this.busy=false;}
  }
  async report(day=berlinDay(this.clock())){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail('INVALID_REPORT_DAY');
    return (await this.pool.query('SELECT report FROM marketing_daily_operations WHERE day=$1',[day])).rows[0]?.report||{status:'not_observed',day};
  }
  start(){if(this.timer)return;const run=()=>this.tick().catch(e=>log('MARKETING_OPERATIONS_PENDING',{reason:codeOf(e)}));
    this.timer=setInterval(()=>void run(),60000);this.timer.unref();void run();}
  stop(){clearInterval(this.timer);this.timer=null;}
}

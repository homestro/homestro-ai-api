import {codeOf,fail,log,productURL} from './core.js';
import {extractMedia} from './media.js';

const sourceMedia=p=>extractMedia(Array.isArray(p.media)?p.media.filter(n=>n&&typeof n==='object'):[]);
const pathOf=value=>{try{return decodeURIComponent(productURL(value).pathname).normalize('NFKC').toLocaleLowerCase('de-DE').replace(/\/$/,'');}catch{return null;}};
export function catalogDecision(product,{demand=null,demandUpdatedAt=null,now=new Date(),excludedProductIds=[]}={}){
  const media=sourceMedia(product),blockers=[];
  if(product.rejected===true)blockers.push('PRODUCT_REJECTED');
  if(excludedProductIds.includes(product.id))blockers.push('PRODUCT_EXCLUDED_BY_POLICY');
  if(product.status!=='ACTIVE')blockers.push('PRODUCT_NOT_ACTIVE');
  if(!Array.isArray(product.variants)||!product.variants.some(v=>v?.available&&Number(v.price)>0))blockers.push('NO_AVAILABLE_VARIANT');
  if(!pathOf(product.url))blockers.push('NO_PUBLIC_PRODUCT_URL');
  if(!media.images.length&&!media.videoURL)blockers.push('NO_MARKETING_MEDIA');
  const age=now.getTime()-new Date(demandUpdatedAt||0).getTime();
  const fresh=Boolean(demand&&['connected','partial'].includes(demand.status)&&age>=0&&age<=2*3600000);
  const signal=fresh?demand.byPath?.[pathOf(product.url)]:null;
  const numeric=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const checkouts=numeric(signal?.checkouts),carts=numeric(signal?.carts),sessions=numeric(signal?.sessions);
  return {productId:product.id,revision:product.revision,eligible:blockers.length===0,blockers,
    sourceImageCount:media.images.length,nativeVideoAvailable:Boolean(media.videoURL),
    priority:Math.min(1000,checkouts*100+carts*20+Math.min(sessions,50)),
    demandEvidence:fresh?'shopify_human_landing_aggregate':'unavailable',
    tasks:{copy:product.localizationPrepared&&product.localized?'prepared':'prepare_from_existing_facts',
      image:media.images.length?'reuse_existing_product_photos':'no_source',
      video:media.videoURL?'reuse_native_product_footage':'MOTION_VIDEO_COST_APPROVAL_REQUIRED',
      publication:'existing_channel_workers_and_verified_receipts',
      paidAds:'PURCHASE_HARD_LOCK_AND_NO_NEW_SPEND_AUTHORIZATION'},
    creativeBrief:{language:'de',title:product.localized?.title||null,hook:product.localized?.hook||null,
      benefits:(Array.isArray(product.localized?.benefits)?product.localized.benefits:[]).filter(b=>b&&Array.isArray(product.facts)&&product.facts.some(f=>f?.id===b.factId)).map(b=>({factId:b.factId,text:b.text})),
      sourceProductURL:product.url||null,portraitRatio:'9:16',productFidelityRequired:true,
      generatedMotionReviewRequired:true,syntheticTestimonialsAllowed:false},
    paidGenerationAuthorized:false,adSpendEUR:0};
}

// One coordinator for existing ingestion and existing workers. No second publisher,
// no provider/model calls and no inferred approval of imported media or TikTok previews.
export class CatalogBrain{
  constructor({pool,processProduct,afterPrepare=async()=>{},autoApprovalEnabled=false,enabled=true,batchSize=8,clock=()=>new Date(),excludedProductIds=[]}){
    Object.assign(this,{pool,processProduct,afterPrepare,autoApprovalEnabled,enabled,clock,excludedProductIds});
    this.batchSize=Math.max(1,Math.min(20,Number(batchSize)||8));this.busy=false;
  }
  async migrate(){await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_catalog_brain(
    product_id text PRIMARY KEY REFERENCES marketing_products(id) ON DELETE CASCADE,
    source_revision text NOT NULL,decision jsonb NOT NULL,state text NOT NULL,
    priority integer NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),last_attempt_at timestamptz,
    outcome jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now())`);}
  async reconcile(now=this.clock()){
    const products=(await this.pool.query('SELECT document FROM marketing_products ORDER BY id')).rows;
    let demand=null,demandUpdatedAt=null;
    if((await this.pool.query("SELECT to_regclass('marketing_product_sales') AS present")).rows[0]?.present){
      const cached=(await this.pool.query('SELECT payload,updated_at FROM marketing_product_sales WHERE id=1')).rows[0];
      demand=cached?.payload;demandUpdatedAt=cached?.updated_at;
    }
    let eligible=0,imageReferences=0,nativeVideos=0;const images=new Set();
    for(const {document:p} of products){
      const d=catalogDecision(p,{demand,demandUpdatedAt,now,excludedProductIds:this.excludedProductIds});
      if(d.eligible)eligible++;imageReferences+=d.sourceImageCount;if(d.nativeVideoAvailable)nativeVideos++;
      for(const url of sourceMedia(p).images)images.add(url);
      await this.pool.query(`INSERT INTO marketing_catalog_brain(product_id,source_revision,decision,state,priority,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(product_id) DO UPDATE SET
        decision=excluded.decision,priority=excluded.priority,
        state=CASE WHEN marketing_catalog_brain.source_revision<>excluded.source_revision THEN excluded.state
          WHEN NOT ($3::jsonb->>'eligible')::boolean THEN 'blocked'
          WHEN marketing_catalog_brain.state='blocked' THEN excluded.state ELSE marketing_catalog_brain.state END,
        next_attempt_at=CASE WHEN marketing_catalog_brain.source_revision<>excluded.source_revision
          OR (marketing_catalog_brain.state='blocked' AND ($3::jsonb->>'eligible')::boolean) THEN excluded.next_attempt_at
          ELSE marketing_catalog_brain.next_attempt_at END,
        source_revision=excluded.source_revision,updated_at=now()`,
        [p.id,p.revision,d,d.eligible?'due':'blocked',d.priority,now]);
    }
    return {catalogRecords:products.length,eligible,sourceImages:images.size,sourceImageReferences:imageReferences,nativeVideoProducts:nativeVideos,
      scope:'all_persisted_shopify_catalog_states',higgsfieldImportLimitApplied:false,adSpendEUR:0};
  }
  async receipts(productId){
    const tables=['marketing_posts'];
    if((await this.pool.query("SELECT to_regclass('marketing_social_posts') AS present")).rows[0]?.present)tables.push('marketing_social_posts');
    const result=[];
    for(const table of tables){
      const rows=(await this.pool.query(`SELECT channel,status,count(*)::int AS count FROM ${table}
        WHERE product_id=$1 GROUP BY channel,status ORDER BY channel,status`,[productId])).rows;
      result.push(...rows);
    }
    return result;
  }
  async tick(){
    if(!this.enabled||this.busy)return {status:this.enabled?'busy':'disabled',processed:0};
    this.busy=true;let client,locked=false;
    try{
      client=await this.pool.connect();
      // Shared with the existing complete catalog sync: never race source revisions.
      locked=(await client.query('SELECT pg_try_advisory_lock(73341002) AS locked')).rows[0]?.locked;
      if(!locked)return {status:'catalog_sync_busy',processed:0};
      const now=this.clock(),coverage=await this.reconcile(now);
      const rows=(await client.query(`SELECT product_id,source_revision FROM marketing_catalog_brain
        WHERE state<>'blocked' AND next_attempt_at<=$1 ORDER BY
        (last_attempt_at IS NOT NULL),priority DESC,last_attempt_at NULLS FIRST,product_id LIMIT $2`,[now,this.batchSize])).rows;
      const outcomes=[];
      for(const row of rows){
        // Reserve a retry delay before ingestion. A process crash cannot hot-loop.
        await client.query(`UPDATE marketing_catalog_brain SET state='processing',attempts=attempts+1,
          last_attempt_at=$2,next_attempt_at=$3 WHERE product_id=$1`,
          [row.product_id,now,new Date(now.getTime()+30*60000)]);
        let result;
        try{result=await this.processProduct(row.product_id);}
        catch(e){result={processed:0,status:'failed',reasons:[codeOf(e)]};}
        const receipts=await this.receipts(row.product_id);
        const outcome={status:result?.status||'unconfirmed',processed:result?.processed||0,
          reasons:result?.reasons||[],newQueueRows:result?.queued||0,receipts,paidGenerationPerformed:false};
        const ready=result?.status==='draft_queued';
        await client.query(`UPDATE marketing_catalog_brain SET state=$2,outcome=$3,next_attempt_at=$4,updated_at=now()
          WHERE product_id=$1`,[row.product_id,ready?'prepared':'waiting',outcome,
          new Date(now.getTime()+(ready?24*3600000:4*3600000))]);
        outcomes.push({productId:row.product_id,...outcome});
      }
      let consumerPreparation={status:'not_needed'};
      if(outcomes.some(x=>x.status==='draft_queued')){
        try{await this.afterPrepare();consumerPreparation={status:'existing_consumers_checked'};}
        catch(e){consumerPreparation={status:'unavailable',reason:codeOf(e)};}
        for(const outcome of outcomes){
          outcome.receipts=await this.receipts(outcome.productId);
          const {productId,...saved}=outcome;
          await client.query('UPDATE marketing_catalog_brain SET outcome=$2 WHERE product_id=$1',[productId,saved]);
        }
      }
      const result={status:'checked',...coverage,processed:outcomes.length,outcomes,consumerPreparation,
        publicationAutoApprovalEnabled:this.autoApprovalEnabled,
        newPublicationConfirmed:false,historicalPublishedReceipts:outcomes.flatMap(x=>x.receipts).filter(r=>r.status==='published').reduce((n,r)=>n+r.count,0),
        publicationBasis:'existing_database_receipts_not_new_platform_readback',paidGenerationPerformed:false};
      log('CATALOG_BRAIN_CYCLE',result);return result;
    }finally{
      if(locked)await client.query('SELECT pg_advisory_unlock(73341002)').catch(()=>{});
      client?.release();this.busy=false;
    }
  }
  async report({after=null}={}){
    if(after!==null&&(typeof after!=='string'||after.length<1||after.length>256||/[\u0000-\u001f\u007f]/.test(after)))fail('INVALID_CATALOG_CURSOR');
    const counts=(await this.pool.query('SELECT state,count(*)::int AS count FROM marketing_catalog_brain GROUP BY state ORDER BY state')).rows;
    const page=(await this.pool.query(`SELECT product_id,decision,state,outcome,last_attempt_at,next_attempt_at
      FROM marketing_catalog_brain WHERE ($1::text IS NULL OR product_id>$1)
      ORDER BY product_id ASC LIMIT 101`,[after])).rows;
    const rows=page.slice(0,100),pageInfo={hasNextPage:page.length>100,endCursor:rows.at(-1)?.product_id||null};
    // Current queue readback, bound to the exact source revision; older posts are not evidence for a new creative.
    const ids=rows.map(r=>r.product_id),receipts=[];
    const tables=['marketing_posts'];
    if((await this.pool.query("SELECT to_regclass('marketing_social_posts') AS present")).rows[0]?.present)tables.push('marketing_social_posts');
    for(const table of ids.length?tables:[]){
      const found=(await this.pool.query(`SELECT product_id,payload->>'productRevision' AS revision,
        channel,status,count(*)::int AS count FROM ${table} WHERE product_id=ANY($1::text[])
        GROUP BY product_id,payload->>'productRevision',channel,status`,[ids])).rows;
      receipts.push(...found);
    }
    const products=rows.map(r=>({...r,currentReceipts:receipts.filter(x=>x.product_id===r.product_id&&x.revision===r.decision?.revision)
      .map(({channel,status,count})=>({channel,status,count}))}));
    return {generatedAt:this.clock().toISOString(),enabled:this.enabled,publicationAutoApprovalEnabled:this.autoApprovalEnabled,counts,products,pageInfo,adSpendEUR:0,paidGenerationAuthorized:false,
      note:'Prepared or queued is distinct from published; motion generation requires an approved price.'};
  }
}

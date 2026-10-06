import express from 'express';
import {join} from 'node:path';
import {secureEqual,codeOf,log,fail,config} from './core.js';
import {Store} from './store.js';
import {fetchProduct,syncCatalog} from './shopify.js';
import {MediaRenderer} from './media.js';
import {Ingestion,snapshot} from './ingestion.js';
import {MetaOrganic} from './meta.js';
import {Worker} from './worker.js';
import {generateFeed} from './feed.js';
import {registerReview} from './review.js';
import {reviewedSource,approveReviewed,verifyHistory} from './autonomy.js';

export async function attachMarketing(app,{pool,graphql,localizer,prepareInputs,apiKeyMiddleware,cfg=config()}) {
  // Await initialization once at startup. Errors disable marketing, never the main server.
  try {
    if(!apiKeyMiddleware && (!cfg.adminKey || cfg.adminKey.length<32))fail('PILOT_ADMIN_KEY_REQUIRED');
    const store=new Store(pool);await store.migrate();
    const renderer=new MediaRenderer(cfg), meta=new MetaOrganic(cfg);
    const ingestion=new Ingestion({store,renderer,localizer,feeRate:cfg.feeRate});
    const extras=async(id,raw)=>({...((prepareInputs && raw)?await prepareInputs(raw):{}),
      ...((await pool.query('SELECT inputs FROM marketing_inputs WHERE product_id=$1',[id])).rows[0]?.inputs||{})});
    const fresh=async id=>{const raw=await fetchProduct(graphql,id);return snapshot(raw,await extras(id,raw),cfg.feeRate);};
    const processProduct=async (id,scheduled=false)=>{
      try{
        if(cfg.excludedProductIds?.includes(id))return {processed:1,status:'excluded'};
        const raw=await fetchProduct(graphql,id),inputs=await extras(id,raw);
        if(scheduled && !reviewedSource(inputs)) {
          await store.saveProduct(snapshot(raw,inputs,cfg.feeRate),'pending_marketing',['SOURCE_REVIEW_REQUIRED']);
          return {processed:1,status:'pending_marketing'};
        }
        return await ingestion.process(raw,inputs);
      }
      catch(e){
        // Archived/deleted products are invalidated and disappear from the feed.
        if(codeOf(e)==='PRODUCT_NOT_FOUND'){
          const old=await store.product(id);
          if(old)await store.saveProduct({...old.document,status:'ARCHIVED'},'pending_marketing',['PRODUCT_NOT_FOUND']);
        }
        log(codeOf(e),{productId:id});return {processed:0,status:'pending_marketing'};
      }
    };
    const worker=new Worker({store,meta,cfg,freshSnapshot:fresh});
    let syncBusy=false,syncTimer;
    const sync=async()=>{
      if(syncBusy)return {busy:true};syncBusy=true;
      let client,locked=false;
      try {
        client=await pool.connect();
        locked=(await client.query('SELECT pg_try_advisory_lock(73341002) AS locked')).rows[0].locked;
        if(!locked)return {busy:true};
        // Refresh previously ready items too: active catalog omits archived/deleted products.
        for(const p of await store.feedRows())await processProduct(p.id,cfg.autonomyEnabled);
        const r=await syncCatalog(graphql,id=>processProduct(id,cfg.autonomyEnabled));
        await approveReviewed(store,cfg);log('CATALOG_SYNC',r);return r;
      }catch(e){log(codeOf(e));return {error:codeOf(e)};}
      finally{if(locked)await client.query('SELECT pg_advisory_unlock(73341002)').catch(()=>{});client?.release();syncBusy=false;}
    };
    const auth=(req,res,next)=>{
      const key=req.get('authorization')?.replace(/^Bearer /,'');
      if(!secureEqual(key,cfg.adminKey))return res.status(401).json({error:'UNAUTHORIZED'});
      next();
    };
    const route=handler=>async(req,res)=>{try{await handler(req,res);}catch(e){res.status(400).json({error:codeOf(e)});}};
    const router=express.Router();router.use(apiKeyMiddleware||auth,express.json({limit:'128kb'}));
    router.get('/posts',route(async(req,res)=>res.json(await store.list(req.query.status||'draft_queued'))));
    router.get('/pending-products',route(async(req,res)=>res.json(await store.pending())));
    router.get('/status',route(async(req,res)=>{
      const products=(await pool.query('SELECT status,count(*)::int AS count FROM marketing_products GROUP BY status')).rows;
      const posts=(await pool.query('SELECT status,count(*)::int AS count FROM marketing_posts GROUP BY status')).rows;
      res.json({enabled:true,workerEnabled:cfg.workerEnabled,publishingEnabled:cfg.publishingEnabled,
        feedEnabled:cfg.feedEnabled,products,posts,adSpendEUR:0});
    }));
    router.get('/connection',route(async(req,res)=>{await meta.verifyConnection();res.json({ok:true,publishingEnabled:cfg.publishingEnabled,adSpendEUR:0});}));
    router.post('/posts/:id/approve',route(async(req,res)=>{
      const reviewer=String(req.body.reviewer||'').trim();if(!reviewer || reviewer.length>100)fail('REVIEWER_REQUIRED');
      res.json(await store.approve(req.params.id,reviewer));
    }));
    // Explicit input review. Never automatically trust supplier footage or invented facts.
    router.put('/products/:id/inputs',route(async(req,res)=>{
      if(!/^gid:\/\/shopify\/Product\/\d+$/.test(req.params.id))fail('INVALID_PRODUCT_ID');
      const b=req.body;
      if(!Array.isArray(b.facts) || b.facts.length>30 || b.facts.some(f=>!f.id || !f.text))fail('INVALID_FACTS');
      await pool.query(`INSERT INTO marketing_inputs(product_id,inputs) VALUES($1,$2)
        ON CONFLICT(product_id) DO UPDATE SET inputs=$2,updated_at=now()`,[req.params.id,b]);
      res.json(await processProduct(req.params.id));
    }));
    router.post('/sync',route(async(req,res)=>res.json(await sync())));
    // No endpoint blindly changes recovery_required back to approved. Inspect platform IDs first.
    app.use('/api/marketing/v2',router);
    registerReview(app);
    app.use('/marketing-assets',express.static(join(cfg.dataDir,'assets'),{
      dotfiles:'deny',index:false,fallthrough:false,maxAge:'7d',immutable:true,
      setHeaders:res=>{res.set('X-Content-Type-Options','nosniff');}
    }));
    app.get('/feeds/google-organic-v2.xml',route(async(req,res)=>{
      if(!cfg.feedEnabled)return res.status(503).json({error:'FEED_DISABLED'});
      // Freshness is checked at request time. No stale price/stock is emitted on an API failure.
      const products=[];
      for(const p of await store.feedRows()){
        try{
          const current=await fresh(p.id);
          if(current.revision!==p.revision){await processProduct(p.id);const row=await store.product(p.id);if(row?.status==='ready')products.push(row.document);}
          else products.push(p);
        }catch{ /* Fail closed for this product, not for the shop. */ }
        if(products.reduce((n,p)=>n+p.variants.length,0)>=cfg.feedCap)break;
      }
      res.set('Cache-Control','no-store').type('application/xml').send(generateFeed(products,cfg));
    }));
    if(cfg.autonomyEnabled){
      await verifyHistory(store,meta,cfg);
      await sync(); // Rebuild any missing assets before enabling the publication timer.
      const posts=(await pool.query('SELECT status,count(*)::int AS count FROM marketing_posts GROUP BY status')).rows;
      const products=(await pool.query('SELECT status,count(*)::int AS count FROM marketing_products GROUP BY status')).rows;
      log('AUTONOMY_READY',{policy:'homestro-reviewed-organic-v1',posts,products,maxDailyPosts:cfg.maxDailyPosts,
        maxDailyPerChannel:1,timezone:'Europe/Berlin',hours:'09:00-22:00',adSpendEUR:0});
    }
    worker.start();
    if(cfg.syncOnce){
      log('SYNC_ONCE_START',{publishingEnabled:cfg.publishingEnabled,workerEnabled:cfg.workerEnabled});
      try {
        const r=await sync();
        const rows=(await pool.query(`SELECT id,channel,payload FROM marketing_posts WHERE status='draft_queued' ORDER BY created_at DESC LIMIT 100`)).rows;
        const carousels=rows.filter(x=>x.payload?.format==='carousel').map(x=>({id:x.id,channel:x.channel,imageCount:Array.isArray(x.payload?.imageURLs)?x.payload.imageURLs.length:0,title:x.payload?.title||null}));
        const pendingReasons=(await pool.query(`SELECT reason, count(*)::int AS count FROM marketing_products p CROSS JOIN LATERAL jsonb_array_elements_text(p.reasons) reason WHERE p.status='pending_marketing' GROUP BY reason ORDER BY count DESC,reason LIMIT 20`)).rows;
        log('SYNC_ONCE_COMPLETE',{processed:r?.processed||0,carouselCount:carousels.length,carousels,pendingReasons});
      } catch(e) { log('SYNC_ONCE_FAILED',{reason:codeOf(e)}); }
    }
    if(cfg.workerEnabled){syncTimer=setInterval(()=>void sync(),15*60000);syncTimer.unref();if(!cfg.autonomyEnabled)void sync();}
    log('INITIALIZED',{publishingEnabled:cfg.publishingEnabled,feedEnabled:cfg.feedEnabled,adSpendEUR:0});
    return {enabled:true,processProduct,sync,store,worker,
      stop(){worker.stop();clearInterval(syncTimer);}};
  }catch(e){log('DISABLED',{reason:codeOf(e)});return {enabled:false,processProduct:async()=>({processed:0,status:'marketing_disabled'}),stop(){}};}
}

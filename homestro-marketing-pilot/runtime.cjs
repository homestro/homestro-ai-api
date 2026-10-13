'use strict';
// Existing server adapter. Primary Shopify pipeline never depends on marketing initialization.
function marketingGraphqlAllowed(query) {
  const source=String(query||'').trim();
  if(/^query(?:\s|\{)/i.test(source))return true;
  const normalized=source.replace(/\s+/g,' ');
  const allowed=new Set([
    'mutation PilotProductSeoUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id seo { title description } } userErrors { field message } } }',
    'mutation PilotArticleDraft($article: ArticleCreateInput!) { articleCreate(article: $article) { article { id title handle isPublished onlineStoreUrl } userErrors { field message } } }',
    'mutation PilotGuideCreate($page: PageCreateInput!) { pageCreate(page: $page) { page { id handle isPublished } userErrors { field message } } }',
    'mutation PilotGuideUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id handle isPublished } userErrors { field message } } }'
  ]);
  return allowed.has(normalized);
}
function registerMarketingPilot(app,{graphql,apiKey,env=process.env,getCredentials,onCredentialError}={}) {
  let instance=null,state={enabled:false,reason:'initializing'};
  app.get('/api/marketing/v2/runtime',apiKey,(_req,res)=>res.json({...state,adSpendEUR:0}));
  const ready=(async()=>{
    if(!env.DATABASE_URL){state={enabled:false,reason:'DATABASE_URL_MISSING'};console.log('[organic-pilot-v2] '+JSON.stringify(state));return null;}
    try {
      const [{default:pg},{attachMarketing},{config},{prepareExistingInputs},{createSourceLocalizer}]=await Promise.all([
        import('pg'),import('./modules/index.js'),import('./modules/core.js'),import('./modules/bridge.js'),import('./modules/source-localizer.js')]);
      const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,query_timeout:15000});
      pool.on('error',()=>console.warn('[organic-pilot-v2] DATABASE_CONNECTION_ERROR'));
      const cfg=config({...env,PILOT_ADMIN_KEY:env.PILOT_ADMIN_KEY||env.HOMESTRO_API_KEY});
      cfg.getCredentials=getCredentials;cfg.onCredentialError=onCredentialError;
      const boundedGraphql=(query,variables)=>{
        if(!marketingGraphqlAllowed(query))throw new Error('Marketing Shopify operation not allowed');
        let timer;
        return Promise.race([graphql(query,variables),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('SHOPIFY_TIMEOUT')),20000);
        })]).finally(()=>clearTimeout(timer));
      };
      instance=await attachMarketing(app,{pool,graphql:boundedGraphql,cfg,
        localizer:createSourceLocalizer({apiKey:env.OPENAI_API_KEY,model:env.OPENAI_MODEL}),
        prepareInputs:prepareExistingInputs,apiKeyMiddleware:apiKey});
      state={enabled:instance.enabled,workerEnabled:cfg.workerEnabled,publishingEnabled:cfg.publishingEnabled,syncOnce:cfg.syncOnce};
      console.log('[organic-pilot-v2] '+JSON.stringify(state));
      process.once('SIGTERM',()=>{instance?.stop();void pool.end().catch(()=>{});});
      if(!instance.enabled)await pool.end();
      if(instance.enabled && env.PILOT_TEST_ONCE_JSON) {
        try {
          const [{runOneShot},{fetchProduct},{snapshot}]=await Promise.all([
            import('./modules/one-shot.js'),import('./modules/shopify.js'),import('./modules/ingestion.js')]);
          const request=JSON.parse(env.PILOT_TEST_ONCE_JSON);
          const freshSnapshot=async id=>{
            const raw=await fetchProduct(boundedGraphql,id);
            const saved=(await pool.query('SELECT inputs FROM marketing_inputs WHERE product_id=$1',[id])).rows[0]?.inputs||{};
            return snapshot(raw,{...prepareExistingInputs(raw),...saved},cfg.feeRate);
          };
          await runOneShot({request,instance,pool,cfg,freshSnapshot});
        } catch(e) {console.warn('[organic-pilot-v2] '+JSON.stringify({reason:'TARGET_ONE_SHOT_FAILED',code:e?.code||'INTERNAL_ERROR'}));}
      }
      return instance;
    }catch(e){
      const name=String(e?.name||'Error').slice(0,60);
      const message=String(e?.message||'').slice(0,180);
      const code=String(e?.code||'').slice(0,60);
      state={enabled:false,reason:'INITIALIZATION_FAILED'};
      console.warn('[organic-pilot-v2] '+JSON.stringify({reason:'INITIALIZATION_FAILED',name,code,message}));
      return null;
    }
  })();
  return {ready,processProduct:async id=>{
    try{return (await ready)?.processProduct(id)||{processed:0,status:'marketing_disabled'};}
    catch{return {processed:0,status:'pending_marketing'};}
  }};
}
module.exports={registerMarketingPilot,marketingGraphqlAllowed};


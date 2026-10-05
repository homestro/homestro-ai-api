'use strict';
// Existing server adapter. Primary Shopify pipeline never depends on marketing initialization.
function registerMarketingPilot(app,{graphql,apiKey,env=process.env}={}) {
  let instance=null,state={enabled:false,reason:'initializing'};
  app.get('/api/marketing/v2/runtime',apiKey,(_req,res)=>res.json({...state,adSpendEUR:0}));
  const ready=(async()=>{
    if(!env.DATABASE_URL){state={enabled:false,reason:'DATABASE_URL_MISSING'};console.log('[organic-pilot-v2] '+JSON.stringify(state));return null;}
    try {
      const [{default:pg},{attachMarketing},{config},{prepareExistingInputs}]=await Promise.all([
        import('pg'),import('./modules/index.js'),import('./modules/core.js'),import('./modules/bridge.js')]);
      const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,query_timeout:15000});
      pool.on('error',()=>console.warn('[organic-pilot-v2] DATABASE_CONNECTION_ERROR'));
      const cfg=config({...env,PILOT_ADMIN_KEY:env.PILOT_ADMIN_KEY||env.HOMESTRO_API_KEY});
      const boundedGraphql=(query,variables)=>{
        if(!String(query).trim().startsWith('query '))throw new Error('Marketing Shopify reads only');
        let timer;
        return Promise.race([graphql(query,variables),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('SHOPIFY_TIMEOUT')),20000);
        })]).finally(()=>clearTimeout(timer));
      };
      instance=await attachMarketing(app,{pool,graphql:boundedGraphql,cfg,prepareInputs:prepareExistingInputs,apiKeyMiddleware:apiKey});
      state={enabled:instance.enabled,workerEnabled:cfg.workerEnabled,publishingEnabled:cfg.publishingEnabled,syncOnce:cfg.syncOnce};
      console.log('[organic-pilot-v2] '+JSON.stringify(state));
      process.once('SIGTERM',()=>{instance?.stop();void pool.end().catch(()=>{});});
      if(!instance.enabled)await pool.end();
      return instance;
    }catch(e){
      const name=String(e?.name||'Error').slice(0,60);
      const message=String(e?.message||'').replace(/(token|key|password|secret|postgres(?:ql)?:\\/\\/)[^\\s]*/gi,'$1[redacted]').slice(0,180);
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
module.exports={registerMarketingPilot};

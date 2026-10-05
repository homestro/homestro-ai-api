'use strict';
const {buildOrganicDraft}=require('./organic-marketing');
const {publishOrganicDraft}=require('./meta-organic');
const {queueDraft,listDrafts,approveDraft,markPublished,hasQueuedProduct}=require('./organic-staging');
const QUERY='query OrganicProducts { products(first: 30, query: "status:active") { nodes { id title handle status tags onlineStoreUrl priceRangeV2 { minVariantPrice { amount currencyCode } } featuredMedia { ... on MediaImage { image { url } } } metafields(first:20,namespace:"homestro"){nodes{key value}} variants(first: 100) { nodes { id price inventoryQuantity inventoryPolicy } } } } }';
async function organicPreview(graphql,fetchImpl=global.fetch){
  const data=await graphql(QUERY);
  const skipped=[];
  const excludedProductIds=new Set(String(process.env.META_ORGANIC_EXCLUDED_PRODUCT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean));
  for(const p of data.products.nodes){
    try {
      if(excludedProductIds.has(String(p.id))||/\\blick\\s*mat\\b|\\blick\\s*pad\\b/i.test(`${p.title||''} ${p.handle||''} ${p.onlineStoreUrl||''}`))throw Error('Product explicitly excluded from organic marketing');
      const marketingMf=Object.fromEntries((p.metafields?.nodes||[]).map(m=>[m.key,String(m.value||'')]));
      if(marketingMf.organic_facebook_post_id&&marketingMf.organic_instagram_post_id)throw Error('Product already published on Meta');
      if(hasQueuedProduct(p.id))throw Error('Product already queued or published in this worker session');
      if(p.priceRangeV2.minVariantPrice.currencyCode!=='EUR')throw Error('Unsupported currency');
      if(!p.onlineStoreUrl)throw Error('Not published in online store');
      const tags=p.tags||[];
      if(tags.some(t=>/pending|rejected|review-required/i.test(t)))throw Error('Product review pending');
      if(!/^https:\/\/(www\.)?homestro\.de\/products\/[a-z0-9-]+\/?$/.test(p.onlineStoreUrl))throw Error('Unexpected storefront URL');
      const url=new URL(p.onlineStoreUrl);url.pathname += '.js';
      const response=await fetchImpl(url,{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('Storefront unavailable');
      const publicProduct=await response.json();
      if(String(publicProduct.id)!==p.id.split('/').pop())throw Error('Storefront product mismatch');
      const available=(publicProduct.variants||[]).filter(v=>v.available&&Number(v.price)>0).sort((a,b)=>a.price-b.price);
      if(!available.length)throw Error('No available variant');
      const variant=available[0];
      const productUrl=new URL(p.onlineStoreUrl);productUrl.searchParams.set('variant',String(variant.id));
      const product={id:p.id,title:p.title,status:p.status,tags:p.tags,url:productUrl.href,price:Number(variant.price)/100,available:true,imageUrl:variant.featured_image?.src||p.featuredMedia?.image?.url};
      return {ok:true,drafts:['facebook','instagram'].map(channel=>queueDraft(buildOrganicDraft(product,channel))),skipped,published:false};
    }catch(error){skipped.push({productId:p.id,reason:error.message});}
  }
  return {ok:false,error:'No eligible product in the first 30 active products',skipped,published:false};
}
function registerOrganicCatalog(app,apiKey,graphql){
  app.get('/api/marketing/organic/drafts',apiKey,(_req,res)=>res.json({ok:true,drafts:listDrafts()}));
  app.post('/api/marketing/organic/drafts/:id/approve',apiKey,(req,res)=>{try{const d=approveDraft(req.params.id);if(!d)return res.status(404).json({ok:false,error:'Draft not found'});res.json({ok:true,draft:d});}catch(e){res.status(409).json({ok:false,error:e.message});}});
  app.post('/api/marketing/organic/drafts/:id/publish',apiKey,async(req,res)=>{try{const d=listDrafts().find(x=>x.id===req.params.id);if(!d)return res.status(404).json({ok:false,error:'Draft not found'});if(d.status!=='approved')return res.status(409).json({ok:false,error:'Draft must be approved first'});const result=await publishOrganicDraft(d);
      const key=result.channel==='facebook'?'organic_facebook_post_id':'organic_instagram_post_id';
      const saved=await graphql('mutation($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){userErrors{field message code}}}',{metafields:[{ownerId:d.productId,namespace:'homestro',key,type:'single_line_text_field',value:String(result.id)}]});
      const errs=saved.metafieldsSet?.userErrors||[];if(errs.length)throw Error('Published but Shopify history save failed: '+errs.map(e=>e.message).join('; '));
      res.json({ok:true,draft:markPublished(d.id,result),result,paidAds:false});}catch(e){res.status(502).json({ok:false,error:e.message,published:false,paidAds:false});}});
  app.get('/api/marketing/organic/preview',apiKey,async(_req,res)=>{
    try{res.json(await organicPreview(graphql));}catch(_){res.status(502).json({ok:false,error:'Product preview failed',published:false});}
  });
  if(process.env.META_PAGE_ACCESS_TOKEN){
    void organicPreview(graphql).then(result=>console.log('[organic-marketing-preview] '+JSON.stringify(result))).catch(()=>console.log('[organic-marketing-preview] product preview failed'));
  }

  if(process.env.META_ORGANIC_PUBLISH_ONCE==='approved-2026-10-04'){
    void organicPreview(graphql).then(async preview=>{
      if(!preview.ok)throw new Error(preview.error||'No organic preview');
      const results=[];
      for(const draft of preview.drafts.filter(d=>process.env.META_ORGANIC_PUBLISH_CHANNEL?d.channel===process.env.META_ORGANIC_PUBLISH_CHANNEL:true)){
        try{results.push(await publishOrganicDraft(draft));}
        catch(error){results.push({channel:draft.channel,published:false,error:error.message,metaCode:error.meta?.code||null,metaSubcode:error.meta?.error_subcode||null});}
      }
      console.log('[organic-marketing-publish-once] '+JSON.stringify({results,paidAds:false}));
    }).catch(error=>console.log('[organic-marketing-publish-once] '+JSON.stringify({error:error.message,published:false,paidAds:false})));
  }
}
module.exports={organicPreview,registerOrganicCatalog};

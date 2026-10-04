'use strict';
const {buildOrganicDraft}=require('./organic-marketing');
const QUERY='query OrganicProducts { products(first: 30, query: "status:active") { nodes { id title handle status tags onlineStoreUrl priceRangeV2 { minVariantPrice { amount currencyCode } } featuredMedia { ... on MediaImage { image { url } } } variants(first: 100) { nodes { id price inventoryQuantity inventoryPolicy } } } } }';
async function organicPreview(graphql,fetchImpl=global.fetch){
  const data=await graphql(QUERY);
  const skipped=[];
  for(const p of data.products.nodes){
    try {
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
      return {ok:true,drafts:['facebook','instagram'].map(channel=>buildOrganicDraft(product,channel)),skipped,published:false};
    }catch(error){skipped.push({productId:p.id,reason:error.message});}
  }
  return {ok:false,error:'No eligible product in the first 30 active products',skipped,published:false};
}
function registerOrganicCatalog(app,apiKey,graphql){
  app.get('/api/marketing/organic/preview',apiKey,async(_req,res)=>{
    try{res.json(await organicPreview(graphql));}catch(_){res.status(502).json({ok:false,error:'Product preview failed',published:false});}
  });
  if(process.env.META_PAGE_ACCESS_TOKEN){
    void organicPreview(graphql).then(result=>console.log('[organic-marketing-preview] '+JSON.stringify(result))).catch(()=>console.log('[organic-marketing-preview] product preview failed'));
  }
}
module.exports={organicPreview,registerOrganicCatalog};

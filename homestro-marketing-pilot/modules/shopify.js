import {fail} from './core.js';

export const PRODUCT_QUERY=`query PilotProduct($id:ID!, $mediaAfter:String, $variantsAfter:String) {
  product(id:$id) {
    id title description descriptionHtml status handle updatedAt onlineStoreUrl tags productType
    seo { title description }
    supplierId: metafield(namespace:"homestro",key:"aliexpress_product_id") { jsonValue }
    publishedFacebook: metafield(namespace:"homestro",key:"organic_facebook_post_id") { jsonValue }
    publishedInstagram: metafield(namespace:"homestro",key:"organic_instagram_post_id") { jsonValue }
    media(first:50, after:$mediaAfter) {
      nodes { mediaContentType status
        ... on Video { sources { url format mimeType width height } originalSource { url format mimeType width height } }
        ... on MediaImage { image { url altText } }
      } pageInfo { hasNextPage endCursor }
    }
    variants(first:50, after:$variantsAfter) {
      nodes { id title price availableForSale inventoryQuantity inventoryPolicy barcode }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
export const CATALOG_QUERY=`query PilotCatalog($after:String) {
  products(first:30,after:$after,query:"status:active") {
    nodes { id } pageInfo { hasNextPage endCursor }
  }
}`;
export function createShopifyClient({domain,token,version='2026-07',fetchImpl=fetch}) {
  if(!/^[a-z0-9-]+\.myshopify\.com$/.test(domain||'')) fail('INVALID_SHOPIFY_DOMAIN');
  return async (query,variables={})=>{
    const r=await fetchImpl(`https://${domain}/admin/api/${version}/graphql.json`,{
      method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},
      body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)});
    const b=await r.json();
    if(!r.ok || b.errors || !b.data) fail('SHOPIFY_READ_FAILED');
    return b.data;
  };
}
export async function fetchProduct(graphql,id) {
  let mediaAfter=null,variantsAfter=null, result, media=[],variants=[], first=true;
  let mediaDone=false,variantsDone=false;
  for(let page=0;page<100;page++) {
    const {product:p}=await graphql(PRODUCT_QUERY,{id,mediaAfter,variantsAfter});
    if(!p) fail('PRODUCT_NOT_FOUND');
    if(first){result={...p};first=false;}
    if(!mediaDone){media.push(...p.media.nodes);mediaDone=!p.media.pageInfo.hasNextPage;mediaAfter=p.media.pageInfo.endCursor;}
    if(!variantsDone){variants.push(...p.variants.nodes);variantsDone=!p.variants.pageInfo.hasNextPage;variantsAfter=p.variants.pageInfo.endCursor;}
    if(mediaDone && variantsDone) return {...result,media,variants};
  }
  fail('PRODUCT_PAGINATION_LIMIT');
}
export async function syncCatalog(graphql,onProduct) {
  let after=null,processed=0,errors=0,pending=0;
  for(let page=0;page<1000;page++) {
    const {products}=await graphql(CATALOG_QUERY,{after});
    for(const p of products.nodes) {
      try {const r=await onProduct(p.id);processed+=r.processed||0;if(r.status==='pending_marketing')pending++;if(!r.processed)errors++;} catch {errors++;}
    }
    if(!products.pageInfo.hasNextPage) return {processed,errors,pending};
    after=products.pageInfo.endCursor;
  }
  fail('CATALOG_PAGINATION_LIMIT');
}

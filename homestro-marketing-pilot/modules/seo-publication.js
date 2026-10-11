import {fail} from './core.js';

export const PRODUCT_SEO_UPDATE = `mutation PilotProductSeoUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id seo { title description } }
    userErrors { field message }
  }
}`;

const SEO_FIELDS = [
  {key:'title_tag', source:'seoTitle', max:70},
  {key:'description_tag', source:'seoDescription', max:160}
];

function clean(value) {
  return String(value||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ')
    .replace(/\s+/g,' ').trim();
}

export function productSeoInput(raw, copy) {
  if(!raw?.id || raw.status!=='ACTIVE' || !copy) return null;
  const metafields=[];
  for(const field of SEO_FIELDS) {
    const value=clean(copy[field.source]);
    if(!value || value.length>field.max) return null;
    const current=raw[field.key==='title_tag'?'seoTitleTag':'seoDescriptionTag'];
    const effective=clean(current?.value ?? raw.seo?.[field.key==='title_tag'?'title':'description']);
    if(effective===value) continue;
    metafields.push(current?.id
      ? {id:current.id,value}
      : {namespace:'global',key:field.key,value,type:'single_line_text_field'});
  }
  return metafields.length ? {id:raw.id,metafields} : null;
}

export async function publishProductSeo(graphql, raw, copy) {
  const input=productSeoInput(raw,copy);
  if(!input) return {updated:false};
  const result=await graphql(PRODUCT_SEO_UPDATE,{input});
  const errors=result?.productUpdate?.userErrors||[];
  if(errors.length) fail('SHOPIFY_SEO_WRITE_FAILED');
  if(!result?.productUpdate?.product?.id) fail('SHOPIFY_SEO_WRITE_FAILED');
  return {updated:true,fields:input.metafields.map(x=>x.key||(x.id===raw.seoTitleTag?.id?'title_tag':'description_tag'))};
}

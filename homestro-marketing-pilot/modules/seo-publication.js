import {fail,log,codeOf} from './core.js';

export const PRODUCT_SEO_UPDATE = `mutation PilotProductSeoUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id seo { title description } }
    userErrors { field message }
  }
}`;
export const FILE_ALT_UPDATE = `mutation PilotFileAltUpdate($files:[FileUpdateInput!]!) {
  fileUpdate(files:$files) { files { id alt fileStatus } userErrors { field message code } }
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
  if(!raw?.id || !['ACTIVE','DRAFT','ARCHIVED'].includes(raw.status) ||
    (raw.tags||[]).some(t=>/^homestro-(?:ai|qa)-rejected$/i.test(String(t).trim())) || !copy) return null;
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
  return {updated:true,fields:input.metafields.map(x=>x.key || (x.id===raw.seoTitleTag?.id?'title_tag':'description_tag'))};
}

const cleanAlt=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim();

export function productImageAltInputs(raw,copy) {
  if(!raw?.id||!['ACTIVE','DRAFT','ARCHIVED'].includes(raw.status)||
    (raw.tags||[]).some(t=>/^homestro-(?:ai|qa)-rejected$/i.test(String(t).trim()))||!copy)return [];
  const title=cleanAlt(copy.title||copy.searchTitle||copy.seoTitle);
  if(!title)return [];
  let imageNo=0;
  return (raw.media||[]).flatMap(media=>{
    if(media?.mediaContentType!=='IMAGE'||media.status!=='READY'||!media.id)return [];
    imageNo++;
    if(cleanAlt(media.image?.altText ?? media.alt))return [];
    return [{id:media.id,alt:`Produktfoto: ${title} – Ansicht ${imageNo}`.slice(0,500)}];
  });
}

export async function publishProductImageAlts(graphql,raw,copy) {
  const files=productImageAltInputs(raw,copy);
  if(!files.length)return {updated:0};
  let updated=0;
  // Shopify accepts a list; keep writes small and isolate a bad file from the rest.
  for(let i=0;i<files.length;i+=10) {
    const result=await graphql(FILE_ALT_UPDATE,{files:files.slice(i,i+10)});
    const payload=result?.fileUpdate;
    if(payload?.userErrors?.length||!Array.isArray(payload?.files)||payload.files.length!==files.slice(i,i+10).length)
      fail('SHOPIFY_ALT_WRITE_FAILED');
    updated+=payload.files.length;
  }
  return {updated};
}

export async function syncSeoCatalogBatch({pool,graphql,fetchProduct,batchSize=25}) {
  const size=Math.max(1,Math.min(100,Math.floor(Number(batchSize)||25)));
  const docs=(await pool.query(`SELECT id,document FROM marketing_products
    WHERE document->'localized' IS NOT NULL
      AND COALESCE(document->>'rejected','false')<>'true'
      AND document->>'status' IN ('ACTIVE','DRAFT','ARCHIVED')
    ORDER BY id`)).rows;
  if(!docs.length)return {status:'empty',scanned:0,seoUpdated:0,altUpdated:0,errors:0,total:0};
  const state=(await pool.query("SELECT value FROM marketing_pilot_state WHERE key='seo_catalog_cursor'")).rows[0];
  const start=Math.max(0,docs.findIndex(x=>x.id>String(state?.value||'')));
  const batch=Array.from({length:Math.min(size,docs.length)},(_,i)=>docs[(start+i)%docs.length]);
  let seoUpdated=0,altUpdated=0,errors=0,scanned=0,last=String(state?.value||'');
  for(const row of batch) {
    last=row.id;
    try {
      const raw=await fetchProduct(graphql,row.id),copy=row.document.localized;
      if(!raw||raw.id!==row.id||!copy)fail('SEO_SOURCE_CHANGED');
      const seo=await publishProductSeo(graphql,raw,copy);
      const alt=await publishProductImageAlts(graphql,raw,copy);
      if(seo.updated)seoUpdated++;
      altUpdated+=alt.updated;
    } catch(e) {errors++;log('SEO_CATALOG_PRODUCT_FAILED',{productId:row.id,reason:codeOf(e)});}
    scanned++;
    await pool.query(`INSERT INTO marketing_pilot_state(key,value) VALUES('seo_catalog_cursor',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[last]);
  }
  return {status:'processed',scanned,seoUpdated,altUpdated,errors,total:docs.length,batchSize:size};
}

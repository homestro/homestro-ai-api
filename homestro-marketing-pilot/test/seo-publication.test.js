import test from 'node:test';
import assert from 'node:assert/strict';
import {productSeoInput,publishProductSeo,productImageAltInputs,publishProductImageAlts,syncSeoCatalogBatch} from '../modules/seo-publication.js';

const product=(overrides={})=>({
  id:'gid://shopify/Product/123',status:'ACTIVE',
  seo:{title:'Old title',description:'Old description'},
  seoTitleTag:null,seoDescriptionTag:null,
  ...overrides
});
const copy={seoTitle:'German SEO title | Homestro',seoDescription:'A fact-based German description for the product page.'};

test('creates only the two Shopify SEO tags from reviewed German copy',()=>{
  const input=productSeoInput(product(),copy);
  assert.deepEqual(input,{
    id:'gid://shopify/Product/123',
    metafields:[
      {namespace:'global',key:'title_tag',value:copy.seoTitle,type:'single_line_text_field'},
      {namespace:'global',key:'description_tag',value:copy.seoDescription,type:'single_line_text_field'}
    ]
  });
});

test('updates existing SEO metafields by ID instead of creating duplicates',()=>{
  const input=productSeoInput(product({
    seoTitleTag:{id:'gid://shopify/Metafield/1',value:'Old title'},
    seoDescriptionTag:{id:'gid://shopify/Metafield/2',value:'Old description'}
  }),copy);
  assert.deepEqual(input.metafields,[
    {id:'gid://shopify/Metafield/1',value:copy.seoTitle},
    {id:'gid://shopify/Metafield/2',value:copy.seoDescription}
  ]);
});

test('does nothing when Shopify already has the generated SEO values',async()=>{
  let called=false;
  const raw=product({
    seoTitleTag:{id:'gid://shopify/Metafield/1',value:copy.seoTitle},
    seoDescriptionTag:{id:'gid://shopify/Metafield/2',value:copy.seoDescription}
  });
  const result=await publishProductSeo(async()=>{called=true;},raw,copy);
  assert.equal(called,false);
  assert.deepEqual(result,{updated:false});
});

test('publishes missing SEO values and reports only updated field names',async()=>{
  let captured;
  const result=await publishProductSeo(async(_query,variables)=>{
    captured=variables;
    return {productUpdate:{product:{id:'gid://shopify/Product/123'},userErrors:[]}};
  },product(),copy);
  assert.equal(captured.input.id,'gid://shopify/Product/123');
  assert.deepEqual(result,{updated:true,fields:['title_tag','description_tag']});
});

test('prepares metadata for hidden products without changing their Shopify publication status',()=>{
  assert.ok(productSeoInput(product({status:'DRAFT'}),copy));
  assert.ok(productSeoInput(product({status:'ARCHIVED'}),copy));
  assert.equal(productSeoInput(product(),{...copy,seoTitle:'x'.repeat(71)}),null);
  assert.equal(productSeoInput(product(),{...copy,seoDescription:''}),null);
  assert.equal(productSeoInput(product({tags:['homestro-ai-rejected']}),copy),null);
});

test('fails safely when Shopify rejects an SEO update',async()=>{
  await assert.rejects(
    publishProductSeo(async()=>({productUpdate:{product:null,userErrors:[{message:'Rejected'}]}}),product(),copy),
    error=>error.code==='SHOPIFY_SEO_WRITE_FAILED'
  );
});

test('fills only missing alt text on ready Shopify images with factual German product naming',()=>{
  const raw=product({media:[
    {id:'gid://shopify/MediaImage/1',mediaContentType:'IMAGE',status:'READY',image:{altText:null}},
    {id:'gid://shopify/MediaImage/2',mediaContentType:'IMAGE',status:'READY',image:{altText:'Manuell gepflegter ALT'}},
    {id:'gid://shopify/MediaImage/3',mediaContentType:'IMAGE',status:'PROCESSING',image:{altText:null}},
    {id:'gid://shopify/Video/4',mediaContentType:'VIDEO',status:'READY'}
  ]});
  assert.deepEqual(productImageAltInputs(raw,{title:'Organizer für Zuhause'}),[
    {id:'gid://shopify/MediaImage/1',alt:'Produktfoto: Organizer für Zuhause – Ansicht 1'}
  ]);
});

test('writes image ALT only when absent and validates Shopify confirmation',async()=>{
  let captured;
  const result=await publishProductImageAlts(async(_query,variables)=>{
    captured=variables.files;
    return {fileUpdate:{files:variables.files.map(x=>({id:x.id,alt:x.alt,fileStatus:'READY'})),userErrors:[]}};
  },product({media:[{id:'gid://shopify/MediaImage/4',mediaContentType:'IMAGE',status:'READY',image:{altText:''}}]}),{title:'Küchenhelfer'});
  assert.equal(result.updated,1);
  assert.equal(captured[0].alt,'Produktfoto: Küchenhelfer – Ansicht 1');
  await assert.rejects(publishProductImageAlts(async()=>({fileUpdate:{files:[],userErrors:[{message:'rejected'}]}}),
    product({media:[{id:'gid://shopify/MediaImage/5',mediaContentType:'IMAGE',status:'READY',image:{altText:null}}]}),{title:'Küchenhelfer'}),
    error=>error.code==='SHOPIFY_ALT_WRITE_FAILED');
});

test('rotates a persistent cursor through the whole eligible Shopify catalog in bounded batches',async()=>{
  const rows=['1','2','3'].map(id=>({id:`gid://shopify/Product/${id}`,document:{localized:copy,status:'DRAFT',rejected:false}}));
  let cursor='';const stateWrites=[];const seen=[];
  const pool={query:async(sql,params=[])=>{
    if(sql.includes('CREATE TABLE'))return {rows:[]};
    if(sql.includes('SELECT id,document FROM marketing_products'))return {rows};
    if(sql.includes("SELECT value FROM marketing_pilot_state"))return {rows:cursor?[{value:cursor}]:[]};
    if(sql.includes('INSERT INTO marketing_pilot_state')){cursor=params[0];stateWrites.push(cursor);return {rows:[]};}
    throw new Error('Unexpected SQL '+sql);
  }};
  const fetchProduct=async(_graphql,id)=>({id,status:'DRAFT',tags:[],media:[],seo:{title:'',description:''},seoTitleTag:null,seoDescriptionTag:null});
  const graphql=async(query,variables)=>{
    if(query.includes('PilotProductSeoUpdate')) {seen.push(variables.input.id);return {productUpdate:{product:{id:variables.input.id},userErrors:[]}};}
    throw new Error('Unexpected GraphQL');
  };
  const first=await syncSeoCatalogBatch({pool,graphql,fetchProduct,batchSize:2});
  const second=await syncSeoCatalogBatch({pool,graphql,fetchProduct,batchSize:2});
  assert.equal(first.scanned,2);assert.equal(second.scanned,2);
  assert.deepEqual(seen,[rows[0].id,rows[1].id,rows[2].id,rows[0].id]);
  assert.equal(stateWrites.at(-1),rows[0].id);
});

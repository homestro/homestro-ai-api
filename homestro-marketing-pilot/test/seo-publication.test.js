import test from 'node:test';
import assert from 'node:assert/strict';
import {productSeoInput,publishProductSeo} from '../modules/seo-publication.js';

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

test('leaves draft, inactive, and invalid SEO records unchanged',()=>{
  assert.equal(productSeoInput(product({status:'DRAFT'}),copy),null);
  assert.equal(productSeoInput(product(),{...copy,seoTitle:'x'.repeat(71)}),null);
  assert.equal(productSeoInput(product(),{...copy,seoDescription:''}),null);
});

test('fails safely when Shopify rejects an SEO update',async()=>{
  await assert.rejects(
    publishProductSeo(async()=>({productUpdate:{product:null,userErrors:[{message:'Rejected'}]}}),product(),copy),
    error=>error.code==='SHOPIFY_SEO_WRITE_FAILED'
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSeoContentPlan} from '../modules/content-plan.js';

test('creates a German content navigator plan using only product facts',()=>{
  const result=buildSeoContentPlan({
    status:'ready',reasons:[],
    product:{id:'gid://shopify/Product/12',title:'Organizer',productType:'Küche',url:'https://homestro.de/products/box',
      localized:{searchTitle:'Kühlschrank Organizer',benefits:[{text:'Vier Boxen im Set'},{text:'Transparent'}]}}
  });
  assert.equal(result.primaryKeywordHypothesis,'Kühlschrank Organizer');
  assert.equal(result.topics.length,3);
  assert.equal(result.outline[1].facts[0],'Vier Boxen im Set');
  assert.equal(result.searchMetrics.searchVolume,null);
  assert.equal(result.publication.createsPage,false);
});

test('does not invent facts, search volume, or a destination page',()=>{
  const result=buildSeoContentPlan({product:{title:'Lampe',url:'https://elsewhere.example/product'}});
  assert.deepEqual(result.outline[1].facts,[]);
  assert.equal(result.outline[1].source,'needs_review');
  assert.equal(result.product.url,null);
  assert.equal(result.searchMetrics.difficulty,null);
});

test('requires at least a product title or category',()=>{
  assert.throws(()=>buildSeoContentPlan({product:{}}),e=>e.code==='SEO_PLAN_SOURCE_REQUIRED');
});

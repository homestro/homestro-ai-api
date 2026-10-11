import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {marketingGraphqlAllowed}=require('../runtime.cjs');

test('allows Shopify reads and only the two required pilot write operations',()=>{
  assert.equal(marketingGraphqlAllowed('query PilotProduct($id:ID!){ product(id:$id){id} }'),true);
  assert.equal(marketingGraphqlAllowed('query{shop{name}}'),true);
  assert.equal(marketingGraphqlAllowed('mutation PilotProductSeoUpdate($input:ProductInput!){productUpdate(input:$input){product{id}}}'),true);
  assert.equal(marketingGraphqlAllowed('mutation PilotArticleDraft($article:ArticleCreateInput!){articleCreate(article:$article){article{id}}}'),true);
});

test('rejects any unapproved Shopify mutation and comment-prefixed operation',()=>{
  assert.equal(marketingGraphqlAllowed('mutation ChangePrice($input:ProductInput!){productUpdate(input:$input){product{id}}}'),false);
  assert.equal(marketingGraphqlAllowed('mutation PilotArticleDraft{articleCreate(article:{isPublished:true}){article{id}}}'),false);
  assert.equal(marketingGraphqlAllowed('# comment\nmutation PilotArticleDraft($article:ArticleCreateInput!){articleCreate(article:$article){article{id}}}'),false);
  assert.equal(marketingGraphqlAllowed('not graphql'),false);
});

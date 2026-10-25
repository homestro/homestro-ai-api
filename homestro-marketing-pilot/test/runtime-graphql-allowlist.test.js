import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {GUIDE_CREATE,GUIDE_UPDATE} from '../modules/seo-guides.js';
import {FILE_ALT_UPDATE} from '../modules/seo-publication.js';

const require=createRequire(import.meta.url);
const {marketingGraphqlAllowed}=require('../runtime.cjs');

test('allows Shopify reads and only the required pilot write operations',()=>{
  assert.equal(marketingGraphqlAllowed('query PilotProduct($id:ID!){ product(id:$id){id} }'),true);
  assert.equal(marketingGraphqlAllowed('query{shop{name}}'),true);
  assert.equal(marketingGraphqlAllowed('mutation PilotProductSeoUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id seo { title description } } userErrors { field message } } }'),true);
  assert.equal(marketingGraphqlAllowed(FILE_ALT_UPDATE),true);
  assert.equal(marketingGraphqlAllowed('mutation PilotArticleDraft($article: ArticleCreateInput!) { articleCreate(article: $article) { article { id title handle isPublished } userErrors { field message } } }'),true);
  assert.equal(marketingGraphqlAllowed(GUIDE_CREATE),true);
  assert.equal(marketingGraphqlAllowed(GUIDE_UPDATE),true);
});

test('rejects any unapproved Shopify mutation and comment-prefixed operation',()=>{
  assert.equal(marketingGraphqlAllowed('mutation ChangePrice($input:ProductInput!){productUpdate(input:$input){product{id}}}'),false);
  assert.equal(marketingGraphqlAllowed('mutation PilotProductSeoUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id title } userErrors { field message } } }'),false);
  assert.equal(marketingGraphqlAllowed('mutation PilotFileAltUpdate($files:[FileUpdateInput!]!) { fileUpdate(files:$files) { files { id url } } }'),false);
  assert.equal(marketingGraphqlAllowed('# comment\nmutation PilotArticleDraft($article:ArticleCreateInput!){articleCreate(article:$article){article{id}}}'),false);
  assert.equal(marketingGraphqlAllowed('not graphql'),false);
});


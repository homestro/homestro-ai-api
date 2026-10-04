import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareExistingInputs} from '../modules/bridge.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {registerMarketingPilot}=require('../runtime.cjs');
test('reuse existing processed German copy without a new AI request',()=>{
  const p={title:'Küchen-Organizer',descriptionHtml:'<ul><li>Vier transparente Boxen</li><li>Für deinen Kühlschrank</li><li>Einfach zu verstauen</li></ul>',tags:['homestro-ai-processed'],supplierId:{jsonValue:'123'}};
  const r=prepareExistingInputs(p);assert.ok(r.germanCopy);assert.equal(r.facts.length,3);assert.equal(r.rightsVerified,false);assert.equal(r.supplierReference,'123');assert.equal(r.landedCost,null);
});
test('QA-pending copy is held instead of assumed correct',()=>{
  const r=prepareExistingInputs({title:'A',tags:['homestro-ai-processed','homestro-ai-qa-pending']});assert.equal(r.contentReviewed,false);
});
test('runtime without database does not crash or query Shopify',async()=>{
  const routes=[];const app={get:(...a)=>routes.push(a)};
  const r=registerMarketingPilot(app,{apiKey:()=>{},env:{},graphql:()=>assert.fail('No GraphQL call')});
  assert.equal(await r.ready,null);assert.deepEqual(await r.processProduct('gid://shopify/Product/1'),{processed:0,status:'marketing_disabled'});
  assert.equal(routes[0][0],'/api/marketing/v2/runtime');
});

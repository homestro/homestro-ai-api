import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareExistingInputs} from '../modules/bridge.js';
import {snapshot,Ingestion} from '../modules/ingestion.js';

const raw={id:'gid://shopify/Product/1',title:'Küchen-Organizer',description:'Vier transparente Boxen für deinen Kühlschrank.',descriptionHtml:'<ul><li>Vier transparente Boxen</li><li>Für deinen Kühlschrank</li><li>Einfach zu verstauen</li></ul>',status:'ACTIVE',onlineStoreUrl:'https://homestro.de/products/organizer',variants:[{price:'39',inventoryQuantity:1}],media:[],tags:['homestro-ai-processed']};
test('rejected tag overrides processed and complete tags in source review',()=>{
 for(const tag of ['homestro-ai-rejected','homestro-qa-rejected']){
  const r=prepareExistingInputs({...raw,tags:[...raw.tags,'homestro-ai-complete',tag]});
  assert.equal(r.contentReviewed,false);assert.equal(r.germanCopy,null);
 }
 assert.equal(prepareExistingInputs(raw).contentReviewed,true);
});
test('fresh rejection changes revision even with saved reviewed inputs',()=>{
 const inputs={...prepareExistingInputs(raw),landedCost:5};
 const previous=snapshot(raw,inputs);
 const current=snapshot({...raw,tags:[...raw.tags,'homestro-ai-rejected']},{...inputs,rejected:false});
 assert.equal(current.rejected,true);assert.notEqual(current.revision,previous.revision);
});
test('saved content approval cannot make a rejected product ready',async()=>{
 const saved=[];
 const store={product:async()=>null,saveProduct:async(...args)=>saved.push(args),queue:async()=>false};
 const renderer={render:async()=>({format:'image',imageURLs:['https://cdn.shopify.com/a.jpg']})};
 const ingestion=new Ingestion({store,renderer});
 const result=await ingestion.process({...raw,tags:[...raw.tags,'homestro-ai-rejected']},prepareExistingInputs(raw));
 assert.equal(result.status,'pending_marketing');
 assert.ok(result.reasons.includes('PRODUCT_REJECTED'));
 assert.equal(saved.some(([,status])=>status==='ready'),false);
});

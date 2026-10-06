import test from 'node:test';
import assert from 'node:assert/strict';
import {editorialDocuments,editorialPayload,validEditorial} from '../modules/editorial.js';
import {Store} from '../modules/store.js';
const cfg={publicOrigin:'https://example.com'};
test('editorial accepts only original manifest and never substitutes for product reviews',()=>{
 process.env.PILOT_BRAND_EDITORIAL_ENABLED='true';
 for(const p of editorialDocuments()) {
  const stored={status:'ready',document:p},job={product_id:p.id,payload:editorialPayload(p,cfg)};
  assert.equal(validEditorial(job,stored,cfg),true);
  assert.equal(validEditorial({...job,payload:{...job.payload,caption:'Changed claim'}},stored,cfg),false);
  assert.equal(validEditorial({...job,product_id:'gid://shopify/Product/1'},stored,cfg),false);
  assert.equal(validEditorial(job,{...stored,document:{...p,text:'Changed source'}},cfg),false);
  assert.equal(validEditorial(job,{...stored,status:'pending_marketing'},cfg),false);
 }
 process.env.PILOT_BRAND_EDITORIAL_ENABLED='false';
 const p=editorialDocuments()[0];
 assert.equal(validEditorial({product_id:p.id,payload:editorialPayload(p,cfg)},{status:'ready',document:p},cfg),false);
});
test('editorial documents never enter the commercial product feed',async()=>{
 let sql;
 const s=new Store({query:async q=>{sql=q;return {rows:[]};}});
 await s.feedRows();assert.match(sql,/COALESCE\(document->>'kind','product'\)<>'brand_editorial'/);
 assert.equal(editorialDocuments().length,14);
 assert.equal(new Set(editorialDocuments().map(p=>p.revision)).size,14);
});

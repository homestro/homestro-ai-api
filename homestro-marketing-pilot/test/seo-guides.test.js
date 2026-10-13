import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGuide,guideProducts,GUIDE_TOPICS,syncSeoGuides} from '../modules/seo-guides.js';
import {Store} from '../modules/store.js';

const topic=GUIDE_TOPICS[0];
const products=()=>[1,2,3].map(i=>({id:'gid://shopify/Product/'+i,revision:'rev-'+i,status:'ACTIVE',contentReviewed:true,
  url:'https://homestro.de/products/kuechenhelfer-'+i,productType:'Küchenhelfer',variants:[{available:true,price:39}],
  localized:{title:'Küchenhelfer '+i,benefits:[{text:'Beschriebenes Merkmal '+i}]},
  media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/photo'+i+'.jpg'}}]}));
const cfg={seoAutopublishEnabled:true,seoMaxDailyPages:1};
test('SEO sources do not depend on a social render being ready',async()=>{
  let query;
  const store=new Store({query:async sql=>{query=sql;return {rows:products().map(document=>({document}))};}});
  const rows=await store.seoRows();assert.equal(rows.length,3);
  assert.match(query,/contentReviewed/);assert.match(query,/localized/);assert.doesNotMatch(query,/status='ready'/);
});
function fixture({saved=null,remote=null,used=0,scopes=['write_content'],timeout=false,sourceChanged=false}={}) {
  const queries=[],writes=[];let record=saved,existing=remote,uses=used;
  const client={release(){},async query(sql,args=[]) {
    queries.push({sql,args});
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.includes('SELECT * FROM marketing_seo_pages'))return {rows:record&&args[0]===record.handle?[record]:[]};
    if(sql.includes('SELECT count(*)'))return {rows:[{count:uses}]};
    if(sql.includes('INSERT INTO marketing_seo_pages')){
      uses++;record={...record,handle:args[0],content_hash:args[1],status:'creating'};
    }
    if(sql.includes("SET status='published'"))record={...record,shopify_id:args[1],body_hash:args[3],status:'published'};
    if(sql.includes("SET status='recovery_required'"))record={...record,status:'recovery_required'};
    if(sql.includes("SET status='failed'"))record={...record,status:'failed'};
    if(sql.includes("SET status='paused'"))record={...record,status:'paused'};
    return {rows:[],rowCount:1};
  }};
  const graphql=async(q,args)=>{
    if(q.includes('PilotAccessScopes'))return {currentAppInstallation:{accessScopes:scopes.map(handle=>({handle}))}};
    if(q.includes('PilotGuideLookup'))return {pages:{nodes:existing&&args.query==='handle:'+existing.handle?[existing]:[],pageInfo:{hasNextPage:false}}};
    writes.push({q,args});
    existing={...existing,id:existing?.id||'gid://shopify/Page/123',...args.page};
    if(timeout)throw new Error('timeout after acceptance');
    return {[q.includes('PilotGuideUpdate')?'pageUpdate':'pageCreate']:{page:existing,userErrors:[]}};
  };
  return {pool:{connect:async()=>client},graphql,cfg,queries,writes,
    freshSnapshot:async id=>({...products().find(p=>p.id===id),revision:sourceChanged?'changed':products().find(p=>p.id===id).revision}),
    get record(){return record;},set used(value){uses=value;},set remote(value){existing=value;}};
}
test('guide has factual product links and no internal UTMs, fake discounts, or ratings',()=>{
  const guide=buildGuide(topic,products());
  assert.equal(guide.products.length,3);assert.ok(guide.body.length>1000);
  assert.match(guide.body,/Beschriebenes Merkmal 1/);assert.match(guide.body,/\/products\/kuechenhelfer-1/);
  assert.equal(guide.body.includes('utm_'),false);assert.equal(guide.body.includes('39,00'),false);
  assert.equal(guide.body.includes('aggregateRating'),false);assert.equal(guide.isPublished,true);
});
test('unreviewed, excluded, sold-out, rejected or offsite products cannot enter a guide',()=>{
  const p=products()[0];
  for(const patch of [{contentReviewed:false},{rejected:true},{status:'DRAFT'},
    {variants:[{available:false,price:39}]},{url:'https://evil.example/products/a'}])
    assert.equal(guideProducts([{...p,...patch}],topic).length,0);
  assert.equal(guideProducts([p],topic,{excludedProductIds:[p.id]}).length,0);
  assert.throws(()=>buildGuide(topic,[p]),{code:'SEO_GUIDE_INSUFFICIENT_PRODUCTS'});
});
test('source HTML is escaped in the page rather than injected',()=>{
  const p=products();p[0].localized.title='Küchenhelfer " onclick="evil';p[0].localized.benefits[0].text='<script>evil()</script> <b>Fakt</b>';
  const guide=buildGuide(topic,p);
  assert.equal(guide.body.includes('<script>'),false);assert.match(guide.body,/&quot; onclick=&quot;evil/);
});
test('publishes one validated page and retains its stable identifier on the next run',async()=>{
  const f=fixture();const first=await syncSeoGuides({...f,products:products()});
  assert.equal(first.published,1);assert.equal(f.writes.length,1);assert.equal(f.record.status,'published');
  await syncSeoGuides({...f,products:products()});assert.equal(f.writes.length,1);
  assert.ok(f.queries.find(q=>q.sql.includes('INSERT INTO marketing_seo_pages')));
  assert.ok(f.queries.find(q=>q.sql.includes('INSERT INTO marketing_seo_attempts')));
});
test('the daily write cap and missing Shopify permission prevent mutations',async()=>{
  for(const options of [{used:1},{scopes:['read_products']}]){
    const f=fixture(options);await syncSeoGuides({...f,products:products()});assert.equal(f.writes.length,0);
  }
});
test('changed product is rejected immediately before any page creation',async()=>{
  const f=fixture({sourceChanged:true});
  await assert.rejects(syncSeoGuides({...f,products:products()}),{code:'SEO_SOURCE_CHANGED'});
  assert.equal(f.writes.length,0);assert.equal(f.record,null);
});
test('an accepted create with a lost response is reconciled without another write',async()=>{
  const f=fixture({timeout:true});await syncSeoGuides({...f,products:products()});
  assert.equal(f.record.status,'recovery_required');assert.equal(f.writes.length,1);
  await syncSeoGuides({...f,products:products()});
  assert.equal(f.writes.length,1);assert.equal(f.record.status,'published');
});
test('an uncertain create with no remote page is never automatically repeated',async()=>{
  const f=fixture({timeout:true});await syncSeoGuides({...f,products:products()});f.remote=null;f.used=0;
  await syncSeoGuides({...f,products:products()});assert.equal(f.writes.length,1);
});
test('existing unmanaged and manually edited pages are never overwritten',async()=>{
  const guide=buildGuide(topic,products()),remote={...guide,id:'gid://shopify/Page/123'};
  const unmanaged=fixture({remote});await syncSeoGuides({...unmanaged,products:products()});assert.equal(unmanaged.writes.length,0);
  const edited=fixture({remote:{...remote,body:remote.body+'manual edit'},saved:{handle:guide.handle,status:'published',shopify_id:remote.id,body_hash:guide.fingerprint}});
  await syncSeoGuides({...edited,products:products()});assert.equal(edited.writes.length,0);
});
test('merchant-unpublished managed pages are not silently republished',async()=>{
  const guide=buildGuide(topic,products()),remote={...guide,id:'gid://shopify/Page/123',isPublished:false};
  const f=fixture({remote,saved:{handle:guide.handle,status:'published',shopify_id:remote.id,body_hash:guide.fingerprint}});
  await syncSeoGuides({...f,products:products()});assert.equal(f.writes.length,0);
});
test('a changed guide updates the owned page rather than creating a duplicate',async()=>{
  const p=products(),old=buildGuide(topic,p),remote={...old,id:'gid://shopify/Page/123'};
  const f=fixture({remote,saved:{handle:old.handle,status:'published',shopify_id:remote.id,body_hash:old.fingerprint}});
  p[0].localized.benefits[0].text='Aktualisiertes Merkmal';await syncSeoGuides({...f,products:p});
  assert.equal(f.writes.length,1);assert.match(f.writes[0].q,/PilotGuideUpdate/);
  assert.equal(f.writes[0].args.id,remote.id);
});
test('a managed page is paused when its product group no longer has usable sources',async()=>{
  const guide=buildGuide(topic,products()),remote={...guide,id:'gid://shopify/Page/123'};
  const f=fixture({remote,saved:{handle:guide.handle,status:'published',shopify_id:remote.id,body_hash:guide.fingerprint}});
  await syncSeoGuides({...f,products:[]});assert.equal(f.record.status,'paused');
  assert.deepEqual(f.writes[0].args.page,{isPublished:false});
});

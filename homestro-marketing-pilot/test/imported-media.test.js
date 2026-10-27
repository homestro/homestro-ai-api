import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ImportedMediaCoordinator,importMetadata,importedPost,validateImportedReview,normalizeImported} from '../modules/imported-media.js';
import {approvePayload} from '../modules/social.js';
import {approveReviewed} from '../modules/autonomy.js';

const sum=b=>createHash('sha256').update(b).digest('hex');
const product={id:'gid://shopify/Product/1',revision:'rev-1',status:'ACTIVE',contentReviewed:true,
 url:'https://homestro.de/products/box',variants:[{available:true,price:39.9}],
 localized:{title:'Aufbewahrungsbox',hook:'Details der Aufbewahrungsbox',benefits:[{text:'Beschriebenes Merkmal'}]},categoryKey:'home'};
const job='e9ef0df6-9d35-4c40-ac10-051bd6f50667';
const metadata=b=>({provider:'higgsfield',job_id:job,kind:'image',sha256:sum(b),product_url:product.url});
function db(){
 const imports=new Map(),posts=new Map(),sql=[];
 const query=async(q,args=[])=>{
  sql.push(q);
  if(q.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(q.includes('SELECT * FROM marketing_imported_media'))return {rows:imports.has(args[0])?[imports.get(args[0])]:[]};
  if(q.includes('SELECT document,status FROM marketing_products'))return {rows:[{document:product,status:'ready'}]};
  if(q.includes('INSERT INTO marketing_imported_media'))imports.set(args[0],{job_id:args[0],checksum:args[1],product_id:args[2],product_revision:args[3],metadata:args[4],state:'receiving'});
  if(q.includes('INSERT INTO marketing_posts')||q.includes('INSERT INTO marketing_social_posts')){
   const key=[args[1],args[2],args[3]].join('|');if(!posts.has(key))posts.set(key,{id:args[0],status:'draft_queued',payload:args[4],channel:args[2]});
  }
  if(q.includes('SELECT id,status FROM marketing_'))return {rows:[posts.get(args.join('|'))].filter(Boolean)};
  if(q.includes("UPDATE marketing_imported_media SET state='queued'"))Object.assign(imports.get(args[0]),{state:'queued',asset:args[1],receipt:args[2]});
  if(q.includes('SELECT receipt,state FROM marketing_imported_media'))return {rows:[imports.get(args[0])].filter(Boolean)};
  if(q.includes('SELECT p.id,p.status,p.remote,p.payload,plan.scheduled_for FROM marketing_'))return {rows:[...posts.values()].filter(p=>p.id===args[0])};
  return {rows:[],rowCount:0};
 };
 return {imports,posts,sql,query,connect:async()=>({query,release(){}})};
}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'import-queue-'));
 execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=32x32','-frames:v','1','-threads','1',join(dir,'source.png')]);
 return {dir,bytes:await readFile(join(dir,'source.png'))};
}
test('raw import verifies exact SHA, completed provider identity and own product URL',()=>{
 const bytes=Buffer.from('data'),m=metadata(bytes),encode=x=>Buffer.from(JSON.stringify(x)).toString('base64');
 assert.equal(importMetadata(encode(m),bytes).job_id,job);
 for(const value of [{...m,sha256:'a'.repeat(64)},{...m,provider:'other'},{...m,product_url:'https://external.example/products/box'},null])
  assert.throws(()=>importMetadata(encode(value),bytes));
});
test('normalization preserves source and restores missing exact rendition without generation',async()=>{
 const {dir,bytes}=await fixture();try{
  const cfg={dataDir:dir,publicOrigin:'https://publisher.example'},m=metadata(bytes);
  const first=await normalizeImported(m,bytes,cfg),name=new URL(first.imageURLs[0]).pathname.split('/').pop();
  assert.equal(sum(await readFile(join(dir,'import-sources',m.sha256+'.bin'))),m.sha256);
  await rm(join(dir,'assets',name));
  assert.deepEqual(await normalizeImported(m,bytes,cfg),first);
  assert.equal(first.format,'image');assert.equal(first.fileSha256.length,64);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('actual queue receipt covers four native drafts, restart replay creates none and current source is revalidated',async()=>{
 const {dir,bytes}=await fixture();try{
  const pool=db(),cfg={dataDir:dir,publicOrigin:'https://publisher.example'};
  const social={providerCfg:{accounts:{tiktok:'t',pinterest:'p'},boardId:'board'}};
  // Fresh snapshot intentionally has no localized field; reviewed stored revision supplies it.
  const coordinator=new ImportedMediaCoordinator({pool,cfg,social,fresh:async()=>({...product,localized:undefined})});
  const receipt=await coordinator.receive(metadata(bytes),bytes);
  assert.equal(receipt.posts.length,4);assert.equal(pool.posts.size,4);assert.equal(receipt.publication_confirmed,false);
  for(const row of pool.posts.values()){assert.equal(row.status,'draft_queued');assert.equal(row.payload.requiresVisualReview,true);}
  const replay=await new ImportedMediaCoordinator({pool,cfg,social,fresh:async()=>{throw Error('Replay must not recreate');}}).receive(metadata(bytes),bytes);
  assert.equal(replay.idempotentReplay,true);assert.deepEqual(replay.posts,receipt.posts);assert.equal(pool.posts.size,4);
  assert.equal(pool.sql.some(q=>/supersed|approved_by/.test(q)),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('changed source never gets queued and checksum/product reassignment is refused',async()=>{
 const {dir,bytes}=await fixture();try{
  const pool=db(),cfg={dataDir:dir,publicOrigin:'https://publisher.example'};
  const coordinator=new ImportedMediaCoordinator({pool,cfg,fresh:async()=>({...product,revision:'changed'})});
  await assert.rejects(coordinator.receive(metadata(bytes),bytes),{code:'IMPORTED_PRODUCT_NOT_READY'});
  assert.equal(pool.posts.size,0);
  coordinator.fresh=async()=>product;await coordinator.receive(metadata(bytes),bytes);
  await assert.rejects(coordinator.receive({...metadata(bytes),product_url:'https://homestro.de/products/other'},bytes),{code:'MEDIA_IMPORT_IDENTITY_CONFLICT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('imported approval binds exact visual SHA and revision; TikTok keeps its independent consent gate',()=>{
 const meta=metadata(Buffer.from('x')),asset={format:'image',imageURLs:['https://publisher.example/marketing-assets/'+'a'.repeat(64)+'.jpg'],videoURL:null};
 const payload=importedPost(product,'tiktok',asset,{},meta,{}),j={status:'draft_queued',channel:'tiktok',revision:'payload-r',payload};
 assert.throws(()=>validateImportedReview(j,{reviewer:'owner'}),{code:'IMPORTED_VISUAL_REVIEW_REQUIRED'});
 const body={reviewer:'owner',expectedRevision:'payload-r',assetSha256:meta.sha256,content_preview_confirmed:true};
 assert.throws(()=>approvePayload(j,body,product.revision),{code:'TIKTOK_PREVIEW_CONSENT_REQUIRED'});
 body.tiktokSettings={content_preview_confirmed:true,express_consent_given:true,privacy_level:'PUBLIC_TO_EVERYONE',allow_comment:false};
 assert.equal(approvePayload(j,body,product.revision).payload.requiresVisualReview,false);
});
test('automatic native approvals explicitly exclude imported media',async()=>{
 let sql;await approveReviewed({pool:{query:async q=>{sql=q;return {rowCount:0};}}},{autonomyEnabled:true});
 assert.match(sql,/COALESCE\(s.payload->>'importedMedia','false'\)<>'true'/);
});
test('queue status distinguishes draft, approval and actual publication receipt',async()=>{
 const {dir,bytes}=await fixture();try{
  const pool=db(),cfg={dataDir:dir,publicOrigin:'https://publisher.example'};
  const coordinator=new ImportedMediaCoordinator({pool,cfg,fresh:async()=>product});
  await coordinator.receive(metadata(bytes),bytes);
  const draft=await coordinator.status(job);
  assert.equal(draft.requires_visual_review,true);assert.equal(draft.publication_confirmed,false);
  for(const row of pool.posts.values()){row.status='approved';row.payload.requiresVisualReview=false;}
  const approved=await coordinator.status(job);
  assert.equal(approved.requires_visual_review,false);assert.equal(approved.publication_confirmed,false);
  const row=[...pool.posts.values()].find(p=>p.channel==='instagram');
  row.status='published';row.remote={permalink:'https://www.instagram.com/p/Test123/'};
  assert.equal((await coordinator.status(job)).publication_confirmed,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('publication verifier holds unreviewed, corrupted source and changed normalized asset',async()=>{
 const {dir,bytes}=await fixture();try{
  const pool=db(),cfg={dataDir:dir,publicOrigin:'https://publisher.example'};
  const coordinator=new ImportedMediaCoordinator({pool,cfg,fresh:async()=>product});
  await coordinator.receive(metadata(bytes),bytes);
  const post=[...pool.posts.values()][0];
  await assert.rejects(coordinator.ensure(post,product),{code:'IMPORTED_VISUAL_REVIEW_REQUIRED'});
  post.payload.requiresVisualReview=false;await coordinator.ensure(post,product);
  const source=join(dir,'import-sources',metadata(bytes).sha256+'.bin');
  await writeFile(source,'corrupted');
  await assert.rejects(coordinator.ensure(post,product),{code:'IMPORTED_SOURCE_CORRUPTED'});
  await writeFile(source,bytes);
  const name=new URL(post.payload.imageURLs[0]).pathname.split('/').pop();
  await writeFile(join(dir,'assets',name),'changed rendition');
  await assert.rejects(coordinator.ensure(post,product),{code:'IMPORTED_NORMALIZED_MEDIA_CORRUPTED'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

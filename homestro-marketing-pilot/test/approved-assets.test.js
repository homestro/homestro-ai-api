import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureApprovedAssets} from '../modules/approved-assets.js';
import {carouselAssetKey} from '../modules/media.js';
const image='https://cdn.shopify.com/photo.jpg',origin='https://pilot.example';
test('lost approved photo is restored under the exact original URL without changing its payload',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'approved-assets-'));
 try {
  const key=carouselAssetKey(image),url=origin+'/marketing-assets/'+key+'.jpg';
  const source={revision:'r',media:[{mediaContentType:'IMAGE',status:'READY',image:{url:image}}]};
  const job={id:'approved',channel:'tiktok',payload:{format:'carousel',productRevision:'r',imageURLs:[url]}};
  const before=JSON.stringify(job.payload);let renders=0;
  const renderer={carousel:async images=>{renders++;assert.deepEqual(images,[image]);await mkdir(join(dataDir,'assets'),{recursive:true});await writeFile(join(dataDir,'assets',key+'.jpg'),'original-source-rendition');return {imageURLs:[url]};}};
  assert.equal((await ensureApprovedAssets({job,source,cfg:{dataDir,publicOrigin:origin},renderer})).restored,1);
  assert.equal(JSON.stringify(job.payload),before);assert.ok((await stat(join(dataDir,'assets',key+'.jpg'))).size>0);
  assert.equal((await ensureApprovedAssets({job,source,cfg:{dataDir,publicOrigin:origin},renderer})).restored,0);assert.equal(renders,1);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
test('unmatched historical asset, changed source or foreign host cannot be replaced by another picture',async()=>{
 const source={revision:'r',media:[{mediaContentType:'IMAGE',status:'READY',image:{url:image}}]};
 for(const [url,revision,code] of [[origin+'/marketing-assets/'+'b'.repeat(64)+'.jpg','r','APPROVED_ASSET_SOURCE_UNAVAILABLE'],
  [origin+'/marketing-assets/'+carouselAssetKey(image)+'.jpg','changed','SOCIAL_REVIEW_STALE'],
  ['https://evil.example/marketing-assets/'+carouselAssetKey(image)+'.jpg','r','UNTRUSTED_PUBLISH_ASSET']]){
  let renders=0;const job={payload:{format:'carousel',productRevision:revision,imageURLs:[url]}};
  await assert.rejects(ensureApprovedAssets({job,source,cfg:{dataDir:'/tmp/does-not-exist-approved',publicOrigin:origin},renderer:{carousel:async()=>{renders++;}}}),{code});assert.equal(renders,0);
 }
});
test('missing approved video is not silently replaced by a newly generated clip',async()=>{
 await assert.rejects(ensureApprovedAssets({job:{payload:{format:'reels',productRevision:'r',videoURL:origin+'/marketing-assets/'+'c'.repeat(64)+'.mp4'}},source:{revision:'r',media:[]},cfg:{dataDir:'/tmp/does-not-exist-approved',publicOrigin:origin},renderer:{}}),{code:'APPROVED_VIDEO_ASSET_MISSING'});
});

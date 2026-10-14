import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fail,log} from './core.js';
import {extractMedia,carouselAssetKey} from './media.js';

// Restore the SAME approved photo/cache key, not a new selection or template.
// Approved payload URLs and consent are immutable throughout this repair.
export async function ensureApprovedAssets({job,source,cfg,renderer}) {
  if(source.revision!==job.payload.productRevision)fail('SOCIAL_REVIEW_STALE');
  const video=job.payload.format==='reels',urls=video?[job.payload.videoURL]:job.payload.imageURLs;
  if(!Array.isArray(urls)||!urls.length||urls.length>35)fail('INVALID_ASSET_COUNT');
  const sources=new Map(extractMedia(source.media).images.map(image=>[carouselAssetKey(image),image]));
  let restored=0;
  for(const value of urls) {
    let url;try{url=new URL(value);}catch{fail('UNTRUSTED_PUBLISH_ASSET');}
    const pattern=video?/^\/marketing-assets\/([a-f0-9]{64})\.mp4$/:/^\/marketing-assets\/([a-f0-9]{64})\.jpg$/;
    const match=url.pathname.match(pattern);
    if(url.origin!==cfg.publicOrigin||url.search||url.hash||url.username||url.password||!match)fail('UNTRUSTED_PUBLISH_ASSET');
    const path=join(cfg.dataDir,'assets',match[1]+(video?'.mp4':'.jpg'));
    let present=false;try{present=(await stat(path)).size>0;}catch{}
    if(present)continue;
    if(video)fail('APPROVED_VIDEO_ASSET_MISSING');
    const image=sources.get(match[1]);
    if(!image)fail('APPROVED_ASSET_SOURCE_UNAVAILABLE');
    const output=await renderer.carousel([image]);
    if(!output.imageURLs?.includes(value)||(await stat(path)).size<=0)fail('APPROVED_ASSET_RESTORE_UNCONFIRMED');
    restored++;
  }
  if(restored)log('APPROVED_ASSETS_RESTORED',{postId:job.id,channel:job.channel,count:restored,changedPayload:false});
  return {restored,count:urls.length};
}

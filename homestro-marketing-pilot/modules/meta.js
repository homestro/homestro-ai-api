import {fail,sleep,log} from './core.js';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

function safeMetaText(value) {
  return String(value||'').replace(/https?:\/\/\S+/g,'[URL]').replace(/[A-Za-z0-9_-]{40,}/g,'[REDACTED]').slice(0,2000);
}
function metaErrorJSON(body) {
  const error=body?.error||body||{};
  if(!error||typeof error!=='object')return {raw:safeMetaText(error)};
  return {type:error.type||null,message:safeMetaText(error.message),code:error.code??null,
    error_subcode:error.error_subcode??null,error_user_title:safeMetaText(error.error_user_title),
    error_user_msg:safeMetaText(error.error_user_msg),fbtrace_id:error.fbtrace_id||null};
}

export class MetaOrganic {
  constructor(cfg,fetchImpl=fetch) {this.cfg=cfg;this.fetch=fetchImpl;}
  async credentials() {
    let c;
    try{c=this.cfg.getCredentials?await this.cfg.getCredentials():{token:this.cfg.token,pageId:this.cfg.pageId,instagramId:this.cfg.instagramId};}
    catch(e){fail(e.code==='META_REAUTH_REQUIRED'?'META_REAUTH_REQUIRED':'META_CREDENTIALS_UNAVAILABLE');}
    if(!c.token)fail('META_CREDENTIALS_UNAVAILABLE');
    if(c.pageId!==this.cfg.pageId||c.instagramId!==this.cfg.instagramId)fail('META_ACCOUNT_MISMATCH');
    return c;
  }
  async request(path,{method='GET',fields,body}={}) {
    // Positive allowlist. Ads, campaigns, adsets and creatives cannot be addressed.
    if(!/^(?:me|\d+(?:_\d+)?)(?:\/(?:media|media_publish|video_reels|photos|feed))?$/.test(path)) fail('NON_ORGANIC_ENDPOINT_BLOCKED');
    const credentials=await this.credentials();
    const u=new URL(`https://graph.facebook.com/${this.cfg.graphVersion}/${path}`);
    if(credentials.appsecretProof)u.searchParams.set('appsecret_proof',credentials.appsecretProof);
    if(fields)u.searchParams.set('fields',fields);
    const r=await this.fetch(u,{method,headers:{Authorization:`Bearer ${credentials.token}`,
      ...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},
      body:body?new URLSearchParams(body):undefined,signal:AbortSignal.timeout(30000),redirect:'error'});
    let b;try{b=await r.json();}catch{fail('META_INVALID_RESPONSE');}
    if(!r.ok || b.error) {
      const message=String(b.error?.message||'').replace(/https?:\/\/\S+/g,'[URL]').replace(/[A-Za-z0-9_-]{40,}/g,'[REDACTED]').slice(0,240);
      log('META_API_ERROR',{httpStatus:r.status,apiCode:b.error?.code||null,apiSubcode:b.error?.error_subcode||null,apiMessage:message});
      if(b.error?.code===190)await this.cfg.onCredentialError?.({metaCode:190},credentials);
      fail(b.error?.code===190?'META_REAUTH_REQUIRED':'META_REQUEST_FAILED');
    }
    return b;
  }
  async verifyConnection() {
    const p=await this.request(this.cfg.pageId,{fields:'id,instagram_business_account'});
    if(String(p.id)!==this.cfg.pageId || String(p.instagram_business_account?.id)!==this.cfg.instagramId)
      fail('META_ACCOUNT_MISMATCH');
  }
  async poll(read,isReady,maxMs=180000) {
    const deadline=Date.now()+maxMs;
    while(Date.now()<deadline){const state=await read();if(isReady(state))return state;await sleep(5000);}
    fail('META_PROCESSING_TIMEOUT');
  }
  async verifyInstagramMp4(url) {
    let response;
    try {
      response=await this.fetch(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(20000)});
    } catch { fail('INSTAGRAM_MP4_HEAD_FAILED'); }
    const contentType=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    const contentLength=Number(response.headers.get('content-length')||0);
    if(response.status!==200||contentType!=='video/mp4'||contentLength<=10000) {
      log('META_INSTAGRAM_VIDEO_PREFLIGHT_FAILED',{httpStatus:response.status,contentType,contentLength});
      fail('INSTAGRAM_MP4_PREFLIGHT_FAILED');
    }
    return {httpStatus:response.status,contentType,contentLength};
  }
  async publishFacebookVideo(job,checkpoint) {
    const p=job.payload,asset=new URL(p.videoURL);
    const match=asset.pathname.match(/^\/marketing-assets\/([a-f0-9]{64})\.mp4$/);
    if(asset.origin!==this.cfg.publicOrigin||!match)fail('UNTRUSTED_PUBLISH_ASSET');
    const filePath=join(this.cfg.dataDir||'/data/marketing','assets',match[1]+'.mp4');
    let bytes,info;
    try {[bytes,info]=await Promise.all([readFile(filePath),stat(filePath)]);}
    catch {fail('LOCAL_REEL_ASSET_MISSING');}
    if(info.size<=10000||bytes.length!==info.size)fail('LOCAL_REEL_ASSET_INVALID');
    const credentials=await this.credentials();
    const form=new FormData();
    form.append('source',new Blob([bytes],{type:'video/mp4'}),'homestro-reel.mp4');
    form.append('title',String(p.title||'Homestro Reel').slice(0,100));
    form.append('description',String(p.caption||''));
    form.append('published','true');
    await checkpoint({phase:'fb_direct_upload_intent',assetBytes:info.size});
    const endpoint=new URL(`https://graph-video.facebook.com/${this.cfg.graphVersion}/${this.cfg.pageId}/videos`);
    let response,body;
    try {
      response=await this.fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${credentials.token}`},
        body:form,signal:AbortSignal.timeout(120000),redirect:'error'});
      body=await response.json();
    } catch {fail('FB_BINARY_UPLOAD_TRANSPORT_FAILED');}
    if(!response.ok||body?.error||!/^\\d+$/.test(String(body?.id||''))) {
      log('META_API_ERROR',{stage:'facebook_direct_binary_upload',httpStatus:response.status,metaError:metaErrorJSON(body)});
      if(body?.error?.code===190)await this.cfg.onCredentialError?.({metaCode:190},credentials);
      fail(body?.error?.code===190?'META_REAUTH_REQUIRED':'FB_BINARY_UPLOAD_FAILED');
    }
    const postId=String(body.id);
    await checkpoint({phase:'published',postId,upload:'direct_multipart',permalink:body.permalink_url||null});
    return postId;
  }
  async publish(job,checkpoint) {
    if(!this.cfg.publishingEnabled)fail('PUBLISHING_DISABLED');
    if(job.status!=='publishing' || !job.approved_by || !job.approved_at || job.payload.adSpendEUR!==0)
      fail('APPROVAL_REQUIRED');
    const p=job.payload;
    const urls=p.format==='reels'?[p.videoURL]:p.imageURLs;
    if(!Array.isArray(urls) || !urls.length || urls.length>10)fail('INVALID_ASSET_COUNT');
    for(const url of urls){
      const asset=new URL(url);
      const ext=p.format==='reels'?'mp4':'jpg';
      if(asset.origin!==this.cfg.publicOrigin || !new RegExp(`^/marketing-assets/[a-f0-9]{64}\\.${ext}$`).test(asset.pathname))fail('UNTRUSTED_PUBLISH_ASSET');
    }
    if(p.locationId!==null)fail('LOCATION_REQUIRES_SEPARATE_VERIFIED_IMPLEMENTATION');
    if(p.format==='carousel' || p.format==='image') return this.publishPhotos(job,checkpoint);
    if(p.format!=='reels')fail('INVALID_POST_FORMAT');
    // Every mutation intent is durable before network I/O. Uncertain results are never retried automatically.
    if(job.channel==='instagram') {
      const preflight=await this.verifyInstagramMp4(p.videoURL);
      log('META_INSTAGRAM_VIDEO_PREFLIGHT_OK',{...preflight});
      await checkpoint({phase:'ig_create_intent'});
      const c=await this.request(`${this.cfg.instagramId}/media`,{method:'POST',body:{
        media_type:'REELS',video_url:p.videoURL,caption:p.caption,share_to_feed:'true'}});
      if(!/^\d+$/.test(String(c.id)))fail('META_CONTAINER_MISSING');
      await checkpoint({phase:'ig_processing',containerId:c.id});
      await this.poll(()=>this.request(c.id,{fields:'status_code,status'}),s=>{
        if(['ERROR','EXPIRED'].includes(s.status_code)){
          log('META_CONTAINER_ERROR',{channel:'instagram',containerId:c.id,statusCode:s.status_code,
            status:s.status||null,metaError:metaErrorJSON(s)});
          fail('IG_CONTAINER_FAILED');
        }
        return s.status_code==='FINISHED';
      });
      await checkpoint({phase:'ig_publish_intent',containerId:c.id});
      const post=await this.request(`${this.cfg.instagramId}/media_publish`,{method:'POST',body:{creation_id:c.id}});
      if(!/^\d+$/.test(String(post.id)))fail('META_PUBLISH_UNCONFIRMED');
      await checkpoint({phase:'published',containerId:c.id,postId:post.id});
      return post.id;
    }
    if(job.channel!=='facebook')fail('INVALID_CHANNEL');
    return this.publishFacebookVideo(job,checkpoint);
  }
  async verifyJpegAsset(url) {
    const response=await this.fetch(url,{headers:{Accept:'image/jpeg'},signal:AbortSignal.timeout(20000),redirect:'error'});
    const type=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(response.status!==200||type!=='image/jpeg')fail('META_IMAGE_HTTP_OR_CONTENT_TYPE_INVALID');
    const reader=response.body?.getReader?.();let head;
    try{if(reader){head=(await reader.read()).value;await reader.cancel().catch(()=>{});}else head=new Uint8Array(await response.arrayBuffer()).subarray(0,3);}
    catch{fail('META_IMAGE_READ_FAILED');}
    if(!head||head.length<3||head[0]!==0xff||head[1]!==0xd8||head[2]!==0xff)fail('META_IMAGE_JPEG_SIGNATURE_INVALID');
  }
  async publishPhotos(job,checkpoint) {
    const p=job.payload, images=p.imageURLs;
    for(const url of images)await this.verifyJpegAsset(url);
    if(job.channel==='instagram') {
      const children=[];
      for(let i=0;i<images.length;i++){
        await checkpoint({phase:'ig_image_create_intent',children,index:i});
        const body={image_url:images[i]};
        if(images.length>1)body.is_carousel_item='true';else body.caption=p.caption;
        const c=await this.request(`${this.cfg.instagramId}/media`,{method:'POST',body});
        if(!/^\d+$/.test(String(c.id)))fail('META_CONTAINER_MISSING');
        children.push(c.id);await checkpoint({phase:'ig_image_processing',children:[...children]});
        await this.poll(()=>this.request(c.id,{fields:'status_code'}),s=>{
          if(['ERROR','EXPIRED'].includes(s.status_code)){log('META_CONTAINER_ERROR',{channel:'instagram',containerId:c.id,statusCode:s.status_code,status:s.status||null,metaError:metaErrorJSON(s)});fail('IG_CONTAINER_FAILED');}return s.status_code==='FINISHED';
        });
      }
      let containerId=children[0];
      if(children.length>1){
        await checkpoint({phase:'ig_carousel_create_intent',children});
        const c=await this.request(`${this.cfg.instagramId}/media`,{method:'POST',body:{
          media_type:'CAROUSEL',children:children.join(','),caption:p.caption}});
        if(!/^\d+$/.test(String(c.id)))fail('META_CONTAINER_MISSING');
        containerId=c.id;await checkpoint({phase:'ig_carousel_processing',children,containerId});
        await this.poll(()=>this.request(containerId,{fields:'status_code'}),s=>{
          if(['ERROR','EXPIRED'].includes(s.status_code))fail('IG_CONTAINER_FAILED');return s.status_code==='FINISHED';
        });
      }
      await checkpoint({phase:'ig_publish_intent',children,containerId});
      const published=await this.request(`${this.cfg.instagramId}/media_publish`,{method:'POST',body:{creation_id:containerId}});
      if(!/^\d+$/.test(String(published.id)))fail('META_PUBLISH_UNCONFIRMED');
      await checkpoint({phase:'published',children,containerId,postId:published.id});return published.id;
    }
    if(job.channel!=='facebook')fail('INVALID_CHANNEL');
    const photos=[];
    for(let i=0;i<images.length;i++){
      await checkpoint({phase:'fb_photo_upload_intent',photos,index:i});
      const c=await this.request(`${this.cfg.pageId}/photos`,{method:'POST',body:{url:images[i],published:'false'}});
      if(!/^\d+$/.test(String(c.id)))fail('META_PHOTO_MISSING');
      photos.push(c.id);await checkpoint({phase:'fb_photos_uploaded',photos:[...photos]});
    }
    await checkpoint({phase:'fb_feed_publish_intent',photos});
    const published=await this.request(`${this.cfg.pageId}/feed`,{method:'POST',body:{
      message:p.caption,published:'true',attached_media:JSON.stringify(photos.map(id=>({media_fbid:id})))}});
    if(!/^\d+(?:_\d+)?$/.test(String(published.id)))fail('META_PUBLISH_UNCONFIRMED');
    await checkpoint({phase:'published',photos,postId:published.id});return published.id;
  }
}

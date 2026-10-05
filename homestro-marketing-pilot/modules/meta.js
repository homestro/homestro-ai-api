import {fail,sleep,log} from './core.js';

export class MetaOrganic {
  constructor(cfg,fetchImpl=fetch) {this.cfg=cfg;this.fetch=fetchImpl;}
  async request(path,{method='GET',fields,body}={}) {
    // Positive allowlist. Ads, campaigns, adsets and creatives cannot be addressed.
    if(!/^(?:me|\d+)(?:\/(?:media|media_publish|video_reels|photos|feed))?$/.test(path)) fail('NON_ORGANIC_ENDPOINT_BLOCKED');
    const u=new URL(`https://graph.facebook.com/${this.cfg.graphVersion}/${path}`);
    if(fields)u.searchParams.set('fields',fields);
    const r=await this.fetch(u,{method,headers:{Authorization:`Bearer ${this.cfg.token}`,
      ...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},
      body:body?new URLSearchParams(body):undefined,signal:AbortSignal.timeout(30000),redirect:'error'});
    let b;try{b=await r.json();}catch{fail('META_INVALID_RESPONSE');}
    if(!r.ok || b.error) {
      const message=String(b.error?.message||'').replace(/https?:\/\/\S+/g,'[URL]').replace(/[A-Za-z0-9_-]{40,}/g,'[REDACTED]').slice(0,240);
      log('META_API_ERROR',{httpStatus:r.status,apiCode:b.error?.code||null,apiSubcode:b.error?.error_subcode||null,message});
      fail(b.error?.code===190?'META_TOKEN_EXPIRED':'META_REQUEST_FAILED');
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
      await checkpoint({phase:'ig_create_intent'});
      const c=await this.request(`${this.cfg.instagramId}/media`,{method:'POST',body:{
        media_type:'REELS',video_url:p.videoURL,caption:p.caption,share_to_feed:'true'}});
      if(!/^\d+$/.test(String(c.id)))fail('META_CONTAINER_MISSING');
      await checkpoint({phase:'ig_processing',containerId:c.id});
      await this.poll(()=>this.request(c.id,{fields:'status_code'}),s=>{
        if(['ERROR','EXPIRED'].includes(s.status_code))fail('IG_CONTAINER_FAILED');
        return s.status_code==='FINISHED';
      });
      await checkpoint({phase:'ig_publish_intent',containerId:c.id});
      const post=await this.request(`${this.cfg.instagramId}/media_publish`,{method:'POST',body:{creation_id:c.id}});
      if(!/^\d+$/.test(String(post.id)))fail('META_PUBLISH_UNCONFIRMED');
      await checkpoint({phase:'published',containerId:c.id,postId:post.id});
      return post.id;
    }
    if(job.channel!=='facebook')fail('INVALID_CHANNEL');
    await checkpoint({phase:'fb_start_intent'});
    const s=await this.request(`${this.cfg.pageId}/video_reels`,{method:'POST',body:{upload_phase:'start'}});
    if(!/^\d+$/.test(String(s.video_id)))fail('META_CONTAINER_MISSING');
    const upload=new URL(s.upload_url);
    if(upload.origin!=='https://rupload.facebook.com' ||
       !new RegExp(`^/video-upload/v\\d+\\.\\d+/${s.video_id}$`).test(upload.pathname))fail('UNTRUSTED_UPLOAD_URL');
    await checkpoint({phase:'fb_upload_intent',videoId:s.video_id});
    const r=await this.fetch(upload,{method:'POST',headers:{Authorization:`OAuth ${this.cfg.token}`,
      file_url:p.videoURL},signal:AbortSignal.timeout(60000),redirect:'error'});
    const uploaded=await r.json();if(!r.ok || !uploaded.success)fail('FB_UPLOAD_FAILED');
    await checkpoint({phase:'fb_uploaded',videoId:s.video_id});
    await this.poll(()=>this.request(s.video_id,{fields:'status'}),s=>{
      if(s.status?.uploading_phase?.status==='error')fail('FB_UPLOAD_FAILED');
      return s.status?.uploading_phase?.status==='complete';
    });
    // Facebook finish initiates assembly/encoding. Do not wait for encoding before finish.
    await checkpoint({phase:'fb_publish_intent',videoId:s.video_id});
    const finished=await this.request(`${this.cfg.pageId}/video_reels`,{method:'POST',body:{
      upload_phase:'finish',video_state:'PUBLISHED',video_id:s.video_id,description:p.caption,title:p.title}});
    if(!finished.success)fail('META_PUBLISH_UNCONFIRMED');
    await this.poll(()=>this.request(s.video_id,{fields:'status'}),s=>{
      if(s.status?.processing_phase?.status==='error' || s.status?.publishing_phase?.status==='error')fail('FB_PROCESSING_FAILED');
      return s.status?.publishing_phase?.status==='complete';
    });
    await checkpoint({phase:'published',videoId:s.video_id,postId:s.video_id});
    return s.video_id;
  }
  async publishPhotos(job,checkpoint) {
    const p=job.payload, images=p.imageURLs;
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
          if(['ERROR','EXPIRED'].includes(s.status_code))fail('IG_CONTAINER_FAILED');return s.status_code==='FINISHED';
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

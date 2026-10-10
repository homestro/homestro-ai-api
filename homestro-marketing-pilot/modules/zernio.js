import {createHash} from 'node:crypto';
import {fail} from './core.js';

const objectId=value=>/^[a-f0-9]{24}$/.test(String(value));
const CHANNELS=new Set(['tiktok','pinterest']);

// Transport only. The coordinator must refresh Shopify eligibility before submission
// and reconcile pending submissions; submitting is never proof of publication.
export class ZernioOrganic {
  constructor(cfg,fetchImpl=fetch) {
    this.cfg=cfg;this.fetch=fetchImpl;
    const accounts=Object.entries(cfg.accounts||{});
    if(accounts.length>2 || accounts.some(([channel,id])=>!CHANNELS.has(channel)||!objectId(id)))fail('ZERNIO_ACCOUNT_CONFIG_INVALID');
    if(cfg.publicOrigin && new URL(cfg.publicOrigin).protocol!=='https:')fail('ZERNIO_PUBLIC_ORIGIN_INVALID');
  }
  async request(path,{method='GET',body,key}={}) {
    if(!/^(?:accounts|accounts\/[a-f0-9]{24}\/(?:tiktok\/creator-info|pinterest-boards)|posts(?:\/[a-f0-9]{24})?)$/.test(path))fail('NON_ORGANIC_ENDPOINT_BLOCKED');
    if(!this.cfg.apiKey)fail('ZERNIO_CREDENTIALS_UNAVAILABLE');
    let response;
    try {
      response=await this.fetch(`https://zernio.com/api/v1/${path}`,{
        method,redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{Authorization:`Bearer ${this.cfg.apiKey}`,...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},
        body:body?JSON.stringify(body):undefined
      });
    } catch {fail(method==='POST'?'ZERNIO_RESULT_UNCERTAIN':'ZERNIO_READ_FAILED');}
    let data;try{data=await response.json();}catch{fail(method==='POST'?'ZERNIO_RESULT_UNCERTAIN':'ZERNIO_INVALID_RESPONSE');}
    if(!response.ok) {
      // Do not include remote messages, credentials or the response body in logs.
      const code=response.status===401?'ZERNIO_REAUTH_REQUIRED':response.status===429?'ZERNIO_RATE_LIMIT':response.status>=500&&method==='POST'?'ZERNIO_RESULT_UNCERTAIN':'ZERNIO_REQUEST_FAILED';
      fail(code);
    }
    return data;
  }
  async verifyConnection(channel) {
    const accountId=this.cfg.accounts?.[channel];
    if(!CHANNELS.has(channel)||!accountId)fail('ZERNIO_CHANNEL_NOT_CONNECTED');
    const data=await this.request('accounts');
    const account=data.accounts?.find(a=>a._id===accountId && a.platform===channel);
    if(!account || account.isActive!==true)fail('ZERNIO_ACCOUNT_MISMATCH');
    return account;
  }
  buildRequest(job) {
    const p=job.payload;
    if(!CHANNELS.has(job.channel)||!this.cfg.accounts?.[job.channel])fail('ZERNIO_CHANNEL_NOT_CONNECTED');
    if(job.status!=='publishing'||!job.approved_by||!job.approved_at||p?.adSpendEUR!==0||p.previewOnly===true)fail('APPROVAL_REQUIRED');
    if(!String(job.id||'').trim()||!String(p.caption||'').trim())fail('INVALID_POST');
    const isVideo=p.format==='reels';
    if(!['reels','carousel','image'].includes(p.format))fail('INVALID_POST_FORMAT');
    const urls=isVideo?[p.videoURL]:p.imageURLs;
    const limit=job.channel==='pinterest'?1:35;
    if(!Array.isArray(urls)||!urls.length||urls.length>limit)fail('INVALID_ASSET_COUNT');
    for(const url of urls) {
      let asset;try{asset=new URL(url);}catch{fail('UNTRUSTED_PUBLISH_ASSET');}
      const ext=isVideo?'mp4':'jpg';
      if(asset.protocol!=='https:'||asset.origin!==this.cfg.publicOrigin||asset.search||asset.hash||!new RegExp(`^/marketing-assets/[a-f0-9]{64}\\.${ext}$`).test(asset.pathname))fail('UNTRUSTED_PUBLISH_ASSET');
    }
    const body={content:job.channel==='tiktok'&&!isVideo?String(p.title||'').slice(0,90):p.caption,mediaItems:urls.map(url=>({type:isVideo?'video':'image',url})),
      platforms:[{platform:job.channel,accountId:this.cfg.accounts[job.channel]}],publishNow:true,
      metadata:{pilotPostId:String(job.id),productId:job.product_id}};
    if(job.channel==='pinterest') {
      if(p.caption.length>800||!p.title||p.title.length>100)fail('PINTEREST_COPY_LIMIT');
      const boardId=p.boardId;
      if(!this.cfg.boardIds?.includes(boardId))fail('PINTEREST_BOARD_NOT_APPROVED');
      let destination;try{destination=new URL(p.productURL);}catch{fail('INVALID_PRODUCT_URL');}
      if(destination.protocol!=='https:'||destination.origin!==this.cfg.shopOrigin||destination.username||destination.password)fail('INVALID_PRODUCT_URL');
      body.platforms[0].platformSpecificData={boardId,title:p.title,link:destination.href};
    } else {
      // These attestations must originate from a real content preview/consent record.
      // Never default them to true from broad autopilot authorization.
      const settings=p.tiktokSettings;
      if(settings?.content_preview_confirmed!==true||settings.express_consent_given!==true)fail('TIKTOK_PREVIEW_CONSENT_REQUIRED');
      if(settings.privacy_level!=='PUBLIC_TO_EVERYONE'||typeof settings.allow_comment!=='boolean')fail('TIKTOK_SETTINGS_REQUIRED');
      if(isVideo && (typeof settings.allow_duet!=='boolean'||typeof settings.allow_stitch!=='boolean'))fail('TIKTOK_SETTINGS_REQUIRED');
      if(p.caption.length>(isVideo?2200:4000))fail('TIKTOK_COPY_LIMIT');
      body.tiktokSettings={privacy_level:settings.privacy_level,allow_comment:settings.allow_comment,
        content_preview_confirmed:true,express_consent_given:true,commercialContentType:'brand_organic',
        ...(isVideo?{allow_duet:settings.allow_duet,allow_stitch:settings.allow_stitch}:{media_type:'photo',description:p.caption,photo_cover_index:0})};
    }
    return body;
  }
  async preflightTikTok(job) {
    if(job.channel!=='tiktok')fail('INVALID_CHANNEL');
    const body=this.buildRequest(job);
    const info=await this.request(`accounts/${this.cfg.accounts.tiktok}/tiktok/creator-info`);
    if(info.creator?.canPostMore!==true||!info.privacyLevels?.some(x=>x.value==='PUBLIC_TO_EVERYONE'))fail('TIKTOK_PUBLIC_POST_UNAVAILABLE');
    for(const key of ['allow_comment','allow_duet','allow_stitch']) {
      if(body.tiktokSettings[key]===true && info.postingLimits?.interactionSettings?.[key]?.enabled!==true)fail('TIKTOK_INTERACTION_NOT_ALLOWED');
    }
    if(!info.commercialContentTypes?.some(x=>x.value==='brand_organic'))fail('TIKTOK_BRAND_DISCLOSURE_UNAVAILABLE');
    const result=await this.request('posts',{method:'POST',body:{...body,dryRun:true}});
    if(result.dryRun!==true||result.canPublish!==true)fail('TIKTOK_PUBLISH_UNAVAILABLE');
    return result;
  }
  async submit(job,checkpoint) {
    if(this.cfg.publishingEnabled!==true)fail('PUBLISHING_DISABLED');
    const body=this.buildRequest(job);
    await this.verifyConnection(job.channel);
    if(job.channel==='tiktok')await this.preflightTikTok(job);
    const key=createHash('sha256').update(`homestro:zernio:${job.id}`).digest('hex');
    await checkpoint({phase:'zernio_submit_intent',idempotencyKey:key});
    const data=await this.request('posts',{method:'POST',body,key});
    if(!objectId(data.post?._id))fail('ZERNIO_RESULT_UNCERTAIN');
    const state=this.publicationState(data.post,job.channel);
    await checkpoint({phase:'zernio_submitted',idempotencyKey:key,providerPostId:data.post._id,...state});
    return state;
  }
  publicationState(post,channel) {
    const accountId=this.cfg.accounts?.[channel];
    const entry=post.platforms?.find(x=>x.platform===channel && String(x.accountId?._id||x.accountId)===accountId);
    if(!entry)return {status:'recovery_required',permalink:null};
    if(entry.platformSpecificData?.isDraft===true||entry.platformSpecificData?.tiktokSettings?.draft===true)return {status:'draft_delivered',permalink:null};
    if(entry.status==='failed')return {status:'failed',permalink:null};
    let url;try{url=new URL(entry.platformPostUrl);}catch{return {status:'verification_pending',permalink:null};}
    const host=channel==='tiktok'?'tiktok.com':'pinterest.com';
    const valid=url.protocol==='https:' && (url.hostname===host||url.hostname===`www.${host}`) && !url.username && !url.password;
    return entry.status==='published'&&valid?{status:'published',permalink:url.href}:{status:'verification_pending',permalink:null};
  }
  async reconcile(providerPostId,channel) {
    if(!objectId(providerPostId)||!CHANNELS.has(channel))fail('INVALID_REMOTE_POST');
    const data=await this.request(`posts/${providerPostId}`);
    return this.publicationState(data.post||{},channel);
  }
}

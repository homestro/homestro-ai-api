'use strict';

function registerMetaOrganic(app, apiKey, { fetchImpl = global.fetch, env = process.env } = {}) {
  const config = () => ({
    token: String(env.META_PAGE_ACCESS_TOKEN || '').trim(),
    pageId: String(env.META_PAGE_ID || '').trim(),
    instagramId: String(env.META_INSTAGRAM_ACCOUNT_ID || '').trim()
  });
  const configured = ({token,pageId,instagramId}) => Boolean(token && /^\d+$/.test(pageId) && /^\d+$/.test(instagramId));
  async function read(token, path, fields) {
    const url = new URL(`https://graph.facebook.com/v26.0/${path}`);
    if (fields) url.searchParams.set('fields', fields);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      const error = new Error('Meta rejected request');
      error.metaCode = data?.error?.code;
      error.metaSubcode = data?.error?.error_subcode;
      throw error;
    }
    return data;
  }
  async function connectionState() {
    const cfg = config();
    if (!configured(cfg)) return {status:503, body:{ok:false,error:'Meta connection configuration is incomplete',published:false}};
    try {
      const page = await read(cfg.token, cfg.pageId, 'id,name,instagram_business_account');
      if (page.id !== cfg.pageId || page.instagram_business_account?.id !== cfg.instagramId) {
        return {status:409, body:{ok:false,error:'Meta account does not match configured Homestro accounts',published:false}};
      }
      const instagram = await read(cfg.token, cfg.instagramId, 'id,username,media_count');
      if (instagram.id !== cfg.instagramId) throw new Error('Instagram account mismatch');
      return {status:200, body:{ok:true,page:{id:page.id,name:page.name},
        instagram:{id:instagram.id,username:instagram.username,mediaCount:instagram.media_count},
        publishingVerified:false,published:false,schedulerEnabled:false}};
    } catch (error) {
      return {status:502, body:{ok:false,error:'Meta connection verification failed; check token validity and account permissions',
        metaCode:error.metaCode||null,metaSubcode:error.metaSubcode||null,published:false}};
    }
  }
  const verifyConnection = async (_req, res) => {
    const result = await connectionState();
    return res.status(result.status).json(result.body);
  };
  const verifyPublishing = async (_req, res) => {
    const result = await connectionState();
    if (!result.body.ok) return res.status(result.status).json(result.body);
    const facebookReady = null;
    let instagramReady = false;
    let instagramLimit = null;
    try {
      const cfg = config();
      const limit = await read(cfg.token, `${cfg.instagramId}/content_publishing_limit`, 'config,quota_usage');
      instagramLimit = limit?.data?.[0] || null;
      instagramReady = true;
    } catch (_) {
      instagramReady = false;
    }
    return res.status(instagramReady ? 200 : 409).json({
      ok: instagramReady,
      facebook:{ready:null,note:'Write access is verified only by a publish attempt; no test post is created by this endpoint.'},
      instagram:{ready:instagramReady,publishingLimit:instagramLimit},
      published:false,paidAds:false
    });
  };
  app.get('/api/marketing/organic/connection', apiKey, verifyConnection);
  app.get('/api/marketing/organic/publishing-permissions', apiKey, verifyPublishing);
  if (env.META_PAGE_ACCESS_TOKEN && env.META_PAGE_ID && env.META_INSTAGRAM_ACCOUNT_ID) {
    const report = label => ({ status(code) { this.code = code; return this; }, json(result) {
      console.log(`[${label}] ${JSON.stringify(result)}`);
    } });
    void verifyConnection({}, report('meta-organic-connection')).catch(() => console.log('[meta-organic-connection] verification failed'));
    void verifyPublishing({}, report('meta-organic-publishing')).catch(() => console.log('[meta-organic-publishing] verification failed'));
  }
}


async function publishOrganicDraft(draft, { fetchImpl = global.fetch, env = process.env } = {}) {
  const token=String(env.META_PAGE_ACCESS_TOKEN||'').trim();
  const pageId=String(env.META_PAGE_ID||'').trim();
  const instagramId=String(env.META_INSTAGRAM_ACCOUNT_ID||'').trim();
  if(!token||!pageId||!instagramId) throw new Error('Meta publishing configuration incomplete');
  async function post(path, params) {
    const body=new URLSearchParams(params); const response=await fetchImpl(`https://graph.facebook.com/v26.0/${path}`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(30000)
    }); const data=await response.json(); if(!response.ok||data.error){const e=new Error(data?.error?.message||'Meta publish rejected');e.meta=data?.error||null;throw e;} return data;
  }
  if(draft.channel==='facebook'){
    const result=await post(`${pageId}/photos`,{url:draft.imageUrl,caption:draft.caption,published:'true'});
    return {channel:'facebook',published:true,id:result.post_id||result.id};
  }
  if(draft.channel==='instagram'){
    const sourceImage=new URL(draft.imageUrl);
    // Shopify CDN can transform source WEBP assets to a Meta-compatible JPEG.
    if(/cdn\.shopify\.com$/i.test(sourceImage.hostname)){
      sourceImage.searchParams.set('format','jpg');
    }
    const instagramImageUrl=sourceImage.href;
    const container=await post(`${instagramId}/media`,{image_url:instagramImageUrl,caption:draft.caption});
    let status=null;
    for(let attempt=0;attempt<12;attempt++){
      await new Promise(resolve=>setTimeout(resolve,5000));
      const url=new URL(`https://graph.facebook.com/v26.0/${container.id}`);
      url.searchParams.set('fields','status_code,status');
      const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
      const data=await response.json();
      if(!response.ok||data.error){const e=new Error(data?.error?.message||'Instagram container status failed');e.meta=data?.error||null;throw e;}
      status=data;
      if(data.status_code==='FINISHED')break;
      if(data.status_code==='ERROR'||data.status_code==='EXPIRED')throw new Error(`Instagram media processing failed: ${data.status||data.status_code}`);
    }
    if(status?.status_code!=='FINISHED')throw new Error('Instagram media processing timed out');
    const result=await post(`${instagramId}/media_publish`,{creation_id:container.id});
    return {channel:'instagram',published:true,id:result.id,containerId:container.id};
  }
  throw new Error('Unsupported channel');
}

module.exports = { registerMetaOrganic, publishOrganicDraft };

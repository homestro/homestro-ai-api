'use strict';

function registerMetaOrganic(app, apiKey, { fetchImpl = global.fetch, env = process.env, getCredentials, onCredentialError } = {}) {
  const config = async () => getCredentials ? getCredentials() : ({
    token: String(env.META_PAGE_ACCESS_TOKEN || '').trim(),
    pageId: String(env.META_PAGE_ID || '').trim(),
    instagramId: String(env.META_INSTAGRAM_ACCOUNT_ID || '').trim()
  });
  const configured = ({token,pageId,instagramId}) => Boolean(token && /^\d+$/.test(pageId) && /^\d+$/.test(instagramId));
  async function read(credentials, path, fields) {
    const url = new URL(`https://graph.facebook.com/v26.0/${path}`);
    if (fields) url.searchParams.set('fields', fields);
    if (credentials.appsecretProof) url.searchParams.set('appsecret_proof',credentials.appsecretProof);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      const error = new Error('Meta rejected request');
      error.metaCode = data?.error?.code;
      error.metaSubcode = data?.error?.error_subcode;
      if(error.metaCode===190)await onCredentialError?.(error,credentials);
      throw error;
    }
    return data;
  }
  async function connectionState() {
    try {
      const cfg = await config();
      if (!configured(cfg)) return {status:503, body:{ok:false,error:'Meta connection configuration is incomplete',published:false}};
      const page = await read(cfg, cfg.pageId, 'id,name,instagram_business_account');
      if (page.id !== cfg.pageId || page.instagram_business_account?.id !== cfg.instagramId) {
        return {status:409, body:{ok:false,error:'Meta account does not match configured Homestro accounts',published:false}};
      }
      const instagram = await read(cfg, cfg.instagramId, 'id,username,media_count');
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
      const cfg = await config();
      const limit = await read(cfg, `${cfg.instagramId}/content_publishing_limit`, 'config,quota_usage');
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


async function publishOrganicDraft(draft, { fetchImpl = global.fetch, env = process.env, getCredentials, onCredentialError } = {}) {
  const credentials=getCredentials?await getCredentials():{token:String(env.META_PAGE_ACCESS_TOKEN||'').trim(),pageId:String(env.META_PAGE_ID||'').trim(),instagramId:String(env.META_INSTAGRAM_ACCOUNT_ID||'').trim()};
  const {token,pageId,instagramId}=credentials;
  if(!token||!pageId||!instagramId) throw new Error('Meta publishing configuration incomplete');
  const videoUrl=String(draft.videoUrl||'').trim();
  if(!videoUrl)throw new Error('ORGANIC_VIDEO_REQUIRED');
  const parsed=new URL(videoUrl);
  const expectedHost=new URL(String(env.JARVIS_PUBLIC_ORIGIN||'https://homestro-ai-api-fixed-current-production.up.railway.app')).hostname;
  if(parsed.protocol!=='https:'||parsed.hostname!==expectedHost||parsed.username||parsed.password||parsed.search||parsed.hash
    ||!/^\/marketing-assets\/[a-f0-9]{64}\.mp4$/.test(parsed.pathname))throw new Error('UNTRUSTED_REEL_VIDEO_URL');
  const redact = value => String(value ?? '').split(token).join('[REDACTED_TOKEN]');
  async function decode(response) {
    const raw=await response.text();
    let data;
    try{data=JSON.parse(raw);}catch{data={raw};}
    return {data,raw:redact(raw)};
  }
  async function reportFailure(label, response, data, raw) {
    console.error(`[meta-organic] ${label} ${JSON.stringify({status:response.status,body:raw})}`);
    const error = new Error(label);
    error.meta = data?.error || null;
    if(error.meta?.code===190)await onCredentialError?.({metaCode:190},credentials);
    throw error;
  }
  async function validateAndDownload() {
    const response=await fetchImpl(videoUrl,{method:'GET',headers:{Accept:'video/mp4'},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`REEL_ASSET_FETCH_FAILED_HTTP_${response.status}`);
    const type=String(response.headers?.get?.('content-type')||'').split(';')[0].trim().toLowerCase();
    if(type!=='video/mp4')throw new Error(`REEL_ASSET_NOT_MP4:${type||'missing_content_type'}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!bytes.length||bytes.length>60*1024*1024)throw new Error('REEL_ASSET_SIZE_INVALID');
    return bytes;
  }
  async function post(path, params) {
    const body=new URLSearchParams({...params,...(credentials.appsecretProof?{appsecret_proof:credentials.appsecretProof}:{})});
    const response=await fetchImpl(`https://graph.facebook.com/v26.0/${path}`,{
      method:'POST',headers:{Authorization:`Bearer ${credentials.token}`,'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(30000)
    });
    const {data,raw}=await decode(response);
    if(!response.ok||data.error)return reportFailure(`META_POST_FAILED:${path}`,response,data,raw);
    console.info(`[meta-organic] META_POST_OK ${JSON.stringify({path,id:data.id||null})}`);
    return data;
  }
  if(draft.channel==='facebook'){
    const bytes=await validateAndDownload();
    const body=new FormData();
    body.append('source',new Blob([bytes],{type:'video/mp4'}),'homestro-reel.mp4');
    body.append('description',String(draft.caption||''));
    body.append('published','true');
    if(credentials.appsecretProof)body.append('appsecret_proof',credentials.appsecretProof);
    const response=await fetchImpl(`https://graph-video.facebook.com/v26.0/${pageId}/videos`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(60000)
    });
    const {data,raw}=await decode(response);
    if(!response.ok||data.error)return reportFailure('FB_UPLOAD_FAILED',response,data,raw);
    console.info(`[meta-organic] FB_REEL_PUBLISHED ${JSON.stringify({postId:data.id||null})}`);
    return {channel:'facebook',published:true,id:data.id,mediaType:'video'};
  }
  if(draft.channel==='instagram'){
    await validateAndDownload();
    const container=await post(`${instagramId}/media`,{
      media_type:'REELS',video_url:videoUrl,caption:draft.caption,share_to_feed:'true'
    });
    let status=null;
    for(let attempt=0;attempt<12;attempt++){
      await new Promise(resolve=>setTimeout(resolve,5000));
      const url=new URL(`https://graph.facebook.com/v26.0/${container.id}`);
      url.searchParams.set('fields','status_code,status');
      if(credentials.appsecretProof)url.searchParams.set('appsecret_proof',credentials.appsecretProof);
      const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
      const {data,raw}=await decode(response);
      if(!response.ok||data.error)return reportFailure('IG_CONTAINER_STATUS_FAILED',response,data,raw);
      status=data;
      if(data.status_code==='FINISHED')break;
      if(data.status_code==='ERROR'||data.status_code==='EXPIRED'){
        console.error(`[meta-organic] IG_CONTAINER_FAILED ${JSON.stringify({containerId:container.id,status:data,raw})}`);
        throw new Error('IG_CONTAINER_FAILED');
      }
    }
    if(status?.status_code!=='FINISHED')throw new Error('IG_CONTAINER_PROCESSING_TIMEOUT');
    const result=await post(`${instagramId}/media_publish`,{creation_id:container.id});
    console.info(`[meta-organic] IG_REEL_PUBLISHED ${JSON.stringify({containerId:container.id,postId:result.id||null})}`);
    return {channel:'instagram',published:true,id:result.id,containerId:container.id,mediaType:'reel'};
  }
  throw new Error('Unsupported channel');
}

module.exports = { registerMetaOrganic, publishOrganicDraft };


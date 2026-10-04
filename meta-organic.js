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
      const page = await read(cfg.token, 'me', 'id,name,tasks,instagram_business_account');
      if (page.id !== cfg.pageId || page.instagram_business_account?.id !== cfg.instagramId) {
        return {status:409, body:{ok:false,error:'Meta account does not match configured Homestro accounts',published:false}};
      }
      const instagram = await read(cfg.token, cfg.instagramId, 'id,username,media_count');
      if (instagram.id !== cfg.instagramId) throw new Error('Instagram account mismatch');
      const tasks = Array.isArray(page.tasks) ? page.tasks : [];
      return {status:200, body:{ok:true,page:{id:page.id,name:page.name,tasks},
        instagram:{id:instagram.id,username:instagram.username,mediaCount:instagram.media_count},
        publishingVerified:tasks.includes('CREATE_CONTENT'),published:false,schedulerEnabled:false}};
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
    const tasks = result.body.page.tasks || [];
    const facebookReady = tasks.includes('CREATE_CONTENT');
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
    return res.status(facebookReady && instagramReady ? 200 : 409).json({
      ok: facebookReady && instagramReady,
      facebook:{ready:facebookReady,requiredTask:'CREATE_CONTENT'},
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

module.exports = { registerMetaOrganic };

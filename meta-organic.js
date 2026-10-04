'use strict';

function registerMetaOrganic(app, apiKey, { fetchImpl = global.fetch, env = process.env } = {}) {
  app.get('/api/marketing/organic/connection', apiKey, async (_req, res) => {
    const token = String(env.META_PAGE_ACCESS_TOKEN || '').trim();
    const pageId = String(env.META_PAGE_ID || '').trim();
    const instagramId = String(env.META_INSTAGRAM_ACCOUNT_ID || '').trim();
    if (!token || !/^\d+$/.test(pageId) || !/^\d+$/.test(instagramId)) {
      return res.status(503).json({ ok: false, error: 'Meta connection configuration is incomplete', published: false });
    }
    async function read(path, fields) {
      const url = new URL(`https://graph.facebook.com/v26.0/${path}`);
      url.searchParams.set('fields', fields);
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000)
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error('Meta rejected connection verification');
      return data;
    }
    try {
      const page = await read('me', 'id,name,instagram_business_account');
      if (page.id !== pageId || page.instagram_business_account?.id !== instagramId) {
        return res.status(409).json({ ok: false, error: 'Meta account does not match configured Homestro accounts', published: false });
      }
      const instagram = await read(instagramId, 'id,username,media_count');
      if (instagram.id !== instagramId) throw new Error('Instagram account mismatch');
      return res.json({ ok: true, page: { id: page.id, name: page.name },
        instagram: { id: instagram.id, username: instagram.username, mediaCount: instagram.media_count },
        publishingVerified: false, published: false, schedulerEnabled: false });
    } catch (_) {
      return res.status(502).json({ ok: false, error: 'Meta connection verification failed; check token validity and account permissions', published: false });
    }
  });
}

module.exports = { registerMetaOrganic };

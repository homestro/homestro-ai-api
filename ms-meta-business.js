'use strict';

const crypto = require('node:crypto');

const COOKIE = '__Host-ms-meta-business';
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
const STATES = 'ms_meta_oauth_states', CONNECTIONS = 'ms_meta_connections', POSTS = 'ms_meta_posts';
const code = (name, status = 503) => Object.assign(new Error(name), { code: name, status });
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function config(env = process.env) {
  const required = ['DATABASE_URL', 'META_APP_ID', 'META_APP_SECRET', 'META_TOKEN_ENCRYPTION_KEY', 'META_MS_OAUTH_REDIRECT_URI'];
  const missing = required.filter(k => !String(env[k] || '').trim());
  const cfg = { missing, appId: env.META_APP_ID || '', appSecret: env.META_APP_SECRET || '',
    redirectUri: env.META_MS_OAUTH_REDIRECT_URI || '', graphVersion: env.META_GRAPH_VERSION || 'v26.0', key: null,
    enabled: String(env.MS_META_AUTOPUBLISH_ENABLED).toLowerCase() === 'true',
    maxDaily: Number(env.MS_META_MAX_DAILY_PER_CHANNEL || 1) };
  if (missing.length) return cfg;
  let redirect;
  try { redirect = new URL(cfg.redirectUri); } catch { throw code('MS_META_REDIRECT_INVALID', 500); }
  if (redirect.protocol !== 'https:' || redirect.pathname !== '/auth/meta/ms/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) throw code('MS_META_REDIRECT_INVALID', 500);
  if (!/^[a-f0-9]{64}$/i.test(env.META_TOKEN_ENCRYPTION_KEY)) throw code('MS_META_ENCRYPTION_KEY_INVALID', 500);
  if (!/^v\d+\.\d+$/.test(cfg.graphVersion)) throw code('MS_META_GRAPH_VERSION_INVALID', 500);
  if (!Number.isInteger(cfg.maxDaily) || cfg.maxDaily < 1 || cfg.maxDaily > 2) throw code('MS_META_DAILY_LIMIT_INVALID', 500);
  cfg.key = Buffer.from(env.META_TOKEN_ENCRYPTION_KEY, 'hex'); return cfg;
}
function encrypt(value, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('ms-meta-business-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function decrypt(value, key) {
  try {
    const item = JSON.parse(value), decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64'));
    if (item.v !== 1) throw new Error();
    decipher.setAAD(Buffer.from('ms-meta-business-v1')); decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw code('MS_META_STORED_CREDENTIALS_UNREADABLE'); }
}
function cookie(req) {
  const item = String(req.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`));
  return item ? item.slice(COOKIE.length + 1) : '';
}
function plain(value, max) {
  const result = String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu, '').replace(/\s+/g, ' ').trim();
  if (!result || result.length > max) throw code('MS_META_TEXT_INVALID', 400);
  return result;
}
function mediaUrl(value) {
  let u; try { u = new URL(String(value || '')); } catch { throw code('MS_META_MEDIA_URL_INVALID', 400); }
  if (u.protocol !== 'https:' || !['ms-handwerkservice.de', 'www.ms-handwerkservice.de'].includes(u.hostname) || u.username || u.password) throw code('MS_META_MEDIA_URL_INVALID', 400);
  return u.href;
}
function urlForPost(postId) { return `https://graph.facebook.com/${postId}`; }

class MsMetaPublisher {
  constructor({ env = process.env, pool, fetchImpl = global.fetch, now = Date.now } = {}) {
    this.env = env; this.pool = pool; this.fetch = fetchImpl; this.now = now; this.initialized = null; this.timer = null; this.busy = false;
  }
  cfg() { return config(this.env); }
  async ready() {
    const cfg = this.cfg(); if (cfg.missing.length) throw code('MS_META_NOT_CONFIGURED');
    if (!this.initialized) this.initialized = (async () => {
      if (!this.pool) { const { Pool } = require('pg'); this.pool = new Pool({ connectionString: this.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10000, query_timeout: 15000 }); this.pool.on('error', () => console.warn('[ms-meta-business] DATABASE_CONNECTION_ERROR')); }
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ${STATES}(state_hash text PRIMARY KEY,browser_hash text NOT NULL,expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS ${CONNECTIONS}(id text PRIMARY KEY,encrypted_credentials text NOT NULL,status text NOT NULL,checked_at timestamptz,last_error text,updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS ${POSTS}(id uuid PRIMARY KEY,channel text NOT NULL CHECK(channel IN ('facebook','instagram')),content_hash text NOT NULL,payload jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','publishing','verification_pending','published','recovery_required','failed')),remote jsonb NOT NULL DEFAULT '{}',error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,UNIQUE(channel,content_hash));`);
    })().catch(() => { this.initialized = null; throw code('MS_META_DATABASE_UNAVAILABLE'); });
    await this.initialized; return cfg;
  }
  async row() { await this.ready(); return (await this.pool.query(`SELECT * FROM ${CONNECTIONS} WHERE id='ms_handwerk'`)).rows[0] || null; }
  async credentials() { const cfg = await this.ready(), row = await this.row(); if (!row || row.status !== 'connected') throw code('MS_META_RECONNECT_REQUIRED', 409); return decrypt(row.encrypted_credentials, cfg.key); }
  async begin() {
    const cfg = await this.ready(), state = crypto.randomBytes(32).toString('base64url'), browser = crypto.randomBytes(32).toString('base64url');
    await this.pool.query(`DELETE FROM ${STATES} WHERE expires_at<=now()`);
    await this.pool.query(`INSERT INTO ${STATES}(state_hash,browser_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [digest(state), digest(browser)]);
    const url = new URL(`https://www.facebook.com/${cfg.graphVersion}/dialog/oauth`);
    for (const [k, v] of Object.entries({ client_id: cfg.appId, redirect_uri: cfg.redirectUri, response_type: 'code', state, scope: SCOPES.join(','), auth_type: 'rerequest' })) url.searchParams.set(k, v);
    return { authorizationUrl: url.href, browser };
  }
  async graph(path, { token, method = 'GET', params = {} } = {}) {
    const cfg = await this.ready(), url = new URL(`https://graph.facebook.com/${cfg.graphVersion}/${path}`), args = { ...params };
    if (token) args.appsecret_proof = crypto.createHmac('sha256', cfg.appSecret).update(token).digest('hex');
    const options = { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20000), redirect: 'error' };
    if (method === 'POST') { options.headers['Content-Type'] = 'application/x-www-form-urlencoded'; options.body = new URLSearchParams(args); }
    else for (const [k, v] of Object.entries(args)) url.searchParams.set(k, String(v));
    let response, data;
    try { response = await this.fetch(url, options); data = await response.json(); }
    catch { throw code('MS_META_NETWORK_ERROR', 502); }
    if (!response.ok || data.error) { const e = code(Number(data.error?.code) === 190 ? 'MS_META_RECONNECT_REQUIRED' : 'MS_META_REQUEST_FAILED', 502); e.metaCode = data.error?.code; throw e; }
    return data;
  }
  async exchange(codeValue, cfg) {
    const short = await this.graph('oauth/access_token', { params: { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: cfg.redirectUri, code: codeValue } });
    if (!short.access_token) throw code('MS_META_TOKEN_EXCHANGE_FAILED', 502);
    const long = await this.graph('oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: short.access_token } });
    if (!long.access_token) throw code('MS_META_TOKEN_EXCHANGE_FAILED', 502);
    return long.access_token;
  }
  async complete({ state, browser, code: codeValue, denied = false }) {
    const cfg = await this.ready();
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !/^[A-Za-z0-9_-]{43}$/.test(browser || '')) throw code('MS_META_OAUTH_STATE_INVALID', 400);
    const used = await this.pool.query(`DELETE FROM ${STATES} WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING state_hash`, [digest(state), digest(browser)]);
    if (!used.rows.length) throw code('MS_META_OAUTH_STATE_INVALID', 400);
    if (denied) throw code('MS_META_AUTHORIZATION_CANCELLED', 400);
    if (typeof codeValue !== 'string' || !codeValue || codeValue.length > 4096) throw code('MS_META_OAUTH_CODE_INVALID', 400);
    const userToken = await this.exchange(codeValue, cfg);
    const debug = await this.graph('debug_token', { token: `${cfg.appId}|${cfg.appSecret}`, params: { input_token: userToken } });
    const info = debug.data;
    if (!info?.is_valid || String(info.app_id) !== cfg.appId || SCOPES.some(scope => !info.scopes?.includes(scope))) throw code('MS_META_REQUIRED_PERMISSIONS_MISSING', 409);
    let after, page;
    for (let n = 0; n < 20; n++) {
      const result = await this.graph('me/accounts', { token: userToken, params: { fields: 'id,name,access_token,tasks,instagram_business_account', limit: 100, ...(after ? { after } : {}) } });
      const matches = (result.data || []).filter(p => String(p.name || '').trim().toLocaleLowerCase('de-DE') === 'ms handwerk & service');
      if (matches.length > 1) throw code('MS_META_PAGE_AMBIGUOUS', 409);
      if (matches.length === 1) { page = matches[0]; break; }
      after = result.paging?.cursors?.after; if (!result.paging?.next || !after) break;
    }
    if (!page?.access_token || !page.tasks?.some(t => ['CREATE_CONTENT', 'MANAGE', 'PROFILE_PLUS_CREATE_CONTENT'].includes(t))) throw code('MS_META_PAGE_NOT_GRANTED', 409);
    const credentials = { pageId: String(page.id), pageName: String(page.name), pageToken: page.access_token,
      instagramId: String(page.instagram_business_account?.id || ''), savedAt: this.now() };
    await this.pool.query(`INSERT INTO ${CONNECTIONS}(id,encrypted_credentials,status,last_error,updated_at) VALUES('ms_handwerk',$1,'connected',NULL,now()) ON CONFLICT(id) DO UPDATE SET encrypted_credentials=$1,status='connected',last_error=NULL,updated_at=now()`, [encrypt(credentials, cfg.key)]);
    return { connected: true, pageName: credentials.pageName, instagramConnected: Boolean(credentials.instagramId) };
  }
  async connectionStatus() {
    const cfg = this.cfg(); if (cfg.missing.length) return { configured: false, missing: cfg.missing, connected: false, publishingEnabled: false };
    await this.ready(); const row = await this.row();
    if (!row || row.status !== 'connected') return { configured: true, connected: false, publishingEnabled: cfg.enabled };
    const saved = decrypt(row.encrypted_credentials, cfg.key);
    return { configured: true, connected: true, pageName: saved.pageName, facebookConnected: true,
      instagramConnected: Boolean(saved.instagramId), publishingEnabled: cfg.enabled, maxDailyPerChannel: cfg.maxDaily };
  }
  async queue(draft, photoUrls = []) {
    const cfg = await this.ready(); if (!cfg.enabled) throw code('MS_META_AUTOPUBLISH_DISABLED', 409);
    const cred = await this.credentials(), text = plain(draft?.localSocial?.text, 2000), link = new URL(String(draft?.googleBusinessProfile?.link || ''));
    if (link.protocol !== 'https:' || link.hostname !== 'ms-handwerkservice.de') throw code('MS_META_POST_LINK_INVALID', 400);
    const fbLink = new URL(link.href); fbLink.searchParams.set('utm_source', 'facebook');
    const instagramCaption = plain(`${text} Weitere Informationen: https://ms-handwerkservice.de`, 2200);
    const photos = (Array.isArray(photoUrls) ? photoUrls : []).map(mediaUrl).slice(0, 5);
    const candidates = [{ channel: 'facebook', payload: { message: text, link: fbLink.href } }];
    if (cred.instagramId && photos.length) candidates.push({ channel: 'instagram', payload: { caption: instagramCaption, imageURL: photos[0] } });
    const queued = [];
    for (const item of candidates) {
      const contentHash = digest(JSON.stringify(item.payload));
      const result = await this.pool.query(`INSERT INTO ${POSTS}(id,channel,content_hash,payload,status) VALUES($1,$2,$3,$4,'queued') ON CONFLICT(channel,content_hash) DO NOTHING RETURNING id`, [crypto.randomUUID(), item.channel, contentHash, item.payload]);
      if (!result.rows[0]) throw code('MS_META_DUPLICATE_POST', 409);
      queued.push({ id: result.rows[0].id, channel: item.channel });
    }
    return { queued, instagramSkipped: !candidates.some(x => x.channel === 'instagram') ? (cred.instagramId ? 'PHOTO_REQUIRED' : 'INSTAGRAM_NOT_CONNECTED') : null, adSpendEUR: 0 };
  }
  async publish(job, credentials) {
    if (job.channel === 'facebook') {
      const created = await this.graph(`${credentials.pageId}/feed`, { token: credentials.pageToken, method: 'POST', params: job.payload });
      if (!/^\d+(?:_\d+)?$/.test(String(created.id || ''))) throw code('MS_META_PUBLISH_UNCONFIRMED', 502);
      const post = await this.graph(created.id, { token: credentials.pageToken, params: { fields: 'id,permalink_url,is_published' } });
      return { id: String(created.id), permalink: post.is_published === true && post.permalink_url ? post.permalink_url : null };
    }
    if (job.channel !== 'instagram' || !credentials.instagramId) throw code('MS_META_CHANNEL_NOT_CONNECTED', 409);
    const container = await this.graph(`${credentials.instagramId}/media`, { token: credentials.pageToken, method: 'POST', params: { image_url: job.payload.imageURL, caption: job.payload.caption } });
    if (!/^\d+$/.test(String(container.id || ''))) throw code('MS_META_CONTAINER_MISSING', 502);
    let ready = false;
    for (let i = 0; i < 20; i++) {
      const result = await this.graph(container.id, { token: credentials.pageToken, params: { fields: 'status_code' } });
      if (result.status_code === 'FINISHED') { ready = true; break; }
      if (['ERROR', 'EXPIRED'].includes(result.status_code)) throw code('MS_META_CONTAINER_FAILED', 409);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw code('MS_META_CONTAINER_PENDING', 502);
    const created = await this.graph(`${credentials.instagramId}/media_publish`, { token: credentials.pageToken, method: 'POST', params: { creation_id: container.id } });
    if (!/^\d+$/.test(String(created.id || ''))) throw code('MS_META_PUBLISH_UNCONFIRMED', 502);
    const post = await this.graph(created.id, { token: credentials.pageToken, params: { fields: 'id,permalink' } });
    return { id: String(created.id), permalink: post.permalink || null };
  }
  async tick() {
    const cfg = await this.ready(); if (!cfg.enabled) return { skipped: 'AUTOPUBLISH_DISABLED' };
    if (this.busy) return { skipped: 'WORKER_BUSY' }; this.busy = true;
    try {
      const credentials = await this.credentials(), client = await this.pool.connect(); let locked = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock(78123042) AS locked')).rows[0]?.locked;
        if (!locked) return { skipped: 'WORKER_DATABASE_LOCK_BUSY' };
        await client.query(`UPDATE ${POSTS} SET status='recovery_required',error_code='INTERRUPTED_PUBLISH',updated_at=now() WHERE status='publishing'`);
        const outcomes = [];
        for (const channel of ['facebook', 'instagram']) {
          const cap = await client.query(`SELECT count(*)::int AS n FROM ${POSTS} WHERE channel=$1 AND (status IN ('publishing','verification_pending','recovery_required') OR (status='published' AND published_at>=now()-interval '24 hours'))`, [channel]);
          if (Number(cap.rows[0]?.n || 0) >= cfg.maxDaily) { outcomes.push({ channel, skipped: 'DAILY_LIMIT' }); continue; }
          const job = (await client.query(`SELECT * FROM ${POSTS} WHERE channel=$1 AND status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [channel])).rows[0];
          if (!job) continue;
          await client.query(`UPDATE ${POSTS} SET status='publishing',updated_at=now() WHERE id=$1`, [job.id]);
          try {
            const remote = await this.publish(job, credentials);
            const confirmed = Boolean(remote.permalink);
            await client.query(`UPDATE ${POSTS} SET status=$2,remote=$3,published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,error_code=NULL,updated_at=now() WHERE id=$1`, [job.id, confirmed ? 'published' : 'verification_pending', remote]);
            outcomes.push({ channel, status: confirmed ? 'published' : 'verification_pending', permalink: remote.permalink || null });
          } catch (e) {
            const uncertain = ['MS_META_NETWORK_ERROR', 'MS_META_PUBLISH_UNCONFIRMED', 'MS_META_CONTAINER_PENDING'].includes(e.code);
            await client.query(`UPDATE ${POSTS} SET status=$2,error_code=$3,updated_at=now() WHERE id=$1`, [job.id, uncertain ? 'recovery_required' : 'failed', String(e.code || 'MS_META_PUBLISH_FAILED').slice(0, 80)]);
            outcomes.push({ channel, status: uncertain ? 'recovery_required' : 'failed' });
          }
        }
        return { outcomes, adSpendEUR: 0 };
      } finally { if (locked) await client.query('SELECT pg_advisory_unlock(78123042)').catch(() => {}); client.release(); }
    } finally { this.busy = false; }
  }
  async status() {
    const cfg = this.cfg(); if (cfg.missing.length) return { configured: false, missing: cfg.missing, connected: false, publishingEnabled: false };
    await this.ready(); const connection = await this.connectionStatus();
    const counts = (await this.pool.query(`SELECT channel,status,count(*)::int AS count FROM ${POSTS} GROUP BY channel,status`)).rows;
    return { ...connection, workerRunning: Boolean(this.timer), posts: counts, adSpendEUR: 0 };
  }
  start() {
    const cfg = this.cfg(); if (this.timer || cfg.missing.length || !cfg.enabled) return;
    this.timer = setInterval(() => void this.tick().catch(e => console.warn('[ms-meta-business] ' + JSON.stringify({ code: e.code || 'WORKER_ERROR' }))), 60000); this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

function registerMsMetaBusiness(app, { apiKey, env = process.env, pool, fetchImpl, now } = {}) {
  const publisher = new MsMetaPublisher({ env, pool, fetchImpl, now });
  const auth = apiKey || ((_req, res) => res.status(503).json({ error: 'ADMIN_AUTH_UNAVAILABLE' }));
  app.get('/ms-handwerk-meta-connect', (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`).type('html').send(`<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MS Handwerk – Meta</title><body><main><h1>MS Handwerk &amp; Service – Facebook a Instagram</h1><p>Facebook a Instagram účty MS se připojují odděleně od Homestro. Pilot zveřejňuje jen popis skutečné dokončené zakázky. Reklamy jsou vypnuté.</p><label>Soukromý klíč Pilota <input id="key" type="password" autocomplete="off"></label><button id="status">Zkontrolovat propojení</button><button id="connect">Připojit Meta</button><h2>Nová dokončená zakázka</h2><label>Služba <select id="service"><option>Innenanstrich</option><option>Spachtelarbeiten</option><option>Trockenbau-Reparaturen</option><option>Vinylboden verlegen</option><option>Laminatboden verlegen</option><option>Möbelmontage</option><option>Kleinreparaturen</option><option>Hausmeisterservice</option></select></label><label>Město <input id="city" value="Kempten" maxlength="80"></label><label>Skutečně provedené práce v němčině <textarea id="description" maxlength="1400"></textarea></label><label>Fotka na Instagram (veřejný HTTPS odkaz z ms-handwerkservice.de; nepovinné) <input id="photo" type="url"></label><button id="queue">Zařadit Facebook / Instagram</button><pre id="out"></pre></main><script nonce="${nonce}">const key=()=>document.getElementById('key').value,out=document.getElementById('out');async function call(path,method='GET',body){const r=await fetch(path,{method,credentials:'same-origin',headers:{Authorization:'Bearer '+key(),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'Požadavek se nepodařil');return d;}document.getElementById('status').onclick=async()=>{try{out.textContent=JSON.stringify(await call('/api/ms-handwerk/organic/meta/status'),null,2);}catch(e){out.textContent=e.message;}};document.getElementById('connect').onclick=async()=>{try{const d=await call('/api/ms-handwerk/organic/meta/connect','POST');location.href=d.authorizationUrl;}catch(e){out.textContent=e.message;}};document.getElementById('queue').onclick=async()=>{try{out.textContent=JSON.stringify(await call('/api/ms-handwerk/organic/meta/queue','POST',{service:document.getElementById('service').value,city:document.getElementById('city').value,projectDescription:document.getElementById('description').value,photoUrls:document.getElementById('photo').value?[document.getElementById('photo').value]:[]}),null,2);}catch(e){out.textContent=e.message;}};</script></body></html>`);
  });
  app.post('/api/ms-handwerk/organic/meta/connect', auth, async (_req, res) => {
    try { const result = await publisher.begin(); res.set('Set-Cookie', `${COOKIE}=${result.browser}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`); res.set('Cache-Control', 'no-store'); res.json({ authorizationUrl: result.authorizationUrl }); }
    catch (e) { res.status(e.status || 503).json({ error: e.code || 'MS_META_CONNECT_FAILED' }); }
  });
  app.get('/auth/meta/ms/callback', async (req, res) => {
    try {
      const result = await publisher.complete({ state: String(req.query.state || ''), browser: cookie(req), code: String(req.query.code || ''), denied: Boolean(req.query.error) });
      res.set('Set-Cookie', `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="cs"><meta charset="utf-8"><title>Meta připojeno</title><body><p>Stránka MS Handwerk &amp; Service ${result.instagramConnected ? 'a Instagram' : 'byla'} připojena. Toto okno můžete zavřít.</p></body></html>`);
    } catch (e) { res.set('Cache-Control', 'no-store').status(e.status || 400).type('text').send(`Meta propojení se nepodařilo: ${e.code || 'MS_META_CONNECT_FAILED'}`); }
  });
  app.get('/api/ms-handwerk/organic/meta/status', auth, async (_req, res) => {
    try { res.json(await publisher.status()); } catch (e) { res.status(e.status || 503).json({ error: e.code || 'MS_META_STATUS_FAILED' }); }
  });
  app.post('/api/ms-handwerk/organic/meta/queue', auth, async (req, res) => {
    try {
      const { buildDraft } = require('./ms-handwerk-organic');
      res.status(202).json(await publisher.queue(buildDraft(req.body), req.body?.photoUrls));
    } catch (e) { res.status(e.status || 400).json({ error: e.code || e.message || 'MS_META_QUEUE_FAILED' }); }
  });
  app.get('/api/ms-handwerk/organic/meta/posts', auth, async (_req, res) => {
    try { await publisher.ready(); const rows = await publisher.pool.query(`SELECT id,channel,status,remote->>'permalink' AS permalink,error_code,created_at,published_at FROM ${POSTS} ORDER BY created_at DESC LIMIT 100`); res.json({ posts: rows.rows }); }
    catch (e) { res.status(e.status || 503).json({ error: e.code || 'MS_META_POSTS_FAILED' }); }
  });
  publisher.start(); return publisher;
}

module.exports = { MsMetaPublisher, registerMsMetaBusiness, config, plain, mediaUrl };

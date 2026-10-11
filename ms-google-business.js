'use strict';

const crypto = require('node:crypto');

const COOKIE = '__Host-ms-google-business';
const STATE_TABLE = 'ms_gbp_oauth_states';
const CONNECTION_TABLE = 'ms_gbp_connections';
const POSTS_TABLE = 'ms_gbp_posts';

function error(code, status = 503) { return Object.assign(new Error(code), { code, status }); }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function cleanText(value, max, code) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > max || /<[^>]*>|[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u.test(text)) throw error(code, 400);
  return text;
}
function config(env = process.env) {
  const required = ['DATABASE_URL', 'GOOGLE_BUSINESS_CLIENT_ID', 'GOOGLE_BUSINESS_CLIENT_SECRET',
    'GOOGLE_BUSINESS_REDIRECT_URI', 'GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY'];
  const missing = required.filter(key => !String(env[key] || '').trim());
  const cfg = { missing, clientId: env.GOOGLE_BUSINESS_CLIENT_ID || '',
    clientSecret: env.GOOGLE_BUSINESS_CLIENT_SECRET || '', redirectUri: env.GOOGLE_BUSINESS_REDIRECT_URI || '',
    key: null, publishingEnabled: String(env.GOOGLE_BUSINESS_AUTOPUBLISH_ENABLED).toLowerCase() === 'true',
    location: String(env.GOOGLE_BUSINESS_LOCATION || '').trim(), maxDaily: Number(env.GOOGLE_BUSINESS_MAX_DAILY_POSTS || 1) };
  if (missing.length) return cfg;
  let redirect;
  try { redirect = new URL(cfg.redirectUri); } catch { throw error('GOOGLE_REDIRECT_INVALID', 500); }
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/auth/google/business/callback') throw error('GOOGLE_REDIRECT_INVALID', 500);
  if (!/^[a-f0-9]{64}$/i.test(env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY)) throw error('GOOGLE_ENCRYPTION_KEY_INVALID', 500);
  cfg.key = Buffer.from(env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY, 'hex');
  if (!Number.isInteger(cfg.maxDaily) || cfg.maxDaily < 1 || cfg.maxDaily > 2) throw error('GOOGLE_DAILY_LIMIT_INVALID', 500);
  if (cfg.location && !/^accounts\/\d+\/locations\/\d+$/.test(cfg.location)) throw error('GOOGLE_LOCATION_INVALID', 500);
  return cfg;
}
function encrypt(value, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('ms-google-business-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function decrypt(value, key) {
  try {
    const item = JSON.parse(value), decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64'));
    if (item.v !== 1) throw new Error();
    decipher.setAAD(Buffer.from('ms-google-business-v1')); decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw error('GOOGLE_STORED_CREDENTIALS_UNREADABLE'); }
}
function cookie(req) {
  const item = String(req.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`));
  return item ? item.slice(COOKIE.length + 1) : '';
}
function localPostUrl(location) { return `https://mybusiness.googleapis.com/v4/${location}/localPosts`; }

class GoogleBusinessPublisher {
  constructor({ env = process.env, pool, fetchImpl = global.fetch, now = Date.now } = {}) {
    this.env = env; this.pool = pool; this.fetch = fetchImpl; this.now = now; this.initialized = null; this.timer = null; this.busy = false;
  }
  cfg() { return config(this.env); }
  async ready() {
    const cfg = this.cfg();
    if (cfg.missing.length) throw error('GOOGLE_BUSINESS_NOT_CONFIGURED');
    if (!this.initialized) this.initialized = (async () => {
      if (!this.pool) {
        const { Pool } = require('pg'); this.pool = new Pool({ connectionString: this.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10000, query_timeout: 15000 });
        this.pool.on('error', () => console.warn('[ms-google-business] DATABASE_CONNECTION_ERROR'));
      }
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE}(state_hash text PRIMARY KEY,browser_hash text NOT NULL,expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS ${CONNECTION_TABLE}(id text PRIMARY KEY,encrypted_credentials text NOT NULL,status text NOT NULL,location_name text,checked_at timestamptz,last_error text,updated_at timestamptz NOT NULL DEFAULT now());
        ALTER TABLE ${CONNECTION_TABLE} ADD COLUMN IF NOT EXISTS location_name text;
        CREATE TABLE IF NOT EXISTS ${POSTS_TABLE}(id uuid PRIMARY KEY,content_hash text NOT NULL UNIQUE,payload jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','publishing','verification_pending','published','recovery_required','failed')),remote jsonb NOT NULL DEFAULT '{}',error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz);
        ALTER TABLE ${POSTS_TABLE} DROP CONSTRAINT IF EXISTS ms_gbp_posts_status_check;
        ALTER TABLE ${POSTS_TABLE} ADD CONSTRAINT ms_gbp_posts_status_check CHECK(status IN ('queued','publishing','verification_pending','published','recovery_required','failed'));`);
    })().catch(() => { this.initialized = null; throw error('GOOGLE_BUSINESS_DATABASE_UNAVAILABLE'); });
    await this.initialized; return cfg;
  }
  async connectionRow() { await this.ready(); return (await this.pool.query(`SELECT * FROM ${CONNECTION_TABLE} WHERE id='ms_handwerk'`)).rows[0] || null; }
  async targetLocation() {
    const cfg = await this.ready(), row = await this.connectionRow(), location = cfg.location || row?.location_name || '';
    if (location && !/^accounts\/\d+\/locations\/\d+$/.test(location)) throw error('GOOGLE_LOCATION_INVALID', 500);
    return location;
  }
  async credentials() {
    const cfg = await this.ready(), row = await this.connectionRow();
    if (!row || row.status !== 'connected') throw error('GOOGLE_RECONNECT_REQUIRED', 409);
    return decrypt(row.encrypted_credentials, cfg.key);
  }
  async begin() {
    const cfg = await this.ready(), state = crypto.randomBytes(32).toString('base64url'), browser = crypto.randomBytes(32).toString('base64url');
    await this.pool.query(`DELETE FROM ${STATE_TABLE} WHERE expires_at<=now()`);
    await this.pool.query(`INSERT INTO ${STATE_TABLE}(state_hash,browser_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [sha(state), sha(browser)]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [key, value] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/business.manage', access_type: 'offline', prompt: 'consent', state })) url.searchParams.set(key, value);
    return { authorizationUrl: url.href, browser };
  }
  async tokenRequest(params) {
    let response, data;
    try {
      response = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20000), redirect: 'error' });
      data = await response.json();
    } catch { throw error('GOOGLE_OAUTH_NETWORK_ERROR', 502); }
    if (!response.ok || data.error) throw error(data.error === 'invalid_grant' ? 'GOOGLE_RECONNECT_REQUIRED' : 'GOOGLE_OAUTH_EXCHANGE_FAILED', 502);
    return data;
  }
  async complete({ state, browser, code, denied = false }) {
    const cfg = await this.ready();
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !/^[A-Za-z0-9_-]{43}$/.test(browser || '')) throw error('GOOGLE_OAUTH_STATE_INVALID', 400);
    const used = await this.pool.query(`DELETE FROM ${STATE_TABLE} WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING state_hash`, [sha(state), sha(browser)]);
    if (!used.rows.length) throw error('GOOGLE_OAUTH_STATE_INVALID', 400);
    if (denied) throw error('GOOGLE_AUTHORIZATION_CANCELLED', 400);
    if (typeof code !== 'string' || !code || code.length > 4096) throw error('GOOGLE_OAUTH_CODE_INVALID', 400);
    const tokens = await this.tokenRequest({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' });
    if (!tokens.refresh_token) throw error('GOOGLE_REFRESH_TOKEN_MISSING', 409);
    const credentials = { refreshToken: tokens.refresh_token, accessToken: tokens.access_token || '', accessExpiresAt: this.now() + Number(tokens.expires_in || 0) * 1000 };
    await this.pool.query(`INSERT INTO ${CONNECTION_TABLE}(id,encrypted_credentials,status,last_error,updated_at) VALUES('ms_handwerk',$1,'connected',NULL,now()) ON CONFLICT(id) DO UPDATE SET encrypted_credentials=$1,status='connected',last_error=NULL,updated_at=now()`, [encrypt(credentials, cfg.key)]);
    return { ok: true, connected: true };
  }
  async accessToken() {
    const cfg = await this.ready(), credentials = await this.credentials();
    if (credentials.accessToken && credentials.accessExpiresAt > this.now() + 60000) return { token: credentials.accessToken, credentials };
    const tokens = await this.tokenRequest({ refresh_token: credentials.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token' });
    credentials.accessToken = tokens.access_token; credentials.accessExpiresAt = this.now() + Number(tokens.expires_in || 3600) * 1000;
    await this.pool.query(`UPDATE ${CONNECTION_TABLE} SET encrypted_credentials=$1,status='connected',checked_at=now(),last_error=NULL,updated_at=now() WHERE id='ms_handwerk'`, [encrypt(credentials, cfg.key)]);
    return { token: credentials.accessToken, credentials };
  }
  async api(url, { method = 'GET', body } = {}) {
    const { token } = await this.accessToken();
    let response, data;
    try {
      response = await this.fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000), redirect: 'error' });
      data = await response.json();
    } catch { throw error('GOOGLE_BUSINESS_RESULT_UNCERTAIN', 502); }
    if (!response.ok) {
      const e = error(response.status >= 500 ? 'GOOGLE_BUSINESS_RESULT_UNCERTAIN' : 'GOOGLE_BUSINESS_REQUEST_REJECTED', response.status >= 500 ? 502 : 409);
      e.httpStatus = response.status; throw e;
    }
    return data;
  }
  async locations() {
    const accounts = await this.api('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20');
    const result = [];
    for (const account of (accounts.accounts || []).slice(0, 20)) {
      if (!/^accounts\/\d+$/.test(String(account.name || ''))) continue;
      const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`);
      url.searchParams.set('readMask', 'name,title,websiteUri'); url.searchParams.set('pageSize', '100');
      const page = await this.api(url.href);
      for (const location of page.locations || []) {
        if (!/^locations\/\d+$/.test(String(location.name || '')) || !location.title) continue;
        if (String(location.title).trim().toLocaleLowerCase('de-DE') !== 'ms handwerk & service') continue;
        result.push({ name: `${account.name}/${location.name}`, title: String(location.title), websiteUri: location.websiteUri || null });
      }
    }
    return result;
  }
  async selectLocation(name) {
    if (!/^accounts\/\d+\/locations\/\d+$/.test(String(name || ''))) throw error('GOOGLE_LOCATION_INVALID', 400);
    const matches = await this.locations();
    if (!matches.some(x => x.name === name)) throw error('GOOGLE_LOCATION_NOT_ACCESSIBLE', 403);
    await this.ready();
    await this.pool.query(`UPDATE ${CONNECTION_TABLE} SET location_name=$1,updated_at=now() WHERE id='ms_handwerk' AND status='connected'`, [name]);
    return { selected: true, location: name };
  }
  async verifyConnection() {
    await this.ready();
    const location = await this.targetLocation();
    if (!location) throw error('GOOGLE_BUSINESS_LOCATION_REQUIRED', 409);
    const result = await this.api(`${localPostUrl(location)}?pageSize=1`);
    await this.pool.query(`UPDATE ${CONNECTION_TABLE} SET checked_at=now(),last_error=NULL,updated_at=now() WHERE id='ms_handwerk'`);
    return { ok: true, connected: true, location, existingPosts: Array.isArray(result.localPosts) ? result.localPosts.length : 0 };
  }
  async queue(draft) {
    const cfg = await this.ready();
    if (!cfg.publishingEnabled) throw error('GOOGLE_AUTOPUBLISH_DISABLED', 409);
    if (!await this.targetLocation()) throw error('GOOGLE_BUSINESS_LOCATION_REQUIRED', 409);
    await this.credentials();
    const text = cleanText(draft?.googleBusinessProfile?.text, 1500, 'INVALID_GOOGLE_POST_TEXT');
    const link = new URL(String(draft?.googleBusinessProfile?.link || ''));
    if (link.protocol !== 'https:' || link.hostname !== 'ms-handwerkservice.de' || link.username || link.password) throw error('INVALID_GOOGLE_POST_LINK', 400);
    const payload = { languageCode: 'de', summary: text, link: link.href, service: cleanText(draft.service, 80, 'INVALID_SERVICE'), city: cleanText(draft.city, 80, 'INVALID_CITY') };
    const contentHash = sha(JSON.stringify(payload));
    const result = await this.pool.query(`INSERT INTO ${POSTS_TABLE}(id,content_hash,payload,status) VALUES($1,$2,$3,'queued') ON CONFLICT(content_hash) DO NOTHING RETURNING id`, [crypto.randomUUID(), contentHash, payload]);
    if (!result.rows[0]) throw error('GOOGLE_DUPLICATE_POST', 409);
    return { queued: true, id: result.rows[0].id, adSpendEUR: 0 };
  }
  async tick() {
    const cfg = await this.ready();
    if (!cfg.publishingEnabled) return { skipped: 'AUTOPUBLISH_DISABLED' };
    const location = await this.targetLocation();
    if (!location) return { skipped: 'LOCATION_REQUIRED' };
    if (this.busy) return { skipped: 'WORKER_BUSY' };
    this.busy = true;
    try {
      const client = await this.pool.connect(); let locked = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock(78123041) AS locked')).rows[0]?.locked;
        if (!locked) return { skipped: 'WORKER_DATABASE_LOCK_BUSY' };
        await client.query(`UPDATE ${POSTS_TABLE} SET status='recovery_required',error_code='INTERRUPTED_PUBLISH',updated_at=now() WHERE status='publishing'`);
        const awaiting = (await client.query(`SELECT id,remote FROM ${POSTS_TABLE} WHERE status='verification_pending' AND remote ? 'name' ORDER BY updated_at LIMIT 5`)).rows;
        for (const item of awaiting) {
          try {
            const latest = await this.api(`https://mybusiness.googleapis.com/v4/${item.remote.name}`);
            if (latest.state === 'LIVE') await client.query(`UPDATE ${POSTS_TABLE} SET status='published',published_at=COALESCE(published_at,now()),error_code=NULL,updated_at=now() WHERE id=$1`, [item.id]);
            else if (latest.state === 'REJECTED') await client.query(`UPDATE ${POSTS_TABLE} SET status='failed',error_code='GOOGLE_POST_REJECTED',updated_at=now() WHERE id=$1`, [item.id]);
          } catch { /* Keep the remote post pending; never create a duplicate. */ }
        }
        const cap = await client.query(`SELECT count(*)::int AS n FROM ${POSTS_TABLE} WHERE status IN ('published','publishing','verification_pending','recovery_required') AND updated_at>=now()-interval '24 hours'`);
        if (Number(cap.rows[0]?.n || 0) >= cfg.maxDaily) return { skipped: 'DAILY_LIMIT' };
        const post = (await client.query(`SELECT * FROM ${POSTS_TABLE} WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
        if (!post) return { skipped: 'QUEUE_EMPTY' };
        await client.query(`UPDATE ${POSTS_TABLE} SET status='publishing',updated_at=now() WHERE id=$1`, [post.id]);
        const url = localPostUrl(location);
        try {
          const result = await this.api(url, { method: 'POST', body: { languageCode: post.payload.languageCode, summary: post.payload.summary,
            topicType: 'STANDARD', callToAction: { actionType: 'LEARN_MORE', url: post.payload.link } } });
          if (typeof result.name !== 'string' || !new RegExp(`^${location}/localPosts/[^/]+$`).test(result.name)) throw error('GOOGLE_PUBLISH_UNCONFIRMED', 502);
          const confirmed = result.state === 'LIVE';
          await client.query(`UPDATE ${POSTS_TABLE} SET status=$2,remote=$3,published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,error_code=NULL,updated_at=now() WHERE id=$1`, [post.id, confirmed ? 'published' : 'verification_pending', { name: result.name, state: result.state || null }]);
          return { published: confirmed, status: confirmed ? 'published' : 'verification_pending', id: post.id, remoteName: result.name, adSpendEUR: 0 };
        } catch (e) {
          const uncertain = e.code === 'GOOGLE_BUSINESS_RESULT_UNCERTAIN' || e.code === 'GOOGLE_PUBLISH_UNCONFIRMED';
          await client.query(`UPDATE ${POSTS_TABLE} SET status=$2,error_code=$3,updated_at=now() WHERE id=$1`, [post.id, uncertain ? 'recovery_required' : 'failed', String(e.code || 'GOOGLE_BUSINESS_REQUEST_REJECTED').slice(0, 80)]);
          return { published: false, id: post.id, status: uncertain ? 'recovery_required' : 'failed' };
        }
      } finally { if (locked) await client.query('SELECT pg_advisory_unlock(78123041)').catch(() => {}); client.release(); }
    } finally { this.busy = false; }
  }
  async status() {
    const cfg = this.cfg();
    if (cfg.missing.length) return { configured: false, missing: cfg.missing, publishingEnabled: false, adSpendEUR: 0 };
    await this.ready();
    const row = await this.connectionRow(), location = cfg.location || row?.location_name || '';
    const counts = (await this.pool.query(`SELECT status,count(*)::int AS count FROM ${POSTS_TABLE} GROUP BY status`)).rows;
    return { configured: true, connected: row?.status === 'connected', lastCheckedAt: row?.checked_at || null,
      lastError: row?.last_error || null, locationConfigured: Boolean(location), publishingEnabled: cfg.publishingEnabled,
      workerRunning: Boolean(this.timer), maxDailyPosts: cfg.maxDaily, posts: counts, adSpendEUR: 0 };
  }
  start() {
    const cfg = this.cfg();
    if (this.timer || cfg.missing.length || !cfg.publishingEnabled) return;
    this.timer = setInterval(() => void this.tick().catch(e => console.warn('[ms-google-business] ' + JSON.stringify({ code: e.code || 'WORKER_ERROR' }))), 60000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

function registerMsGoogleBusiness(app, { apiKey, buildDraft, env = process.env, pool, fetchImpl, now } = {}) {
  const publisher = new GoogleBusinessPublisher({ env, pool, fetchImpl, now });
  const auth = apiKey || ((_req, res) => res.status(503).json({ ok: false, error: 'ADMIN_AUTH_UNAVAILABLE' }));
  app.get('/ms-handwerk-google-connect', (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`).type('html').send(`<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MS Handwerk – Google</title><body><main><h1>Google Business Profile</h1><label>Soukromý klíč Pilota <input id="key" type="password" autocomplete="off"></label><button id="status">Zkontrolovat</button><button id="connect">Připojit Google</button><button id="find">Najít firemní profily</button><label>Profil <select id="location"><option value="">Nejprve najít profily</option></select></label><button id="saveLocation">Použít tento profil</button><h2>Nová dokončená zakázka</h2><label>Služba <select id="service"><option>Innenanstrich</option><option>Spachtelarbeiten</option><option>Trockenbau-Reparaturen</option><option>Vinylboden verlegen</option><option>Laminatboden verlegen</option><option>Möbelmontage</option><option>Kleinreparaturen</option><option>Hausmeisterservice</option></select></label><label>Město <input id="city" value="Kempten" maxlength="80"></label><label>Skutečně provedené práce v němčině <textarea id="description" maxlength="1400"></textarea></label><button id="queue">Zařadit k automatickému zveřejnění</button><pre id="out"></pre></main><script nonce="${nonce}">const key=()=>document.getElementById('key').value;const out=document.getElementById('out');async function call(path,method='GET',body){const r=await fetch(path,{method,credentials:'same-origin',headers:{Authorization:'Bearer '+key(),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'Nepodařilo se');return d;}document.getElementById('status').onclick=async()=>{try{out.textContent=JSON.stringify(await call('/api/ms-handwerk/organic/google/status'),null,2);}catch(e){out.textContent=e.message;}};document.getElementById('connect').onclick=async()=>{try{const d=await call('/api/ms-handwerk/organic/google/connect','POST');location.href=d.authorizationUrl;}catch(e){out.textContent=e.message;}};document.getElementById('find').onclick=async()=>{try{const d=await call('/api/ms-handwerk/organic/google/locations'),select=document.getElementById('location');select.replaceChildren(...d.locations.map(x=>{const o=document.createElement('option');o.value=x.name;o.textContent=x.title+(x.websiteUri?' · '+x.websiteUri:'');return o;}));out.textContent=d.locations.length?'Vyber profil MS Handwerk & Service.':'Google účet nevrátil žádný profil.';}catch(e){out.textContent=e.message;}};document.getElementById('saveLocation').onclick=async()=>{try{out.textContent=JSON.stringify(await call('/api/ms-handwerk/organic/google/location','POST',{location:document.getElementById('location').value}),null,2);}catch(e){out.textContent=e.message;}};document.getElementById('queue').onclick=async()=>{try{const d=await call('/api/ms-handwerk/organic/google/queue','POST',{service:document.getElementById('service').value,city:document.getElementById('city').value,projectDescription:document.getElementById('description').value});out.textContent=JSON.stringify(d,null,2);}catch(e){out.textContent=e.message;}};</script></body></html>`);
  });
  app.post('/api/ms-handwerk/organic/google/connect', auth, async (_req, res) => {
    try { const result = await publisher.begin(); res.set('Set-Cookie', `${COOKIE}=${result.browser}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`); res.set('Cache-Control', 'no-store'); res.json({ authorizationUrl: result.authorizationUrl }); }
    catch (e) { res.status(e.status || 503).json({ error: e.code || 'GOOGLE_CONNECT_FAILED' }); }
  });
  app.get('/auth/google/business/callback', async (req, res) => {
    try {
      await publisher.complete({ state: String(req.query.state || ''), browser: cookie(req), code: String(req.query.code || ''), denied: Boolean(req.query.error) });
      res.set('Set-Cookie', `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`).set('Cache-Control', 'no-store').type('html').send('<!doctype html><html lang="cs"><meta charset="utf-8"><title>Google připojeno</title><body><p>Google účet byl připojen. Toto okno můžete zavřít.</p></body></html>');
    } catch (e) { res.set('Cache-Control', 'no-store').status(e.status || 400).type('text').send(`Google propojení se nepodařilo: ${e.code || 'GOOGLE_CONNECT_FAILED'}`); }
  });
  app.get('/api/ms-handwerk/organic/google/status', auth, async (_req, res) => {
    try { res.json(await publisher.status()); } catch (e) { res.status(e.status || 503).json({ error: e.code || 'GOOGLE_STATUS_FAILED' }); }
  });
  app.get('/api/ms-handwerk/organic/google/check', auth, async (_req, res) => {
    try { res.json(await publisher.verifyConnection()); } catch (e) { res.status(e.status || 503).json({ ok: false, error: e.code || 'GOOGLE_CHECK_FAILED' }); }
  });
  app.get('/api/ms-handwerk/organic/google/locations', auth, async (_req, res) => {
    try { res.json({ locations: await publisher.locations() }); } catch (e) { res.status(e.status || 503).json({ error: e.code || 'GOOGLE_LOCATIONS_FAILED' }); }
  });
  app.post('/api/ms-handwerk/organic/google/location', auth, async (req, res) => {
    try { res.json(await publisher.selectLocation(String(req.body?.location || ''))); } catch (e) { res.status(e.status || 400).json({ error: e.code || 'GOOGLE_LOCATION_FAILED' }); }
  });
  app.post('/api/ms-handwerk/organic/google/queue', auth, async (req, res) => {
    try { if (typeof buildDraft !== 'function') throw error('DRAFT_BUILDER_UNAVAILABLE'); const draft = buildDraft(req.body); res.status(202).json(await publisher.queue(draft)); }
    catch (e) { res.status(e.status || 400).json({ error: e.code || e.message || 'GOOGLE_QUEUE_FAILED' }); }
  });
  app.get('/api/ms-handwerk/organic/google/posts', auth, async (_req, res) => {
    try { await publisher.ready(); const rows = await publisher.pool.query(`SELECT id,payload->>'service' AS service,payload->>'city' AS city,status,remote->>'name' AS remote_name,error_code,created_at,published_at FROM ${POSTS_TABLE} ORDER BY created_at DESC LIMIT 100`); res.json({ posts: rows.rows }); }
    catch (e) { res.status(e.status || 503).json({ error: e.code || 'GOOGLE_POSTS_FAILED' }); }
  });
  publisher.start();
  return publisher;
}

module.exports = { GoogleBusinessPublisher, registerMsGoogleBusiness, config, cleanText, localPostUrl };

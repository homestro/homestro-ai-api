'use strict';

const {randomBytes,createHash,createHmac,createCipheriv,createDecipheriv,timingSafeEqual}=require('node:crypto');
const SCOPES=['pages_show_list','pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish'];
const COOKIE='__Host-homestro-meta';
const digest=s=>createHash('sha256').update(String(s)).digest('hex');
function failure(code,status=503){return Object.assign(new Error(code),{code,status});}
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
function settings(env){
  const required=['DATABASE_URL','META_APP_ID','META_APP_SECRET','META_TOKEN_ENCRYPTION_KEY','META_OAUTH_REDIRECT_URI','META_PAGE_ID','META_INSTAGRAM_ACCOUNT_ID'];
  const missing=required.filter(k=>!String(env[k]||'').trim());
  const cfg={missing,appId:env.META_APP_ID,appSecret:env.META_APP_SECRET,pageId:env.META_PAGE_ID,instagramId:env.META_INSTAGRAM_ACCOUNT_ID,
    redirectUri:env.META_OAUTH_REDIRECT_URI,graphVersion:env.META_GRAPH_VERSION||'v26.0',key:null};
  if(missing.length)return cfg;
  const u=new URL(cfg.redirectUri);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/auth/meta/callback')throw failure('META_REDIRECT_INVALID');
  if(!/^v\d+\.\d+$/.test(cfg.graphVersion)||![cfg.appId,cfg.pageId,cfg.instagramId].every(x=>/^\d+$/.test(x)))throw failure('META_ACCOUNT_CONFIG_INVALID');
  if(!/^[a-f0-9]{64}$/i.test(env.META_TOKEN_ENCRYPTION_KEY))throw failure('META_ENCRYPTION_KEY_INVALID');
  cfg.key=Buffer.from(env.META_TOKEN_ENCRYPTION_KEY,'hex');
  return cfg;
}
function encrypt(value,key){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('homestro-meta-v1'));
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});}
function decrypt(value,key){try{const d=JSON.parse(value);if(d.v!==1)throw Error();const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(d.iv,'base64'));
  cipher.setAAD(Buffer.from('homestro-meta-v1'));cipher.setAuthTag(Buffer.from(d.tag,'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(d.data,'base64')),cipher.final()]).toString('utf8'));}catch{throw failure('META_STORED_CREDENTIALS_UNREADABLE');}}
function expiry(seconds){return Number(seconds)>0?new Date(Number(seconds)*1000).toISOString():null;}
function expired(row,now=Date.now()){return [row.expires_at,row.data_access_expires_at].some(v=>v&&new Date(v).getTime()<=now);}
function cookieValue(req){const s=String(req.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));return s?s.slice(COOKIE.length+1):'';}
function safePage(res,text,status=200){res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});
  return res.status(status).type('html').send('<!doctype html><html lang="de"><meta charset="utf-8"><title>Homestro Verbindung</title><body><h1>Homestro</h1><p>'+text+'</p><p>Dieses Fenster kann geschlossen werden.</p></body></html>');}

class MetaConnection {
  constructor({env=process.env,pool,fetchImpl=global.fetch,now=Date.now}={}){this.env=env;this.pool=pool;this.fetch=fetchImpl;this.now=now;this.initialized=null;this.timer=null;}
  cfg(){return settings(this.env);}
  async ready(){
    const cfg=this.cfg();if(cfg.missing.length)throw failure('META_OAUTH_NOT_CONFIGURED');
    if(!this.initialized)this.initialized=(async()=>{
      if(!this.pool){const {Pool}=require('pg');this.pool=new Pool({connectionString:this.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,query_timeout:15000});
        this.pool.on('error',()=>console.warn('[meta-connection] DATABASE_CONNECTION_ERROR'));}
      await this.pool.query(`CREATE TABLE IF NOT EXISTS meta_oauth_states(state_hash text PRIMARY KEY,browser_hash text NOT NULL,expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS meta_connections(id text PRIMARY KEY,encrypted_credentials text NOT NULL,status text NOT NULL,
        expires_at timestamptz,data_access_expires_at timestamptz,checked_at timestamptz,last_error text,revision text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());`);
    })().catch(()=>{this.initialized=null;throw failure('META_CONNECTION_DATABASE_UNAVAILABLE');});
    await this.initialized;return cfg;
  }
  async row(){await this.ready();return (await this.pool.query("SELECT * FROM meta_connections WHERE id='homestro'")).rows[0]||null;}
  async graph(path,{token,params={},method='GET'}={}){
    const cfg=this.cfg(),u=new URL(`https://graph.facebook.com/${cfg.graphVersion}/${path}`);
    const args={...params};if(token)args.appsecret_proof=createHmac('sha256',cfg.appSecret).update(token).digest('hex');
    const opts={method,headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(20000),redirect:'error'};
    if(method==='POST'){opts.headers['Content-Type']='application/x-www-form-urlencoded';opts.body=new URLSearchParams(args);}
    else for(const [k,v] of Object.entries(args))u.searchParams.set(k,String(v));
    let r,d;try{r=await this.fetch(u,opts);d=await r.json();}catch{throw failure('META_CONNECTION_NETWORK_ERROR',502);}
    if(!r.ok||d.error){const e=failure(Number(d.error?.code)===190?'META_REAUTH_REQUIRED':'META_CONNECTION_REQUEST_FAILED',502);e.metaCode=d.error?.code;throw e;}
    return d;
  }
  async debug(token){const cfg=this.cfg();return (await this.graph('debug_token',{token:cfg.appId+'|'+cfg.appSecret,params:{input_token:token}})).data;}
  validateDebug(data,{scopes=false}={}){
    const cfg=this.cfg();if(!data?.is_valid||String(data.app_id)!==cfg.appId)throw failure('META_REAUTH_REQUIRED',409);
    if(expired({expires_at:expiry(data.expires_at),data_access_expires_at:expiry(data.data_access_expires_at)},this.now()))throw failure('META_REAUTH_REQUIRED',409);
    if(scopes&&SCOPES.some(s=>!data.scopes?.includes(s)))throw failure('META_REQUIRED_PERMISSIONS_MISSING',409);
  }
  async begin(){const cfg=await this.ready(),state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url');
    await this.pool.query('DELETE FROM meta_oauth_states WHERE expires_at<=now()');
    await this.pool.query("INSERT INTO meta_oauth_states(state_hash,browser_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')",[digest(state),digest(browser)]);
    const u=new URL(`https://www.facebook.com/${cfg.graphVersion}/dialog/oauth`);
    for(const [k,v] of Object.entries({client_id:cfg.appId,redirect_uri:cfg.redirectUri,response_type:'code',state,scope:SCOPES.join(','),auth_type:'rerequest'}))u.searchParams.set(k,v);
    return {authorizationUrl:u.href,browser};
  }
  async complete({state,browser,code,denied=false}){
    const cfg=await this.ready();if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!/^[A-Za-z0-9_-]{43}$/.test(browser))throw failure('META_OAUTH_STATE_INVALID',400);
    const used=await this.pool.query('DELETE FROM meta_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING state_hash',[digest(state),digest(browser)]);
    if(!used.rows.length)throw failure('META_OAUTH_STATE_INVALID',400);
    if(denied)throw failure('META_AUTHORIZATION_CANCELLED',400);
    if(typeof code!=='string'||!code||code.length>4096)throw failure('META_OAUTH_CODE_INVALID',400);
    const short=await this.graph('oauth/access_token',{params:{client_id:cfg.appId,client_secret:cfg.appSecret,redirect_uri:cfg.redirectUri,code}});
    if(!short.access_token)throw failure('META_OAUTH_EXCHANGE_FAILED',502);
    const long=await this.graph('oauth/access_token',{params:{grant_type:'fb_exchange_token',client_id:cfg.appId,client_secret:cfg.appSecret,fb_exchange_token:short.access_token}});
    if(!long.access_token)throw failure('META_OAUTH_EXCHANGE_FAILED',502);
    const user=await this.debug(long.access_token);this.validateDebug(user,{scopes:true});
    if(!/^\d+$/.test(String(user.user_id||'')))throw failure('META_USER_ID_MISSING',409);
    // The user token is only used during this callback; persist the derived Page credential.
    let after,page;
    for(let n=0;n<20;n++){
      const result=await this.graph('me/accounts',{token:long.access_token,params:{fields:'id,access_token,tasks,instagram_business_account',limit:100,...(after?{after}:{})}});
      page=result.data?.find(p=>String(p.id)===cfg.pageId);if(page)break;
      after=result.paging?.cursors?.after;if(!result.paging?.next||!after)break;
    }
    if(!page?.access_token||String(page.instagram_business_account?.id)!==cfg.instagramId)throw failure('META_CONFIGURED_ACCOUNTS_NOT_GRANTED',409);
    if(!page.tasks?.some(t=>['CREATE_CONTENT','MANAGE','PROFILE_PLUS_CREATE_CONTENT'].includes(t)))throw failure('META_PAGE_PUBLISH_TASK_MISSING',409);
    const info=await this.graph(cfg.pageId,{token:page.access_token,params:{fields:'id,instagram_business_account'}});
    if(String(info.id)!==cfg.pageId||String(info.instagram_business_account?.id)!==cfg.instagramId)throw failure('META_ACCOUNT_MISMATCH',409);
    const ig=await this.graph(cfg.instagramId,{token:page.access_token,params:{fields:'id'}});
    if(String(ig.id)!==cfg.instagramId)throw failure('META_ACCOUNT_MISMATCH',409);
    const data=await this.debug(page.access_token);this.validateDebug(data,{scopes:true});
    if(data.type!=='PAGE'||(data.profile_id&&String(data.profile_id)!==cfg.pageId))throw failure('META_PAGE_TOKEN_REQUIRED',409);
    const encrypted=encrypt({token:page.access_token,pageId:cfg.pageId,instagramId:cfg.instagramId,userId:String(user.user_id||'')},cfg.key);
    await this.pool.query(`INSERT INTO meta_connections(id,encrypted_credentials,status,expires_at,data_access_expires_at,checked_at,last_error,revision)
      VALUES('homestro',$1,'connected',$2,$3,now(),NULL,$4) ON CONFLICT(id) DO UPDATE SET encrypted_credentials=$1,status='connected',
      expires_at=$2,data_access_expires_at=$3,checked_at=now(),last_error=NULL,revision=$4,updated_at=now()`,[encrypted,expiry(data.expires_at),expiry(data.data_access_expires_at),randomBytes(16).toString('hex')]);
    return {connected:true};
  }
  async credentials(){
    const cfg=this.cfg();
    // Explicit legacy fallback until OAuth is configured; never fall back after a stored connection is invalidated.
    if(cfg.missing.length){
      if(['META_APP_ID','META_APP_SECRET','META_TOKEN_ENCRYPTION_KEY','META_OAUTH_REDIRECT_URI'].some(k=>this.env[k]))throw failure('META_OAUTH_NOT_CONFIGURED');
      return {token:this.env.META_PAGE_ACCESS_TOKEN||'',pageId:this.env.META_PAGE_ID||'',instagramId:this.env.META_INSTAGRAM_ACCOUNT_ID||''};
    }
    const row=await this.row();if(!row)return {token:this.env.META_PAGE_ACCESS_TOKEN||'',pageId:cfg.pageId,instagramId:cfg.instagramId};
    if(row.status!=='connected'||expired(row,this.now()))throw failure('META_REAUTH_REQUIRED',409);
    const c=decrypt(row.encrypted_credentials,cfg.key);
    if(c.pageId!==cfg.pageId||c.instagramId!==cfg.instagramId)throw failure('META_ACCOUNT_MISMATCH',409);
    return {...c,revision:row.revision,appsecretProof:createHmac('sha256',cfg.appSecret).update(c.token).digest('hex')};
  }
  async reject(error,credentials){if(Number(error?.metaCode??error?.code)!==190||!credentials?.revision)return;
    await this.pool.query("UPDATE meta_connections SET status='reauth_required',last_error='META_REAUTH_REQUIRED',updated_at=now() WHERE id='homestro' AND revision=$1",[credentials.revision]);}
  async check(){const row=await this.row();if(!row)return this.status();if(row.status!=='connected')return this.status();
    const cfg=this.cfg();try{const c=decrypt(row.encrypted_credentials,cfg.key),d=await this.debug(c.token);this.validateDebug(d,{scopes:true});
      const page=await this.graph(cfg.pageId,{token:c.token,params:{fields:'id,instagram_business_account'}});
      if(String(page.id)!==cfg.pageId||String(page.instagram_business_account?.id)!==cfg.instagramId)throw failure('META_ACCOUNT_MISMATCH',409);
      await this.pool.query("UPDATE meta_connections SET expires_at=$1,data_access_expires_at=$2,checked_at=now(),last_error=NULL WHERE id='homestro' AND revision=$3",[expiry(d.expires_at),expiry(d.data_access_expires_at),row.revision]);
    }catch(e){const reauth=['META_REAUTH_REQUIRED','META_REQUIRED_PERMISSIONS_MISSING','META_ACCOUNT_MISMATCH'].includes(e.code);
      await this.pool.query("UPDATE meta_connections SET status=$1,checked_at=now(),last_error=$2 WHERE id='homestro' AND revision=$3",[reauth?'reauth_required':'connected',e.code||'META_CONNECTION_CHECK_FAILED',row.revision]);}
    return this.status();
  }
  async status(){const cfg=this.cfg();if(cfg.missing.length)return {configured:false,state:'setup_required',missing:cfg.missing,manualTokenCopyRequired:false};
    const r=await this.row();if(!r)return {configured:true,state:'not_connected',manualTokenCopyRequired:false};
    const dates=[r.expires_at,r.data_access_expires_at].filter(Boolean).map(v=>new Date(v).getTime());
    const due=dates.length?new Date(Math.min(...dates)).toISOString():null;
    return {configured:true,state:expired(r,this.now())?'reauth_required':r.last_error&&r.status==='connected'?'check_failed':r.status,
      expiresAt:r.expires_at,dataAccessExpiresAt:r.data_access_expires_at,reauthorizeBefore:due,
      expiringSoon:dates.some(v=>v-this.now()<7*86400000),checkedAt:r.checked_at,lastError:r.last_error,
      manualTokenCopyRequired:false};
  }
  async deauthorize(signed){const cfg=await this.ready();if(typeof signed!=='string'||signed.length>16384)throw failure('META_SIGNATURE_INVALID',400);
    const [sig,body,...rest]=signed.split('.');if(!sig||!body||rest.length)throw failure('META_SIGNATURE_INVALID',400);
    const expected=createHmac('sha256',cfg.appSecret).update(body).digest('base64url');if(!equal(sig,expected))throw failure('META_SIGNATURE_INVALID',400);
    let p;try{p=JSON.parse(Buffer.from(body,'base64url').toString());}catch{throw failure('META_SIGNATURE_INVALID',400);}
    if(p.algorithm!=='HMAC-SHA256'||!p.user_id)throw failure('META_SIGNATURE_INVALID',400);
    const row=await this.row();if(row&&decrypt(row.encrypted_credentials,cfg.key).userId===String(p.user_id))
      await this.pool.query("UPDATE meta_connections SET status='reauth_required',last_error='META_ACCESS_REVOKED' WHERE id='homestro' AND revision=$1",[row.revision]);
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>void this.check().catch(()=>console.warn('[meta-connection] CHECK_UNAVAILABLE')),6*3600000);this.timer.unref();
    if(!this.cfg().missing.length)void this.check().catch(()=>console.warn('[meta-connection] CHECK_UNAVAILABLE'));}
  async stop(){clearInterval(this.timer);this.timer=null;await this.pool?.end?.();}
}

function registerMetaConnection(app,apiKey,options={}){
  const connection=new MetaConnection(options);
  const privateResponse=(res)=>res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  const route=f=>async(req,res)=>{privateResponse(res);try{await f(req,res);}catch(e){res.status(e.status||503).json({ok:false,error:e.code||'META_CONNECTION_UNAVAILABLE'});}};
  app.get('/api/connections/meta',apiKey,route(async(_q,res)=>res.json(await connection.status())));
  app.post('/api/connections/meta/check',apiKey,route(async(_q,res)=>res.json(await connection.check())));
  app.post('/api/connections/meta/start',apiKey,route(async(_q,res)=>{const r=await connection.begin();
    res.cookie(COOKIE,r.browser,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600000});res.json({authorizationUrl:r.authorizationUrl});}));
  app.get('/auth/meta/callback',async(req,res)=>{privateResponse(res);const browser=cookieValue(req);
    res.clearCookie(COOKIE,{httpOnly:true,secure:true,sameSite:'lax',path:'/'});
    try{await connection.complete({state:String(req.query.state||''),browser,code:req.query.code,denied:Boolean(req.query.error)});
      safePage(res,'Facebook und Instagram sind verbunden. Der Pilot verwendet den gespeicherten Zugang automatisch.');}
    catch(e){safePage(res,'Verbindung nicht abgeschlossen. Bitte im Homestro-Verbindungsfenster erneut verbinden.',e.status||503);}
  });
  // Signed Meta callback: no bearer key; the application signature is mandatory.
  const express=require('express');
  app.post('/auth/meta/deauthorize',express.urlencoded({extended:false,limit:'20kb'}),route(async(req,res)=>{await connection.deauthorize(req.body?.signed_request);res.json({ok:true});}));
  app.get('/connect/meta',(_req,res)=>{const nonce=randomBytes(18).toString('base64');
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`});
    res.type('html').send(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Homestro verbinden</title><style>body{font:18px system-ui;max-width:600px;margin:50px auto;padding:20px}input,button{font:inherit;padding:12px;margin:8px 0;width:100%;box-sizing:border-box}button{background:#155f4a;color:white;border:0;border-radius:8px}pre{white-space:pre-wrap;font:inherit}</style><h1>Facebook und Instagram verbinden</h1><p>Einmal anmelden und den Zugriff bestätigen. Homestro speichert den Zugang. Bei aufgehobenem Zugriff kannst du dich hier erneut anmelden.</p><label>Homestro Administrator-Schlüssel<input id="key" type="password" autocomplete="off"></label><button id="status">Verbindung prüfen</button><button id="connect">Facebook und Instagram verbinden</button><pre id="message" aria-live="polite"></pre><script nonce="${nonce}">const key=document.getElementById('key'),message=document.getElementById('message');async function call(path,method){const response=await fetch(path,{method,headers:{Authorization:'Bearer '+key.value},credentials:'same-origin'});const result=await response.json();if(!response.ok)throw Error('Verbindung konnte nicht geprüft werden. Bitte Administrator-Schlüssel und Einrichtung prüfen.');return result;}document.getElementById('status').onclick=async()=>{try{const r=await call('/api/connections/meta','GET');const labels={connected:'Verbunden',setup_required:'Einrichtung noch nicht abgeschlossen',not_connected:'Noch nicht verbunden',reauth_required:'Bitte erneut verbinden',check_failed:'Prüfung vorübergehend fehlgeschlagen'};message.textContent=labels[r.state]||'Verbindungsstatus unbekannt';if(r.expiringSoon)message.textContent+=' — Bitte Zugang bald erneut bestätigen.';}catch(e){message.textContent=e.message;}};document.getElementById('connect').onclick=async()=>{try{const r=await call('/api/connections/meta/start','POST');key.value='';location.assign(r.authorizationUrl);}catch(e){message.textContent=e.message;}};</script></html>`);
  });
  try{connection.start();}catch{console.warn('[meta-connection] SETUP_INVALID');}
  process.once('SIGTERM',()=>void connection.stop());return connection;
}
module.exports={MetaConnection,registerMetaConnection,settings,encrypt,decrypt,SCOPES,expired};

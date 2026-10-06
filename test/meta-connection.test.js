'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHmac}=require('node:crypto');
const {MetaConnection,encrypt,decrypt,SCOPES}=require('../meta-connection');
const {publishOrganicDraft}=require('../meta-organic');
const env={DATABASE_URL:'postgres://test',META_APP_ID:'123',META_APP_SECRET:'secret',META_TOKEN_ENCRYPTION_KEY:'ab'.repeat(32),META_OAUTH_REDIRECT_URI:'https://homestro.example/auth/meta/callback',META_PAGE_ID:'456',META_INSTAGRAM_ACCOUNT_ID:'789',META_PAGE_ACCESS_TOKEN:'expired-legacy'};
function database(){let row=null;const states=new Map();return {get row(){return row;},set row(v){row=v;},states,async query(sql,p=[]){
  if(sql.startsWith('CREATE TABLE'))return {rows:[]};
  if(sql.startsWith('INSERT INTO meta_oauth_states')){states.set(p[0],{browser:p[1]});return {rows:[]};}
  if(sql.startsWith('DELETE FROM meta_oauth_states WHERE expires'))return {rows:[]};
  if(sql.startsWith('DELETE FROM meta_oauth_states WHERE state_hash')){const v=states.get(p[0]);if(!v||v.browser!==p[1])return {rows:[]};states.delete(p[0]);return {rows:[{state_hash:p[0]}]};}
  if(sql.startsWith('SELECT * FROM meta_connections'))return {rows:row?[row]:[]};
  if(sql.startsWith('INSERT INTO meta_connections')){row={encrypted_credentials:p[0],status:'connected',expires_at:p[1],data_access_expires_at:p[2],revision:p[3],checked_at:new Date(),last_error:null};return {rows:[]};}
  if(sql.includes("SET status='reauth_required'")){if(row?.revision===p[0]){row.status='reauth_required';row.last_error='META_REAUTH_REQUIRED';}return {rows:[]};}
  if(sql.includes('SET status=$1')){if(row?.revision===p[2]){row.status=p[0];row.last_error=p[1];}return {rows:[]};}
  if(sql.includes('SET expires_at=$1')){if(row?.revision===p[2]){row.expires_at=p[0];row.data_access_expires_at=p[1];row.last_error=null;}return {rows:[]};}
  throw Error('Unexpected SQL: '+sql);
}};}
const response=(data,ok=true)=>({ok,status:ok?200:400,json:async()=>data});
function fixture({wrongApp=false,missingScope=false,wrongPage=false}={}){
  const pool=database(),calls=[];const fetchImpl=async(url,opts)=>{calls.push({url:String(url),opts});const u=new URL(url),path=u.pathname.split('/').slice(2).join('/');
    if(path==='oauth/access_token')return response({access_token:u.searchParams.has('code')?'short-user':'long-user'});
    if(path==='debug_token'){const token=u.searchParams.get('input_token');return response({data:{is_valid:true,app_id:wrongApp?'999':'123',user_id:'42',type:token==='page-secret'?'PAGE':'USER',profile_id:token==='page-secret'?'456':undefined,scopes:missingScope?SCOPES.filter(s=>s!=='pages_manage_posts'):SCOPES,expires_at:0,data_access_expires_at:0}});}
    if(path==='me/accounts')return response({data:[{id:wrongPage?'111':'456',access_token:'page-secret',tasks:['CREATE_CONTENT'],instagram_business_account:{id:'789'}}]});
    if(path==='456')return response({id:'456',instagram_business_account:{id:'789'}});
    if(path==='789')return response({id:'789'});
    throw Error('Unexpected Graph path: '+path);
  };return {connection:new MetaConnection({env,pool,fetchImpl}),pool,calls};
}
async function connected(f){const start=await f.connection.begin();await f.connection.complete({state:new URL(start.authorizationUrl).searchParams.get('state'),browser:start.browser,code:'code'});return f;}
test('OAuth derives and encrypts Page access; status never exposes secrets',async()=>{
  const f=await connected(fixture());assert.equal(f.pool.row.status,'connected');assert(!f.pool.row.encrypted_credentials.includes('page-secret'));
  const c=await f.connection.credentials();assert.equal(c.token,'page-secret');assert.equal(c.pageId,'456');assert.equal(c.instagramId,'789');assert(c.appsecretProof);
  assert(!JSON.stringify(await f.connection.status()).includes('page-secret'));assert.equal(f.calls.filter(c=>c.url.includes('/oauth/access_token')).length,2);
});
test('a restarted process reloads stored access',async()=>{const f=await connected(fixture());assert.equal((await new MetaConnection({env,pool:f.pool}).credentials()).token,'page-secret');});
test('OAuth state is browser-bound and single-use',async()=>{
  const f=fixture(),s=await f.connection.begin(),state=new URL(s.authorizationUrl).searchParams.get('state');
  await assert.rejects(f.connection.complete({state,browser:'x'.repeat(43),code:'code'}),{code:'META_OAUTH_STATE_INVALID'});assert.equal(f.calls.length,0);
  await f.connection.complete({state,browser:s.browser,code:'code'});await assert.rejects(f.connection.complete({state,browser:s.browser,code:'code'}),{code:'META_OAUTH_STATE_INVALID'});
});
test('cancelled authorization preserves the existing connection',async()=>{
  const f=await connected(fixture()),revision=f.pool.row.revision,s=await f.connection.begin();
  await assert.rejects(f.connection.complete({state:new URL(s.authorizationUrl).searchParams.get('state'),browser:s.browser,denied:true}),{code:'META_AUTHORIZATION_CANCELLED'});assert.equal(f.pool.row.revision,revision);
});
for(const [option,code]of [['wrongApp','META_REAUTH_REQUIRED'],['missingScope','META_REQUIRED_PERMISSIONS_MISSING'],['wrongPage','META_CONFIGURED_ACCOUNTS_NOT_GRANTED']])test('rejects '+option+' before saving',async()=>{
  const f=fixture({[option]:true}),s=await f.connection.begin();await assert.rejects(f.connection.complete({state:new URL(s.authorizationUrl).searchParams.get('state'),browser:s.browser,code:'code'}),{code});assert.equal(f.pool.row,null);
});
test('expired access never falls back to the old environment token',async()=>{
  const f=await connected(fixture());f.pool.row.data_access_expires_at='2000-01-01T00:00:00Z';await assert.rejects(f.connection.credentials(),{code:'META_REAUTH_REQUIRED'});assert.equal((await f.connection.status()).state,'reauth_required');
});
test('an old rejected request cannot invalidate a newly connected revision',async()=>{
  const f=await connected(fixture()),old=await f.connection.credentials();await connected(f);await f.connection.reject({metaCode:190},old);assert.equal(f.pool.row.status,'connected');
  await f.connection.reject({metaCode:190},await f.connection.credentials());await assert.rejects(f.connection.credentials(),{code:'META_REAUTH_REQUIRED'});
});
test('network failures report degraded checks without erasing access',async()=>{
  const f=await connected(fixture());f.connection.fetch=async()=>{throw Error('network');};assert.equal((await f.connection.check()).state,'check_failed');assert.equal((await f.connection.credentials()).token,'page-secret');
});
test('tampered ciphertext and a changed encryption key fail closed',()=>{
  const key=Buffer.from('ab'.repeat(32),'hex'),c=encrypt({token:'secret'},key),d=JSON.parse(c);d.data=Buffer.from('bad').toString('base64');
  assert.throws(()=>decrypt(JSON.stringify(d),key),{code:'META_STORED_CREDENTIALS_UNREADABLE'});assert.throws(()=>decrypt(c,Buffer.alloc(32)),{code:'META_STORED_CREDENTIALS_UNREADABLE'});
});
test('deauthorization requires the app signature and matching user',async()=>{
  const f=await connected(fixture()),b=Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',user_id:'42'})).toString('base64url');
  await assert.rejects(f.connection.deauthorize('invalid.'+b),{code:'META_SIGNATURE_INVALID'});assert.equal(f.pool.row.status,'connected');
  await f.connection.deauthorize(createHmac('sha256',env.META_APP_SECRET).update(b).digest('base64url')+'.'+b);assert.equal(f.pool.row.status,'reauth_required');
});
test('partial OAuth configuration prevents a legacy fallback',async()=>{await assert.rejects(new MetaConnection({env:{META_APP_ID:'123',META_PAGE_ACCESS_TOKEN:'legacy'}}).credentials(),{code:'META_OAUTH_NOT_CONFIGURED'});});
test('legacy publisher consumes stored access and never retries a rejected write',async()=>{
  const f=await connected(fixture());let writes=0;
  await assert.rejects(publishOrganicDraft({channel:'facebook',imageUrl:'https://cdn.shopify.com/image.jpg',caption:'Test'},
    {env,getCredentials:()=>f.connection.credentials(),onCredentialError:(e,c)=>f.connection.reject(e,c),fetchImpl:async(_u,opts)=>{writes++;assert.equal(opts.headers.Authorization,'Bearer page-secret');return response({error:{code:190,error_subcode:463}},false);}}));
  assert.equal(writes,1);assert.equal(f.pool.row.status,'reauth_required');
});
test('Pilot v2 resolves stored access and stops after revocation',async()=>{
  const {MetaOrganic}=await import('../homestro-marketing-pilot/modules/meta.js'),f=await connected(fixture());
  const cfg={pageId:'456',instagramId:'789',graphVersion:'v26.0',token:'old',getCredentials:()=>f.connection.credentials(),onCredentialError:(e,c)=>f.connection.reject(e,c)};
  let calls=0;const meta=new MetaOrganic(cfg,async(_u,opts)=>{calls++;assert.equal(opts.headers.Authorization,'Bearer page-secret');return response({error:{code:190}},false);});
  await assert.rejects(meta.verifyConnection(),{code:'META_REAUTH_REQUIRED'});await assert.rejects(meta.verifyConnection(),{code:'META_REAUTH_REQUIRED'});assert.equal(calls,1);
});
test('connect routes protect setup, bind the callback cookie, and emit valid browser code',async()=>{
  const Module=require('node:module'),vm=require('node:vm'),{registerMetaConnection}=require('../meta-connection'),f=fixture(),routes=new Map();
  const app={get:(path,...handlers)=>routes.set('GET '+path,handlers),post:(path,...handlers)=>routes.set('POST '+path,handlers)};
  const auth=(req,res,next)=>req.get('authorization')==='Bearer admin'?next():res.status(401).json({error:'Unauthorized'});
  // Only the registration-time body-parser dependency is stubbed. Route handlers and OAuth flow are real.
  const old=Module._load;let connection;
  try{Module._load=function(id,...args){if(id==='express')return {urlencoded:()=> (_q,_r,next)=>next()};return old.call(this,id,...args);};
    connection=registerMetaConnection(app,auth,{env,pool:f.pool,fetchImpl:f.connection.fetch});}finally{Module._load=old;}
  async function run(method,path,{headers={},query={}}={}){
    const res={code:200,headers:{},cookieValue:null,status(n){this.code=n;return this;},set(h){Object.assign(this.headers,h);return this;},type(){return this;},json(b){this.body=b;return this;},send(b){this.body=b;return this;},cookie(name,value,options){this.cookieValue={name,value,options};return this;},clearCookie(){return this;}};
    const req={get:k=>headers[k],query};const handlers=routes.get(method+' '+path);let n=0;
    async function next(){if(n<handlers.length)await handlers[n++](req,res,next);}await next();return res;
  }
  try{
    assert.equal((await run('POST','/api/connections/meta/start')).code,401);
    const start=await run('POST','/api/connections/meta/start',{headers:{authorization:'Bearer admin'}});
    assert.equal(start.cookieValue.options.secure,true);assert.equal(start.cookieValue.options.httpOnly,true);assert.equal(start.cookieValue.options.sameSite,'lax');
    const callback=await run('GET','/auth/meta/callback',{headers:{cookie:start.cookieValue.name+'='+start.cookieValue.value},query:{code:'code',state:new URL(start.body.authorizationUrl).searchParams.get('state')}});
    assert.equal(callback.code,200);assert.equal(f.pool.row.status,'connected');assert(!callback.body.includes('page-secret'));
    const ui=await run('GET','/connect/meta');assert(ui.headers['Content-Security-Policy'].includes('nonce-'));const script=ui.body.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];new vm.Script(script);
    assert(!script.includes('localStorage'));assert(!script.includes('sessionStorage'));
  }finally{await connection.stop();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runTikTokRecoveryProbe} from '../modules/tiktok-recovery-probe.js';
import {providerDiagnostics} from '../modules/provider-diagnostics.js';
import {PilotError} from '../modules/core.js';
const now=new Date('2026-10-14T08:00:00Z'),id='probe-job';
function fixture({age=1,keyBad=false,changed=false,existing=false,lookupBad=false,reject=false}={}) {
 let probed=false,writes=0,reads=0,settled=0;
 const job={id,product_id:'p',attempted_at:new Date(now-age*3600000).toISOString(),
   approved_by:'owner',approved_at:now.toISOString(),payload:{productRevision:'r'},
   remote:{phase:'zernio_submit_intent',idempotencyKey:keyBad?'bad':createHash('sha256').update('homestro:zernio:'+id).digest('hex')}};
 const client={release(){},query:async sql=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.startsWith('SELECT *'))return {rows:probed?[]:[job]};
   if(sql.startsWith('SELECT count'))return {rows:[{n:1}]};
   if(sql.startsWith('UPDATE')){probed=true;return {rows:[{id}],rowCount:1};}
   return {rows:[]};
 }};
 const social={pool:{connect:async()=>client},cfg:{workerEnabled:true,publishingEnabled:true,organicPolicy:'balanced-v1'},
   providerCfg:{publishingEnabled:true,accounts:{tiktok:'a'.repeat(24)}},
   freshSnapshot:async()=>({status:'ACTIVE',contentReviewed:true,revision:changed?'changed':'r',variants:[{available:true,price:20}]}),
   checkpoint:async()=>{},settle:async()=>{settled++;},
   provider:{buildRequest(){},request:async()=>{reads++;return lookupBad?{}:{posts:existing?[{_id:'b'.repeat(24),metadata:{pilotPostId:id}}]:[]};},
     reconcile:async()=>({status:'published',permalink:'https://www.tiktok.com/@homestroo/video/123'}),
     submit:async j=>{writes++;assert.equal(j.id,id);if(reject)throw Object.assign(new PilotError('ZERNIO_POST_CREATE_HTTP_400'),{diagnostic:providerDiagnostics({type:'invalid_request_error',code:'invalid_field_value',param:'tiktokSettings.media_type'})});return {status:'verification_pending',permalink:null};}}};
 return {social,get writes(){return writes;},get reads(){return reads;},get settled(){return settled;}};
}
test('existing remote post reconciles without another provider write',async()=>{
 const f=fixture({existing:true});assert.equal((await runTikTokRecoveryProbe(f.social,now,now,'a'.repeat(24))).status,'published');
 assert.equal(f.writes,0);assert.equal(f.settled,1);
});
test('one explicitly selected recent 400 uses the same job once within the replay window',async()=>{
 const f=fixture();await runTikTokRecoveryProbe(f.social,now,now,'a'.repeat(24));await runTikTokRecoveryProbe(f.social,now,now,'a'.repeat(24));
 assert.equal(f.writes,1);assert.equal(f.reads,1);assert.equal(f.settled,1);
});
test('old intent, wrong key, changed source or malformed lookup never trigger a write',async()=>{
 for(const opts of [{age:13},{keyBad:true},{changed:true},{lookupBad:true}]) {
   const f=fixture(opts);assert.equal((await runTikTokRecoveryProbe(f.social,now,now,'a'.repeat(24))).status,'unconfirmed');assert.equal(f.writes,0);
 }
});
test('definite rejection is diagnosed once and never becomes a successful publication',async()=>{
 const f=fixture({reject:true});const result=await runTikTokRecoveryProbe(f.social,now,now,'a'.repeat(24));
 assert.equal(result.reason,'ZERNIO_POST_CREATE_HTTP_400');assert.equal(f.settled,0);
 await runTikTokRecoveryProbe(f.social,now,now,'a'.repeat(24));assert.equal(f.writes,1);
});
test('diagnostics never include provider text, secrets, URLs or arbitrary field names',()=>{
 const d=providerDiagnostics({type:'platform_error',code:'platform_api_error',error:'Missing permission reconnect secret-token https://secret.example',param:'https://secret.example',platformError:{code:400}});
 assert.equal(d.category,'PERMISSION_REQUIRED');assert.equal(d.param,null);
 assert.ok(!JSON.stringify(d).includes('secret'));assert.equal(d.upstreamCode,400);
 const field=providerDiagnostics({type:'invalid_request_error',code:'invalid_field_value',param:'platforms[0].platformSpecificData.tiktokSettings.media_type'});
 assert.equal(field.providerCode,'invalid_field_value');assert.equal(field.param,'platforms[0].platformSpecificData.tiktokSettings.media_type');
});

test('changed provider account never replays the historical request',async()=>{
 const f=fixture();const result=await runTikTokRecoveryProbe(f.social,now,now,'c'.repeat(24));
 assert.equal(result.reason,'RECOVERY_ACCOUNT_UNCONFIRMED');assert.equal(f.writes,0);assert.equal(f.reads,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MediaRenderer} from '../modules/media.js';
import {openAiHealth,recordOpenAiFailure} from '../modules/openai-health.js';
const selected={images:['https://cdn.shopify.com/p.jpg'],videoURL:null};
const p={id:'p',localized:{title:'Produkt',description:'Aufbewahrung',hook:'Ordnung im Alltag',benefits:[{text:'Für die Aufbewahrung'}]}};
test('video auth failure records sanitized operation and survives renderer/process restart without another request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pilot-health-'));let calls=0;
 try{
  const cfg={dataDir:dir,openaiApiKey:'secret-that-must-not-be-stored',videoDailyLimit:2,
   fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{code:'invalid_api_key',message:'private provider text and secret-that-must-not-be-stored'}}),{status:401});}};
  await assert.rejects(()=>new MediaRenderer(cfg).aiReel(p,selected),{code:'OPENAI_AUTH_FAILED'});
  const restarted={...cfg};delete restarted._openaiBlockedUntil;delete restarted._openaiBlockedReason;
  await assert.rejects(()=>new MediaRenderer(restarted).aiReel(p,selected),{code:'OPENAI_AUTH_FAILED'});
  assert.equal(calls,1);
  const status=await openAiHealth(restarted);assert.equal(status.httpStatus,401);assert.equal(status.providerCode,'invalid_api_key');assert.equal(status.operation,'script');
  const disk=await readFile(join(dir,'provider-state/openai.json'),'utf8');
  assert.equal(disk.includes(cfg.openaiApiKey),false);assert.equal(disk.includes('private provider'),false);
  assert.equal((await openAiHealth({...cfg,openaiApiKey:'already-rotated-by-owner'})).status,'unverified');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('permission failures and quota are distinct from invalid API keys; no body or token appears in diagnostics',async()=>{
 for(const [http,code,reason] of [[403,'insufficient_permissions','OPENAI_AUTH_FAILED'],[429,'insufficient_quota','OPENAI_QUOTA_EXCEEDED'],[429,'rate_limit_exceeded','OPENAI_RATE_LIMIT']]){
  const cfg={openaiApiKey:'test'};
  assert.equal(await recordOpenAiFailure(new Response(JSON.stringify({error:{code}}),{status:http}),cfg,'speech'),reason);
  assert.equal(cfg._openaiBlockedReason,reason);
 }
});

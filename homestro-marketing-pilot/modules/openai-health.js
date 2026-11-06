import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash,fail} from './core.js';

// Persist only bounded diagnostic enums. Never persist keys, provider bodies or prompts.
const errorCodes=new Set(['invalid_api_key','insufficient_permissions','permission_denied','model_not_found','insufficient_quota','rate_limit_exceeded','organization_deactivated','project_not_found']);
const statePath=cfg=>join(cfg.dataDir,'provider-state','openai.json');
const identity=cfg=>hash({key:cfg.openaiApiKey||'',script:cfg.videoScriptModel||'gpt-4o-mini',speech:cfg.videoTtsModel||'gpt-4o-mini-tts'});
export async function openAiHealth(cfg,now=Date.now()){
  let state=null;
  if(cfg.dataDir)try{state=JSON.parse(await readFile(statePath(cfg),'utf8'));}catch(e){if(e.code!=='ENOENT')fail('OPENAI_DIAGNOSTIC_STATE_UNREADABLE');}
  const same=state?.identity===identity(cfg);
  return {configured:Boolean(cfg.openaiApiKey),status:!cfg.openaiApiKey?'not_configured':same&&state.blockedUntil>now?'blocked':same?'retry_due':'unverified',
    operation:same?state.operation:null,httpStatus:same?state.httpStatus:null,providerCode:same?state.providerCode:null,
    reason:same?state.reason:null,blockedUntil:same?new Date(state.blockedUntil).toISOString():null,
    checkedAt:same?state.checkedAt:null,diagnosticOnly:true,generationPerformed:false};
}
export async function assertOpenAiHealth(cfg){
  const health=await openAiHealth(cfg);
  if(health.status==='blocked')fail(health.reason);
  // Preserve callers without persistent storage, including isolated media tests.
  if((!cfg._openaiBlockedIdentity||cfg._openaiBlockedIdentity===identity(cfg))&&Number(cfg._openaiBlockedUntil||0)>Date.now())fail(cfg._openaiBlockedReason||'OPENAI_RATE_LIMIT');
}
export async function recordOpenAiFailure(response,cfg,operation){
  let code='unclassified';
  try{const data=await response.clone().json();if(errorCodes.has(data?.error?.code))code=data.error.code;}catch{}
  const reason=response.status===401||response.status===403?'OPENAI_AUTH_FAILED':
    code==='insufficient_quota'?'OPENAI_QUOTA_EXCEEDED':response.status===429?'OPENAI_RATE_LIMIT':'OPENAI_API_FAILED';
  const retry=Number(response.headers.get('retry-after'));
  const seconds=reason==='OPENAI_RATE_LIMIT'?Math.min(Math.max(Number.isFinite(retry)&&retry>0?retry:3600,60),86400):86400;
  const state={identity:identity(cfg),operation:['script','speech'].includes(operation)?operation:'unknown',
    httpStatus:response.status,providerCode:code,reason,checkedAt:new Date().toISOString(),blockedUntil:Date.now()+seconds*1000};
  cfg._openaiBlockedIdentity=state.identity;cfg._openaiBlockedReason=reason;cfg._openaiBlockedUntil=state.blockedUntil;
  if(cfg.dataDir){
    const path=statePath(cfg);await mkdir(join(cfg.dataDir,'provider-state'),{recursive:true});
    const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path);
  }
  return reason;
}

// Non-generating provider diagnosis. Model-read access does not prove TTS-write entitlement.
export async function checkOpenAiAccess(cfg,fetchImpl=fetch){
  if(!cfg.openaiApiKey)return {status:'not_configured',generationPerformed:false};
  const results=[];
  for(const [operation,model] of [['script',cfg.videoScriptModel||'gpt-4o-mini'],['speech',cfg.videoTtsModel||'gpt-4o-mini-tts']]){
    if(!/^[a-zA-Z0-9._-]{1,100}$/.test(model))fail('OPENAI_MODEL_ID_INVALID');
    const reply=await fetchImpl('https://api.openai.com/v1/models/'+model,{method:'GET',redirect:'error',
      headers:{Authorization:'Bearer '+cfg.openaiApiKey},signal:AbortSignal.timeout(15000)});
    if(!reply.ok){const reason=await recordOpenAiFailure(reply,cfg,operation);results.push({operation,httpStatus:reply.status,reason});break;}
    results.push({operation,httpStatus:reply.status,modelReadAccessible:true});
  }
  return {status:results.every(r=>r.modelReadAccessible)?'model_read_access_verified':'blocked',results,
    health:await openAiHealth(cfg),ttsWritePermissionVerified:false,generationPerformed:false};
}

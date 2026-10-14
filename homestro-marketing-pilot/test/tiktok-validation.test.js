import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTikTokFailure} from '../modules/tiktok-validation.js';
import {providerDiagnostics} from '../modules/provider-diagnostics.js';
import {ZernioOrganic} from '../modules/zernio.js';
test('failed payload validation uses only the documented non-publishing endpoint',async()=>{
 const account='a'.repeat(24),id='12e3a630-4f0c-4135-bc67-ff4378aa9c14';let calls=0;
 const social={providerCfg:{accounts:{tiktok:account}},pool:{query:async()=>({rows:[{channel:'tiktok'}]})},
   provider:{buildRequest:()=>({content:'Produkt',platforms:[{platform:'tiktok'}]}),request:async(path,options)=>{
     calls++;assert.equal(path,'tools/validate/post');assert.equal(options.method,'POST');
     return {valid:false,errors:[{error:'Missing required photo media type'}]};
   }}};
 assert.equal((await validateTikTokFailure(social,id,account)).valid,false);assert.equal(calls,1);
 await validateTikTokFailure(social,id,'b'.repeat(24));assert.equal(calls,1);
});
test('nested legacy errors expose only fixed vocabulary, never raw values',()=>{
 const d=providerDiagnostics({errors:[{error:'Invalid photo media type for private-alice-42 https://secret.example/api?token=secret'}]});
 assert.equal(d.category,'MEDIA_VALIDATION');assert.deepEqual(d.words,['invalid','photo','media','type']);
 assert.ok(!JSON.stringify(d).includes('alice'));assert.ok(!JSON.stringify(d).includes('secret'));
});
test('validation endpoint is allowlisted without granting access to ads or other tools',async()=>{
 const api=new ZernioOrganic({apiKey:'test-key'},async()=>({ok:true,status:200,json:async()=>({valid:true})}));
 assert.equal((await api.request('tools/validate/post',{method:'POST',body:{platforms:[]}})).valid,true);
 await assert.rejects(api.request('tools/ads'),{code:'NON_ORGANIC_ENDPOINT_BLOCKED'});
});

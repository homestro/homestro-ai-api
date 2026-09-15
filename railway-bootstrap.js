const fs=require('fs');
const {spawn}=require('child_process');
const https=require('https');
const RAW='https://raw.githubusercontent.com/homestro/homestro-ai-api/main/patch-json-safe.js';
function get(url){return new Promise((resolve,reject)=>https.get(url,{headers:{'User-Agent':'Homestro-Railway'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>r.statusCode>=200&&r.statusCode<300?resolve(d):reject(new Error('HTTP '+r.statusCode)));}).on('error',reject));}
(async()=>{
 console.log('HOMESTRO BOOTSTRAP START');
 const patch=await get(RAW);
 fs.writeFileSync('patch-json-safe.js',patch);
 console.log('HOMESTRO JSON SAFE PATCH FETCHED '+patch.length);
 require('./patch-autopilot.js');
 require('./patch-cost-rules.js');
 require('./patch-shopify-auth.js');
 require('./patch-json-safe.js');
 console.log('HOMESTRO PATCHES COMPLETE');
 const child=spawn(process.execPath,['./server.js'],{stdio:'inherit'});
 child.on('exit',code=>process.exit(code??0));
})().catch(e=>{console.error('HOMESTRO BOOTSTRAP FAILED',e);process.exit(1);});

const fs=require('fs');
const {spawn}=require('child_process');
const https=require('https');
const BASE='https://raw.githubusercontent.com/homestro/homestro-ai-api/main/';
const FILES=['server.js','patch-autopilot.js','patch-shopify-auth.js','patch-json-safe.js'];
function get(url){return new Promise((resolve,reject)=>https.get(url,{headers:{'User-Agent':'Homestro-Railway'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>r.statusCode>=200&&r.statusCode<300?resolve(d):reject(new Error('HTTP '+r.statusCode+' for '+url)));}).on('error',reject));}
(async()=>{
 console.log('HOMESTRO BOOTSTRAP START v3');
 for(const f of FILES){const content=await get(BASE+f);fs.writeFileSync(f,content);console.log('HOMESTRO FILE REFRESHED '+f+' '+content.length);}
 require('./patch-autopilot.js');
 require('./patch-shopify-auth.js');
 require('./patch-json-safe.js');
 console.log('HOMESTRO PATCHES COMPLETE v3');
 const child=spawn(process.execPath,['./server.js'],{stdio:'inherit'});
 child.on('exit',code=>process.exit(code??0));
})().catch(e=>{console.error('HOMESTRO BOOTSTRAP FAILED',e);process.exit(1);});

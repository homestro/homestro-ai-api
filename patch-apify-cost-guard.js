const fs=require('fs');
const path='server.js';
let s=fs.readFileSync(path,'utf8');
if(s.includes('HOMESTRO_APIFY_COST_GUARD_V1')){
  console.log('Apify cost guard already present');
  process.exit(0);
}
const needle='async function apifyRunActor(actorId,input,{timeoutMs=90000}={}){';
if(!s.includes(needle)) throw new Error('apifyRunActor target not found');
const guarded=`// HOMESTRO_APIFY_COST_GUARD_V1\nconst homestroApifyGuard={windowStart:0,calls:0,cache:new Map()};\nfunction homestroApifyGuardConfig(){\n const max=Math.max(1,Number(process.env.HOMESTRO_APIFY_MAX_RUNS_PER_HOUR||4));\n const ttl=Math.max(60000,Number(process.env.HOMESTRO_APIFY_CACHE_TTL_MS||21600000));\n return {max,ttl};\n}\nasync function apifyRunActor(actorId,input,{timeoutMs=90000}={}){\n const guardCfg=homestroApifyGuardConfig();\n const now=Date.now();\n if(!homestroApifyGuard.windowStart||now-homestroApifyGuard.windowStart>=3600000){homestroApifyGuard.windowStart=now;homestroApifyGuard.calls=0;}\n const cacheKey=String(actorId)+'|'+crypto.createHash('sha1').update(JSON.stringify(input||{})).digest('hex');\n const cachedRun=homestroApifyGuard.cache.get(cacheKey);\n if(cachedRun&&now-cachedRun.at<guardCfg.ttl){console.log('HOMESTRO_APIFY_CACHE_HIT',String(actorId));return cachedRun.rows;}\n if(homestroApifyGuard.calls>=guardCfg.max){console.warn('HOMESTRO_APIFY_BUDGET_BLOCK','maxRunsPerHour='+guardCfg.max,'actor='+String(actorId));return [];}\n homestroApifyGuard.calls++;\n console.log('HOMESTRO_APIFY_BUDGET_USE','run='+homestroApifyGuard.calls+'/'+guardCfg.max,'actor='+String(actorId));`;
s=s.replace(needle,guarded);
const ret='return Array.isArray(data)?data:[];';
if(!s.includes(ret)) throw new Error('Apify dataset return target not found');
s=s.replace(ret,"const rows=Array.isArray(data)?data:[]; homestroApifyGuard.cache.set(cacheKey,{at:Date.now(),rows}); return rows;");
fs.writeFileSync(path,s);
console.log('Applied HOMESTRO_APIFY_COST_GUARD_V1');
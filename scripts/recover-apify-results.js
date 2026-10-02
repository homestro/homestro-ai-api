// Recover already-paid Apify results without starting any Actor runs.
// Uses Apify REST list-runs + dataset-items GET endpoints only.
// Usage: APIFY_API_TOKEN=... node scripts/recover-apify-results.js
const fs=require('fs');
const token=String(process.env.APIFY_API_TOKEN||'').trim();
const actorId=String(process.env.APIFY_ALIEXPRESS_ACTOR_ID||'').trim();
if(!token||!actorId){console.error('Missing APIFY_API_TOKEN or APIFY_ALIEXPRESS_ACTOR_ID');process.exit(2)}
const base='https://api.apify.com/v2';
const auth=u=>`${u}${u.includes('?')?'&':'?'}token=${encodeURIComponent(token)}`;
async function json(url){const r=await fetch(auth(url));if(!r.ok)throw new Error(`${r.status} ${await r.text()}`);return r.json()}
function key(x){return String(x.productId||x.itemId||x.id||x.url||x.productUrl||x.title||'').trim().toLowerCase()}
(async()=>{
 const allRuns=[];let offset=0;
 while(true){const d=await json(`${base}/acts/${encodeURIComponent(actorId)}/runs?status=SUCCEEDED&limit=100&offset=${offset}&desc=1`);const items=d?.data?.items||[];allRuns.push(...items);if(items.length<100)break;offset+=items.length}
 const recovered=[];
 for(const run of allRuns){const ds=run.defaultDatasetId;if(!ds)continue;const d=await json(`${base}/datasets/${encodeURIComponent(ds)}/items?clean=true&format=json`);if(Array.isArray(d))for(const item of d)recovered.push({...item,_apifyRunId:run.id,_apifyDatasetId:ds})}
 const seen=new Set(),unique=[];for(const x of recovered){const k=key(x);if(!k||seen.has(k))continue;seen.add(k);unique.push(x)}
 fs.mkdirSync('data',{recursive:true});fs.writeFileSync('data/apify-recovered.json',JSON.stringify(unique,null,2));
 console.log(JSON.stringify({ok:true,paidActorRunsStarted:0,runsRead:allRuns.length,itemsRecovered:recovered.length,uniqueItems:unique.length,output:'data/apify-recovered.json'},null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});

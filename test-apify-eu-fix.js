const fs=require('fs');
const p=fs.readFileSync('patch-autopilot-quality.js','utf8');
if(!p.includes("countryPattern='Germany|Deutschland|Poland|Polen")) throw new Error('EU country warehouse patch missing');
if(!p.includes('HOMESTRO_APIFY_WAREHOUSE_UNMATCHED')) throw new Error('Apify warehouse diagnostics missing');
console.log('Apify EU warehouse patch smoke test passed');

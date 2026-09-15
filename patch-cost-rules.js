const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
if(s.includes('// HOMESTRO_COST_RULES_DYNAMIC')){console.log('dynamic cost rules already installed');process.exit(0);}
const oldFn='function autopilotQualification(product){const variants=';
if(!s.includes(oldFn)) throw new Error('autopilotQualification not found');
s=s.replace(oldFn,'// HOMESTRO_COST_RULES_DYNAMIC\nfunction autopilotQualification(product){const r=rules();const variants=');
const old='cost<=12&&ratio>=3';
if(!s.includes(old)) throw new Error('hardcoded qualification rule not found');
s=s.replace(old,'cost<=r.maxCost&&price>=r.minSellingPrice&&ratio>=r.minRatio');
fs.writeFileSync(p,s);
console.log('dynamic cost rules installed');

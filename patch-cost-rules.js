const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
if(s.includes('// HOMESTRO_COST_RULES_DYNAMIC')){console.log('dynamic cost rules already installed');process.exit(0);}
const fn=s.indexOf('function autopilotQualification(');
if(fn<0){console.log('autopilotQualification not present; dynamic rules patch skipped safely');process.exit(0);}
const brace=s.indexOf('{',fn);
if(brace<0){console.log('autopilotQualification malformed; dynamic rules patch skipped safely');process.exit(0);}
s=s.slice(0,fn)+'// HOMESTRO_COST_RULES_DYNAMIC\n'+s.slice(fn);
s=s.replace('cost<=12&&ratio>=3','cost<=Number(process.env.MAX_PRODUCT_COST||15)&&price>=Number(process.env.MIN_SELLING_PRICE||29)&&ratio>=Number(process.env.MIN_PRICE_COST_RATIO||3)');
fs.writeFileSync(p,s);
console.log('dynamic cost rules installed safely');

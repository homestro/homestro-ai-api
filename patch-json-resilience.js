const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
// Replace the entire cleanJson implementation regardless of prior formatting.
s=s.replace(/function cleanJson\(t\)\{[\s\S]*?\}\nasync function aiProduct/,"function cleanJson(t){let x=String(t||'').trim().replace(/^```(?:json)?\\s*/i,'').replace(/\\s*```$/i,'').trim();const a=x.indexOf('{'),b=x.lastIndexOf('}');if(a>=0&&b>a)x=x.slice(a,b+1);return JSON.parse(x);}\nasync function aiProduct");
// Force structured JSON and enough output room for the product editor response.
s=s.replace(/max_output_tokens:1800\}/,"max_output_tokens:3000,text:{format:{type:'json_object'}}}");
fs.writeFileSync(p,s);
console.log('AI JSON resilience installed');

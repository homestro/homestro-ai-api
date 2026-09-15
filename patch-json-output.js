const fs=require('fs');
const p='server.js';
console.log('JSON PATCH: starting');
let s=fs.readFileSync(p,'utf8');
const start=s.indexOf('function cleanJson(');
const end=s.indexOf("app.post('/api/ai/product'",start);
if(start<0||end<0)throw new Error('AI product block not found');
const replacement=`function cleanJson(t){const raw=String(t||'').trim().replace(/^\\x60\\x60\\x60(?:json)?\\s*/i,'').replace(/\\s*\\x60\\x60\\x60$/i,'').trim();return JSON.parse(raw);}
async function aiProduct(input){if(!process.env.OPENAI_API_KEY)throw Object.assign(new Error('OPENAI_API_KEY is not configured.'),{status:503});const model=process.env.OPENAI_MODEL||'gpt-5-mini';const system='Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Erstelle hochwertige, ehrliche Produktdaten auf Deutsch. Keine erfundenen technischen Daten, Zertifikate, Garantien, Lieferzeiten, Bewertungen oder Verkaufszahlen. Verwende nur Informationen aus dem Produktinput. Schreibe kompakt. Ausgabe ausschließlich gemäß dem vorgegebenen JSON-Schema.';const schema={type:'object',additionalProperties:false,properties:{title:{type:'string'},description:{type:'string'},shortDescription:{type:'string'},bullets:{type:'array',items:{type:'string'},maxItems:5},seoTitle:{type:'string'},seoDescription:{type:'string'},handle:{type:'string'},tags:{type:'array',items:{type:'string'},maxItems:8},category:{type:'string'}},required:['title','description','shortDescription','bullets','seoTitle','seoDescription','handle','tags','category']};const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:'Verarbeite dieses Produkt:\\n'+JSON.stringify(input,null,2)}]}],text:{format:{type:'json_schema',name:'homestro_product',strict:true,schema}},max_output_tokens:3000})});const d=await r.json();if(!r.ok)throw Object.assign(new Error(d?.error?.message||'OpenAI request failed'),{status:502});const text=d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'';if(!text)throw Object.assign(new Error('OpenAI returned empty structured output'),{status:502});return{model,product:cleanJson(text)};}
`;
s=s.slice(0,start)+replacement+s.slice(end);
fs.writeFileSync(p,s);
console.log('JSON PATCH: installed v3');

const fs=require('fs');
const p='server.js';
console.log('JSON SAFE PATCH: starting v6');
let s=fs.readFileSync(p,'utf8');
const start=s.indexOf('function cleanJson(');
const end=s.indexOf("app.post('/api/ai/product'",start);
if(start<0||end<0)throw new Error('AI product block not found');
const replacement=`function cleanJson(t){const raw=String(t||'').trim().replace(/^\\x60\\x60\\x60(?:json)?\\s*/i,'').replace(/\\s*\\x60\\x60\\x60$/i,'').trim();try{return JSON.parse(raw)}catch(e){throw Object.assign(new Error('Structured JSON invalid: '+e.message),{status:502,code:'AI_JSON_INVALID',rawLength:raw.length})}}
async function aiProduct(input){
 if(!process.env.OPENAI_API_KEY)throw Object.assign(new Error('OPENAI_API_KEY is not configured.'),{status:503});
 const model=process.env.OPENAI_MODEL||'gpt-5-mini';
 const schema={type:'object',additionalProperties:false,properties:{title:{type:'string'},description:{type:'string'},shortDescription:{type:'string'},bullets:{type:'array',items:{type:'string'},maxItems:5},seoTitle:{type:'string'},seoDescription:{type:'string'},handle:{type:'string'},tags:{type:'array',items:{type:'string'},maxItems:8},category:{type:'string'}},required:['title','description','shortDescription','bullets','seoTitle','seoDescription','handle','tags','category']};
 const system='Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Erstelle hochwertige, ehrliche Produktdaten auf Deutsch. Keine erfundenen technischen Daten, Zertifikate, Garantien, Lieferzeiten, Bewertungen oder Verkaufszahlen. Verwende ausschließlich Informationen aus dem Produktinput. Halte description und shortDescription kompakt. Ausgabe ausschließlich gemäß JSON-Schema, ohne Markdown.';
 const request=async(extra='')=>{const body={model,input:[{role:'system',content:[{type:'input_text',text:system+extra}]},{role:'user',content:[{type:'input_text',text:'Verarbeite dieses Produkt. Alle JSON-Strings müssen vollständig geschlossen sein.\\n'+JSON.stringify(input)}]}],text:{format:{type:'json_schema',name:'homestro_product',strict:true,schema}},max_output_tokens:3500};const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Object.assign(new Error(d?.error?.message||'OpenAI request failed'),{status:502});const text=d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'';if(!text)throw Object.assign(new Error('OpenAI returned empty structured output'),{status:502});return text;};
 let lastErr=null;
 for(let attempt=1;attempt<=3;attempt++){try{const text=await request(attempt===1?'':'\\nPrevious generation was invalid. Regenerate the complete object from scratch. Keep every field concise and valid JSON.');return{model,product:cleanJson(text)}}catch(e){lastErr=e;console.error('AI structured JSON attempt failed',attempt,e.message);if(attempt<3)await new Promise(r=>setTimeout(r,800*attempt));}}
 throw Object.assign(new Error('AI structured JSON failed after 3 attempts: '+(lastErr?.message||'invalid JSON')),{status:502});}
`;
s=s.slice(0,start)+replacement+s.slice(end);
fs.writeFileSync(p,s);
console.log('JSON SAFE PATCH: installed v6');

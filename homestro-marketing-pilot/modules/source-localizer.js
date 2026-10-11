import {fail,log} from './core.js';
import {validateLocalized} from './localization.js';

const clean=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').replace(/\s+/g,' ').trim();

// Zero API spend: assemble a German marketing draft from the shop's source facts.
// This prepares copy; it does not certify supplier facts or grant media rights.
export const sourceLooksGerman=source=>/\b(?:der|die|das|für|mit|und|aus|zum|zur|ein|eine|im|auf|oder|dein|deine|vier|zwei)\b/i.test(source);
const safeCode=value=>typeof value==='string' && /^[A-Za-z0-9_.-]{1,60}$/.test(value)?value:undefined;
export function createSourceLocalizer({apiKey,model='gpt-4o-mini',fetchImpl=fetch}={}) {
  // A rejected key is an environment fault, not a product fault. Stop sending one
  // identical request per product until the service restarts with corrected config.
  let apiKeyRejected=false;
  const fromGermanSource=({title,description,facts})=>{
    const source=clean(title)+' '+clean(description)+' '+facts.map(f=>clean(f.text)).join(' ');
    if(!sourceLooksGerman(source))fail('GERMAN_TRANSLATION_REQUIRED');
    const selected=facts.map(f=>({id:String(f.id),text:clean(f.text).slice(0,300)}))
      .filter(f=>f.id && f.text).slice(0,10);
    return validateLocalized({language:'de',title:clean(title).slice(0,150),description:clean(description),
      hook:clean(title).slice(0,100),searchTitle:clean(title).slice(0,150),seoTitle:clean(title).slice(0,70),
      seoDescription:clean(description).slice(0,160),
      benefits:selected.slice(0,3).map(f=>({factId:f.id,text:f.text}))},facts);
  };
  return async ({title,description,facts=[]})=>{
    const t=clean(title),d=clean(description);
    if(!t || !d || !facts.length)fail('SOURCE_COPY_REQUIRED');
    const selected=facts.map(f=>({id:String(f.id),text:clean(f.text).slice(0,300)}))
      .filter(f=>f.id && f.text).slice(0,10);
    if(!selected.length)fail('SOURCE_COPY_REQUIRED');
    if(!apiKey || apiKeyRejected)return fromGermanSource({title:t,description:d,facts:selected});
    const response=await fetchImpl('https://api.openai.com/v1/chat/completions',{
      method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model,temperature:0.2,max_completion_tokens:1000,response_format:{type:'json_object'},
        messages:[
          {role:'system',content:'You write accurate native German ecommerce copy. Use only facts supplied by the user. Do not invent specifications, materials, quantities, safety claims, certifications, shipping promises, discounts, ratings, or guarantees. Translate source facts into German and keep every benefit tied to an input fact id. Return a JSON object with language, title, description, hook, searchTitle, seoTitle, seoDescription, and benefits [{factId,text}]. No HTML, emoji, or hashtags.'},
          {role:'user',content:JSON.stringify({title:t.slice(0,500),description:d.slice(0,5000),facts:selected})}
        ]}),
      signal:AbortSignal.timeout(30000)
    });
    if(!response.ok){
      let providerError={};try{providerError=(await response.json())?.error||{};}catch{}
      log('LOCALIZATION_PROVIDER_ERROR',{status:response.status,type:safeCode(providerError.type),providerCode:safeCode(providerError.code),providerParam:safeCode(providerError.param)});
      if(response.status===401){
        apiKeyRejected=true;
        log('LOCALIZATION_PROVIDER_DISABLED',{reason:'HTTP_401'});
        return fromGermanSource({title:t,description:d,facts:selected});
      }
      fail('LOCALIZATION_PROVIDER_FAILED');
    }
    let body;
    try{body=await response.json();}catch{log('LOCALIZATION_PROVIDER_ERROR',{status:response.status,stage:'INVALID_JSON'});fail('LOCALIZATION_PROVIDER_FAILED');}
    let copy;
    try{copy=JSON.parse(body.choices?.[0]?.message?.content||'');}catch{log('LOCALIZATION_PROVIDER_ERROR',{status:response.status,stage:'INVALID_COMPLETION_JSON'});fail('LOCALIZATION_PROVIDER_FAILED');}
    return validateLocalized(copy,facts);
  };
}

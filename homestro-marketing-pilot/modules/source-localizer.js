import {fail} from './core.js';
import {validateLocalized} from './localization.js';

const clean=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').replace(/\s+/g,' ').trim();

// Zero API spend: assemble a German marketing draft from the shop's source facts.
// This prepares copy; it does not certify supplier facts or grant media rights.
export const sourceLooksGerman=source=>/\b(?:der|die|das|für|mit|und|aus|zum|zur|ein|eine|im|auf|oder|dein|deine|vier|zwei)\b/i.test(source);
export function createSourceLocalizer() {
  return async ({title,description,facts=[]})=>{
    const t=clean(title),d=clean(description);
    if(!t || !d || !facts.length)fail('SOURCE_COPY_REQUIRED');
    const source=t+' '+d+' '+facts.map(f=>f.text).join(' ');
    if(!sourceLooksGerman(source))
      fail('GERMAN_TRANSLATION_REQUIRED');
    const selected=facts.map(f=>({factId:f.id,text:clean(f.text)})).filter(f=>f.text && f.text.length<=200).slice(0,3);
    if(!selected.length)fail('SOURCE_COPY_REQUIRED');
    return validateLocalized({language:'de',title:t.slice(0,150),description:d,
      hook:t.slice(0,100),searchTitle:t.slice(0,150),seoTitle:t.slice(0,70),seoDescription:d.slice(0,160),benefits:selected},facts);
  };
}

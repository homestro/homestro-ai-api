import {validateLocalized} from './localization.js';
import {sourceLooksGerman} from './source-localizer.js';

const text=html=>String(html||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
export function prepareExistingInputs(raw) {
  const productType=raw.productType||null;
  const tags=raw.tags||[];
  const reviewed=tags.some(t=>/^homestro-ai-(?:processed(?:-existing)?|content-complete|complete)$/.test(t)) &&
    !tags.some(t=>/manual-review|ai-rejected|qa-rejected|content-review|content-pending|image-pending|ai-ai-pending/i.test(t)) &&
    (!tags.includes('homestro-ai-qa-pending') || tags.includes('homestro-ai-content-complete'));
  let benefits=[...String(raw.descriptionHtml||'').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(m=>text(m[1])).filter(s=>s.length>5 && s.length<=200).slice(0,3);
  if(!benefits.length)benefits=text(raw.descriptionHtml||raw.description).split(/(?<=[.!?])\s+/)
    .filter(s=>s.length>5 && s.length<=200).slice(0,3);
  const facts=benefits.map((s,i)=>({id:`source-${i+1}`,text:s}));
  let germanCopy=null;
  if(reviewed && facts.length>0 && sourceLooksGerman(raw.title+' '+text(raw.descriptionHtml||raw.description))){
    const candidate={language:'de',title:raw.title.slice(0,150),description:text(raw.descriptionHtml||raw.description),
      hook:raw.title.slice(0,100),searchTitle:raw.title.slice(0,150),
      seoTitle:(raw.seo?.title||raw.title).slice(0,70),seoDescription:(raw.seo?.description||text(raw.description)).slice(0,160),
      benefits:facts.map(f=>({factId:f.id,text:f.text}))};
    try{germanCopy=validateLocalized(candidate,facts);}catch{}
  }
  return {supplierReference:raw.supplierId?.jsonValue||null,landedCost:null,
    previouslyPublished:{facebook:raw.publishedFacebook?.jsonValue||null,instagram:raw.publishedInstagram?.jsonValue||null},
    // Owner previously confirmed existing DSers prices; never recalculate from zero cost.
    priceReviewed:true,contentReviewed:Boolean(germanCopy),
    rightsVerified:tags.includes('homestro-media-rights-verified'),germanCopy,facts,productType,
    categoryKey:/küch|kitchen|aufbewahr/i.test(productType||raw.title)?'kitchen':'home'};
}

import {fail,trackingLink} from './core.js';

const categories={
  beauty:['#Haarklammern','#Haarschmuck','#Alltagslook'],
  kitchen:['#Küchenhelfer','#Küchenorganisation','#OrdnungImAlltag'],
  home:['#Wohnideen','#Zuhause','#Alltagshelfer'],
  garden:['#Gartenideen','#Gartenliebe','#Heimwerken'],
  fitness:['#FitnessAlltag','#Sportzubehör','#AktivImAlltag'],
  pet:['#Haustierzubehör','#Tierfreunde','#AlltagMitTier'],
  electronics:['#TechnikImAlltag','#ElektronikGadgets','#TechnikTipps'],
  baby:['#Familienalltag','#Babyzubehör','#Elternalltag']
};
export function validateLocalized(copy,facts) {
  if(!copy || copy.language!=='de' || typeof copy.title!=='string' || !copy.title.trim() ||
    copy.title.length>150 || typeof copy.description!=='string' || !copy.description.trim() ||
    typeof copy.hook!=='string' || copy.hook.length>100 ||
    typeof copy.searchTitle!=='string' || copy.searchTitle.length>150 ||
    typeof copy.seoTitle!=='string' || copy.seoTitle.length>70 ||
    typeof copy.seoDescription!=='string' || copy.seoDescription.length>160 ||
    !Array.isArray(copy.benefits) || copy.benefits.length<1 || copy.benefits.length>3) fail('LOCALIZATION_REVIEW_REQUIRED');
  const ids=new Set(facts.map(x=>x.id));
  if(copy.benefits.some(x=>!x.text || x.text.length>200 || !ids.has(x.factId))) fail('UNGROUNDED_BENEFITS');
  return copy;
}
// Default costs 0 in AI fees: accept reviewed native German copy, not guessed translations.
// Inject your existing localization engine or an explicitly budgeted model adapter.
export async function localize(product,adapter) {
  if(product.germanCopy) return validateLocalized(product.germanCopy,product.facts||[]);
  if(!adapter) fail('LOCALIZATION_ENGINE_NOT_CONFIGURED');
  const copy=await adapter({language:'de',title:product.title,description:product.description,
    facts:product.facts||[],instructions:'Native German. Only verified facts. No invented specs, health claims, ratings, scarcity or guarantees. Return title, description, hook, three benefits with factId, searchTitle, seoTitle, seoDescription, language.'});
  return validateLocalized(copy,product.facts||[]);
}
export function compilePost(product,channel,asset) {
  const c=product.localized;
  const link=trackingLink(product.url,channel,asset.format);
  const hashtags=[...(categories[product.categoryKey]||categories.home),'#Homestro'];
  const cta=channel==='instagram'
    ? 'Entdecke das Produkt bei Homestro – über den Link in unserem Profil.'
    : 'Jetzt bei Homestro entdecken:';
  const price=Math.min(...product.variants.filter(v=>v.available && v.price>0).map(v=>Number(v.price))).toLocaleString('de-DE',{style:'currency',currency:'EUR'});
  const caption=[c.hook,...c.benefits.map(b=>'• '+b.text),`Ab ${price} zzgl. Versand.`,cta,link,hashtags.join(' ')].join('\n\n');
  if(caption.length>2200)fail('CAPTION_TOO_LONG');
  return {productRevision:product.revision,channel,...asset,
    title:c.title,caption,link,hashtags,adSpendEUR:0,locationId:null,
    instagramLinkNote:channel==='instagram'?'Caption links are not clickable. Maintain a matching link in bio.':null};
}

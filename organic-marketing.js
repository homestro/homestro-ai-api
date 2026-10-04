'use strict';

const CATEGORY_HASHTAGS=Object.freeze({
  pet:['#hundeliebe','#hundealltag','#haustierliebe','#hundezubehör','#tierbedarf'],
  home:['#wohnideen','#zuhause','#haushalt','#wohninspiration','#alltagshelfer'],
  garden:['#gartenideen','#gartenliebe','#gartenhelfer','#heimwerken','#garten'],
  kitchen:['#küchenhelfer','#küchenideen','#kochenmachtspaß','#haushalt','#küche'],
  default:['#homestro','#alltagshelfer','#produktidee','#onlineshopping','#deutschland']
});
function categoryHashtags(product={}){
  const s=`${product.productType||''} ${product.title||''} ${(product.tags||[]).join(' ')}`.toLowerCase();
  const key=/hund|katze|tier|pet/.test(s)?'pet':/garten|outdoor/.test(s)?'garden':/küch|kochen|kitchen/.test(s)?'kitchen':/wohn|haushalt|home/.test(s)?'home':'default';
  return CATEGORY_HASHTAGS[key];
}
function benefitLines(product={}){
  const source=String(product.descriptionText||product.description||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const parts=source.split(/[.!?]\s+/).map(x=>x.trim()).filter(x=>x.length>=18&&x.length<=120).slice(0,3);
  const fallback=['Praktisch für den Alltag','Einfach und unkompliziert zu verwenden','Direkt bei Homestro erhältlich'];
  return [...parts,...fallback].slice(0,3);
}
function buildOrganicDraft(product, channel='facebook'){
  if(!['facebook','instagram'].includes(channel))throw Error('Unsupported channel');
  if(product.status!=='ACTIVE')throw Error('Only ACTIVE products are eligible');
  if(product.reviewPending||(product.tags||[]).some(t=>/(?:manual-review|ai-qa)-pending|rejected|review-required/i.test(t)))throw Error('Product requires review');
  const title=String(product.title||'').trim(); if(!title)throw Error('Product title is required');
  const url=new URL(product.url); if(url.protocol!=='https:'||!['homestro.de','www.homestro.de'].includes(url.hostname)||!url.pathname.startsWith('/products/'))throw Error('A Homestro product URL is required');
  const price=Number(product.price); if(!Number.isFinite(price)||price<=0)throw Error('Verified positive price is required');
  if(product.available!==true)throw Error('Availability must be confirmed');
  if(!product.imageUrl)throw Error('Product image is required');
  const image=new URL(product.imageUrl); if(image.protocol!=='https:')throw Error('HTTPS image is required');
  url.searchParams.set('utm_source',channel);url.searchParams.set('utm_medium','organic');url.searchParams.set('utm_campaign','homestro_pilot');url.searchParams.set('utm_content',String(product.id||product.handle||'product'));
  const formatted=new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(price);
  const benefits=benefitLines(product).map(x=>`✓ ${x}`).join('\n');
  const hashtags=categoryHashtags(product).join(' ');
  const hook=`${title} – praktisch entdeckt ✨`;
  const linkLine=channel==='instagram'?'Mehr entdecken: Link im Profil.':`Jetzt entdecken: ${url.href}`;
  return {productId:String(product.id||''),channel,status:'draft_queued',caption:`${hook}\n\n${benefits}\n\n${formatted}\n${linkLine}\n\n${hashtags}`,trackedUrl:url.href,imageUrl:image.href,requiresReview:true,published:false,paidAds:false,aiRequests:0,hashtags};
}
module.exports={buildOrganicDraft,categoryHashtags,benefitLines};

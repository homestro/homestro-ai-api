'use strict';

const CATEGORY_HASHTAGS=Object.freeze({
  pet:['#hundeliebe','#hundealltag','#haustierliebe','#hundezubehör','#tierbedarf'],
  home:['#wohnideen','#zuhause','#haushalt','#wohninspiration','#alltagshelfer'],
  garden:['#gartenideen','#gartenliebe','#gartenhelfer','#heimwerken','#garten'],
  kitchen:['#küchenhelfer','#küchenideen','#kochenmachtspaß','#haushalt','#küche'],
  default:['#homestro','#alltagshelfer','#produktidee','#onlineshopping','#deutschland']
});
function productContext(product={}) {
  return `${product.productType||''} ${product.title||''} ${(product.tags||[]).join(' ')}`.toLowerCase();
}
function categoryHashtags(product={}) {
  const s=productContext(product);
  const key=/hund|katze|tier|pet/.test(s)?'pet':/garten|outdoor/.test(s)?'garden':/küch|kochen|kitchen/.test(s)?'kitchen':/wohn|haushalt|home/.test(s)?'home':'default';
  return CATEGORY_HASHTAGS[key];
}
function problemSolutionHook(product={}) {
  const title=String(product.title||'Dieses Produkt').trim();
  const context=productContext(product);
  const options=/ohr|ohren|ohrreinig|ear/.test(context)
    ? [
        `Die äußere Ohrpflege bei Hund oder Katze steht an? Schau dir ${title} an.`,
        `Wenn die Ohrenpflege ansteht: Prüfe, ob ${title} zu deinem Tier passt.`,
        `Pflege für Hund oder Katze gesucht? Entdecke die Details zu ${title}.`
      ]
    : /trinkflasche|wasserflasche|bottle/.test(context)
      ? [
          `Getränk für unterwegs dabei? Entdecke, ob ${title} zu deinem Tag passt.`,
          `Du möchtest dein Getränk mitnehmen? Schau dir die Eigenschaften von ${title} an.`,
          `Für den Weg, Sport oder Alltag: Prüfe, ob ${title} zu dir passt.`
        ]
      : /fitness|sport|training|massage|haltung|posture/.test(context)
        ? [
            `Training oder Entspannung geplant? Entdecke die Details zu ${title}.`,
            `Du suchst Unterstützung für deine Routine? Prüfe, ob ${title} zu dir passt.`,
            `Vor dem nächsten Workout: Schau dir an, was ${title} mitbringt.`
          ]
        : /auto|car|reise|travel|koffer|gepäck/.test(context)
          ? [
              `Für den nächsten Weg etwas Praktisches gesucht? Entdecke ${title}.`,
              `Unterwegs zählt die passende Ausstattung: Prüfe die Details zu ${title}.`,
              `Reise oder Autofahrt geplant? Schau dir an, ob ${title} zu dir passt.`
            ]
          : [
              `Du suchst eine passende Lösung für deinen Alltag? Entdecke ${title}.`,
              `Eine konkrete Alltagsfrage: Könnte ${title} zu deinen Anforderungen passen?`,
              `Vor dem Kauf zählen die Details: Prüfe, ob ${title} zu dir passt.`
            ];
  const id=String(product.id||product.handle||title);
  let hash=0;
  for(const ch of id)hash=(hash*31+ch.codePointAt(0))>>>0;
  return options[hash%options.length];
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
  const hook=problemSolutionHook(product);
  const linkLine=channel==='instagram'?'Produktdetails über den Link im Profil.':`Produktdetails: ${url.href}`;
  const cta='Jetzt entdecken auf homestro.de – bequem mit PayPal & Klarna.';
  return {productId:String(product.id||''),channel,status:'draft_queued',caption:`${hook}\n\n${benefits}\n\n${formatted}\n${linkLine}\n\n${hashtags}\n\n${cta}`,trackedUrl:url.href,imageUrl:image.href,requiresReview:true,published:false,paidAds:false,aiRequests:0,hashtags};
}
module.exports={buildOrganicDraft,categoryHashtags,benefitLines};

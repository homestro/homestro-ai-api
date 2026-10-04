import {fail,trackingLink} from './core.js';

export const xmlEscape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
const tag=(name,value)=>`<g:${name}>${xmlEscape(value)}</g:${name}>`;
export function validGTIN(s) {
  if(!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(s||''))return false;
  const a=[...s].map(Number);const check=a.pop();
  return (10-a.reverse().reduce((sum,n,i)=>sum+n*(i%2===0?3:1),0)%10)%10===check;
}
export function generateFeed(products,cfg) {
  if(!Number.isInteger(cfg.feedCap) || cfg.feedCap<1 || cfg.feedCap>50000)fail('INVALID_FEED_CAP');
  for(const s of cfg.shipping)if(!/^[A-Z]{2}$/.test(s.country) || !Number.isFinite(s.price) || s.price<0)fail('INVALID_SHIPPING');
  const items=[];
  outer:for(const p of products){
    if(p.status!=='ACTIVE' || p.currency!=='EUR' || !p.localized || !p.contentReviewed || !p.priceReviewed && !p.pricing?.costVerified)continue;
    const image=p.media.find(x=>x.mediaContentType==='IMAGE' && x.status==='READY')?.image?.url;
    if(!image)continue;
    for(const v of p.variants){
      if(!Number.isFinite(v.price) || v.price<=0)continue;
      const link=new URL(trackingLink(p.url,'google','free_listings'));link.searchParams.set('variant',v.id.split('/').pop());
      let content=tag('id',v.id)+tag('item_group_id',p.id)+tag('title',p.localized.searchTitle)+
        tag('description',p.localized.description.slice(0,5000))+tag('link',link.toString())+
        tag('image_link',image)+tag('price',`${v.price.toFixed(2)} EUR`)+
        tag('availability',v.available?'in_stock':'out_of_stock')+tag('condition',p.condition);
      if(p.brand)content+=tag('brand',p.brand);
      if(validGTIN(v.barcode))content+=tag('gtin',v.barcode);
      else if(p.unbranded)content+=tag('identifier_exists','no');
      if(p.productType)content+=tag('product_type',p.productType);
      for(const s of cfg.shipping){
        const price=Number.isFinite(s.freeFrom) && v.price>=s.freeFrom?0:s.price;
        content+=`<g:shipping>${tag('country',s.country)}${tag('service','Standardversand')}${tag('price',`${price.toFixed(2)} EUR`)}</g:shipping>`;
      }
      items.push('<item>'+content+'</item>');
      if(items.length>=cfg.feedCap)break outer;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Homestro</title><link>https://homestro.de</link><description>Homestro Produktangebote</description>${items.join('')}</channel></rss>`;
}

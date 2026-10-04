import {hash,pricing,codeOf,log,productURL,fail} from './core.js';
import {localize,compilePost} from './localization.js';

export function snapshot(raw,extras={},feeRate=0) {
  const variants=(raw.variants||[]).map(v=>({id:v.id,title:v.title,price:Number(v.price),
    available:typeof v.availableForSale==='boolean'?v.availableForSale:
      Number(v.inventoryQuantity)>0 || v.inventoryPolicy==='CONTINUE',barcode:v.barcode||null}));
  const p={id:raw.id,title:raw.title,description:raw.description,status:raw.status,
    url:raw.onlineStoreUrl,variants,media:raw.media||[],currency:'EUR',
    supplierReference:extras.supplierReference||null,landedCost:extras.landedCost??null,
    priceReviewed:extras.priceReviewed===true,rightsVerified:extras.rightsVerified===true,
    contentReviewed:extras.contentReviewed===true,germanCopy:extras.germanCopy||null,
    facts:extras.facts||[],categoryKey:extras.categoryKey||'home',
    brand:extras.brand||null,productType:extras.productType||null,condition:'new',
    unbranded:extras.unbranded===true};
  p.previouslyPublished=extras.previouslyPublished||{};
  // Unknown cost is recorded, existing Shopify selling price remains unchanged.
  const first=variants.find(v=>v.price>0);
  p.pricing=first?pricing(first.price,p.landedCost,feeRate):null;
  p.revision=hash(p); return p;
}
export class Ingestion {
  constructor({store,renderer,localizer,feeRate=0}) {Object.assign(this,{store,renderer,localizer,feeRate});}
  async process(raw,extras={}) {
    let p;
    try {
      p=snapshot(raw,extras,this.feeRate); const reasons=[];
      const previous=await this.store.product(p.id);
      if(previous?.document?.revision===p.revision)p.localized=previous.document.localized;
      if(!p.supplierReference)reasons.push('SUPPLIER_REFERENCE_MISSING');
      if(!p.pricing?.costVerified && !p.priceReviewed)reasons.push('PRICE_REVIEW_REQUIRED');
      if(!p.rightsVerified)reasons.push('MEDIA_RIGHTS_REVIEW_REQUIRED');
      if(!p.contentReviewed)reasons.push('CONTENT_REVIEW_REQUIRED');
      if(p.status!=='ACTIVE')reasons.push('PRODUCT_NOT_ACTIVE');
      if(!p.variants.some(v=>v.available && v.price>0))reasons.push('NO_AVAILABLE_VARIANT');
      try{productURL(p.url);}catch{reasons.push('NO_PUBLIC_PRODUCT_URL');}
      // Persist BEFORE localization/media: supplier misses never terminate ingestion.
      await this.store.saveProduct(p,'pending_marketing',reasons);
      try{if(!p.localized)p.localized=await localize(p,this.localizer);}catch(e){
        reasons.push(codeOf(e));
        // Preview-only fallback: use existing Shopify German copy to render a review draft.
        // This does NOT clear CONTENT_REVIEW_REQUIRED and therefore cannot become publishable.
        const clean=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
        const title=clean(p.title).slice(0,150);
        const description=clean(p.description)||title;
        const fallbackFacts=(p.facts||[]).slice(0,3);
        while(fallbackFacts.length<3)fallbackFacts.push({id:`preview-${fallbackFacts.length+1}`,text:title});
        p.facts=fallbackFacts;
        p.localized={language:'de',title,description,hook:title.slice(0,100),searchTitle:title,
          seoTitle:title.slice(0,70),seoDescription:description.slice(0,160),
          benefits:fallbackFacts.map(x=>({factId:x.id,text:clean(x.text).slice(0,200)||title}))};
      }
      // Marketing media/drafts may be prepared while commercial/review gates are pending.
      // Approval and publishing remain fail-closed because Store.approve() requires product status=ready.
      let asset=null,queued=0;
      if(p.localized){
        try {
          asset=await this.renderer.render(p);
          p.asset=asset;
          for(const channel of ['facebook','instagram']){
            if(p.previouslyPublished[channel])continue;
            const payload=compilePost(p,channel,asset);
            if(await this.store.queue(p.id,channel,hash(payload),payload))queued++;
          }
        } catch(e) { reasons.push(codeOf(e)); }
      }
      if(reasons.length){
        await this.store.saveProduct(p,'pending_marketing',reasons);
        return {processed:1,status:'pending_marketing',reasons,queued,assetFormat:asset?.format||null};
      }
      await this.store.saveProduct(p,'ready',[]);
      return {processed:1,status:'draft_queued',queued,assetFormat:asset?.format||null};
    } catch(e){
      const reason=codeOf(e);log(reason,{productId:raw.id});
      // A failure remains isolated. Caller must NOT use this result to undo product ingestion.
      if(p)await this.store.saveProduct(p,'pending_marketing',[reason]).catch(()=>{});
      return {processed:0,status:'pending_marketing',reasons:[reason]};
    }
  }
}

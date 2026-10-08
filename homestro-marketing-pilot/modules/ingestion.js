import {hash,pricing,codeOf,log,productURL,fail} from './core.js';
import {localize,compilePost} from './localization.js';
import {extractMedia} from './media.js';

export function snapshot(raw,extras={},feeRate=0) {
  const variants=(raw.variants||[]).map(v=>({id:v.id,title:v.title,price:Number(v.price),
    available:typeof v.availableForSale==='boolean'?v.availableForSale:
      Number(v.inventoryQuantity)>0 || v.inventoryPolicy==='CONTINUE',barcode:v.barcode||null}));
  const p={preparationVersion:5,rejected:(raw.tags||[]).some(t=>/^homestro-(?:ai|qa)-rejected$/i.test(String(t).trim())),id:raw.id,title:raw.title,description:raw.description,status:raw.status,
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
  async process(raw,extras={}, {prepareOnly=false}={}) {
    let p;
    try {
      p=snapshot(raw,extras,this.feeRate); const reasons=[];
      const previous=await this.store.product(p.id);
      if(previous?.document?.revision===p.revision && previous.document.localizationPrepared===true){
        p.localized=previous.document.localized;p.localizationPrepared=true;
      }
      // Supplier reference is provenance metadata. Missing provenance must not block organic marketing.
      // Keep it visible for review/audit, but do not falsely invent a supplier ID.
      if(!p.supplierReference)log('SUPPLIER_REFERENCE_MISSING',{productId:p.id});
      if(!p.pricing?.costVerified && !p.priceReviewed)reasons.push('PRICE_REVIEW_REQUIRED');
      // Keep rightsVerified as factual metadata. The owner removed it as a publishing gate.
      if(!p.contentReviewed)reasons.push('CONTENT_REVIEW_REQUIRED');
      if(p.rejected)reasons.push('PRODUCT_REJECTED');
      if(p.status!=='ACTIVE')reasons.push('PRODUCT_NOT_ACTIVE');
      if(!p.variants.some(v=>v.available && v.price>0))reasons.push('NO_AVAILABLE_VARIANT');
      try{productURL(p.url);}catch{reasons.push('NO_PUBLIC_PRODUCT_URL');}
      // Persist BEFORE localization/media: supplier misses never terminate ingestion.
      await this.store.saveProduct(p,'pending_marketing',reasons);
      try{
        if(!p.localized)p.localized=await localize(p,this.localizer);
        p.localizationPrepared=true;
      }catch(e){
        reasons.push(codeOf(e));
        p.localizationPrepared=false;
      }
      // Marketing media/drafts may be prepared while commercial/review gates are pending.
      // Approval and publishing remain fail-closed because Store.approve() requires product status=ready.
      let asset=null,queued=0;
      if(p.localized){
        try {
          if(prepareOnly){
            const m=extractMedia(p.media);
            if(!m.images.length && !m.videoURL)fail('NO_MARKETING_MEDIA');
            asset={previewOnly:true,format:m.videoURL?'reels':m.images.length>1?'carousel':'image',
              videoURL:m.videoURL,imageURLs:m.videoURL?[]:m.images.slice(0,10)};
            reasons.push('MEDIA_PREPARATION_PENDING');
          }else asset=await this.renderer.render(p);
          p.asset=asset;
          for(const channel of ['facebook','instagram']){
            if(p.previouslyPublished[channel])continue;
            const payload=compilePost(p,channel,asset);
            if(await this.store.queue(p.id,channel,hash(payload),payload))queued++;
          }
        } catch(e) { const reason=codeOf(e); reasons.push(reason); if(reason==='INTERNAL_ERROR') log('RENDER_INTERNAL_ERROR',{name:String(e?.name||'Error').slice(0,60),message:String(e?.message||'').slice(0,120)}); }
      }
      if(reasons.length){
        await this.store.saveProduct(p,'pending_marketing',reasons);
        log('CONTENT_PREPARED',{productId:p.id,prepared:p.localizationPrepared===true,queued,publishable:false});
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

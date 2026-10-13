import {fail,hash} from './core.js';
import {generateFeed} from './feed.js';

// Bound concurrent reads and share an in-flight refresh between the two feed URLs.
// A failed source is omitted; an old price is never substituted for a fresh failure.
const copyHash=p=>hash(Object.fromEntries(['title','description','facts','germanCopy','productType','brand','unbranded','condition'].map(k=>[k,p[k]])));
export function createFeedRefresh({store,fresh,cfg}) {
  let flight;
  const refresh=async()=>{
    if(!cfg.feedEnabled)fail('FEED_DISABLED');
    const sources=await store.seoRows(),products=new Array(sources.length);
    let index=0;
    const worker=async()=>{
      while(index<sources.length){
        const i=index++,p=sources[i];
        try{
          const current=await fresh(p.id);
          // Stock/price changes can use the same reviewed copy. Changed content
          // waits for catalog review; a feed request never starts media rendering.
          if(current.revision===p.revision||copyHash(current)===copyHash(p))
            products[i]={...current,localized:p.localized};
        }catch{ /* Omit this source rather than emit stale stock or price. */ }
      }
    };
    await Promise.all(Array.from({length:Math.min(3,sources.length)},worker));
    return generateFeed(products.filter(Boolean),cfg);
  };
  return ()=>{
    if(!flight)flight=refresh().finally(()=>{flight=null;});
    return flight;
  };
}

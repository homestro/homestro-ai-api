import {log} from './core.js';

const endpoint='https://trends.google.com/trending/rss?geo=DE';
const decode=value=>String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const stop=new Set('der die das ein eine und oder mit fur für von im in aus zu zum zur ohne bei den dem des auf an uber über shop produkt'.split(' '));
const words=value=>String(value||'').toLocaleLowerCase('de-DE').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .match(/[a-z0-9]{2,}/g)?.filter(x=>!stop.has(x))||[];
function fit(base,term,max) {
  const suffix=term.trim(); if(!suffix)return String(base||'').slice(0,max);
  const current=String(base||'').trim();
  if(current.toLocaleLowerCase('de-DE').includes(suffix.toLocaleLowerCase('de-DE')))return current.slice(0,max);
  const tail=' | '+suffix;
  const prefix=current.slice(0,Math.max(1,max-tail.length)).replace(/[\s|–—-]+$/,'');
  return (prefix+tail).slice(0,max);
}
export class GoogleTrends {
  constructor({fetchImpl=fetch,ttlMs=10*60*1000}={}){this.fetchImpl=fetchImpl;this.ttlMs=ttlMs;this.items=[];this.updatedAt=0;this.flight=null;}
  async refresh(force=false){
    if(!force&&Date.now()-this.updatedAt<this.ttlMs)return this.items;
    if(this.flight)return this.flight;
    this.flight=(async()=>{
      try{
        const response=await this.fetchImpl(endpoint,{headers:{accept:'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('GOOGLE_TRENDS_HTTP_'+response.status);
        const xml=await response.text(),items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(m=>{
          const title=decode(m[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
          const traffic=decode(m[1].match(/<ht:approx_traffic\b[^>]*>([\s\S]*?)<\/ht:approx_traffic>/i)?.[1]);
          const pubDate=decode(m[1].match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]);
          return {query:title,traffic,pubDate};
        }).filter(x=>x.query);
        if(!items.length)throw new Error('GOOGLE_TRENDS_EMPTY');
        this.items=items;this.updatedAt=Date.now();
        log('GOOGLE_TRENDS_REFRESHED',{country:'DE',count:items.length,source:'public_rss'});
      }catch(e){
        log('GOOGLE_TRENDS_UNAVAILABLE',{reason:String(e?.message||'FETCH_FAILED').slice(0,60),usingCached:this.items.length>0});
      }finally{this.flight=null;}
      return this.items;
    })();
    return this.flight;
  }
  async optimize(product,copy){
    const items=await this.refresh(),context=[product?.title,product?.description,product?.productType,product?.product_type,...(product?.tags||[])].join(' ');
    const contextWords=new Set(words(context));
    const match=items.map(item=>{
      const queryWords=[...new Set(words(item.query))];
      const overlap=queryWords.filter(word=>contextWords.has(word));
      return {...item,queryWords,overlap,score:overlap.length/queryWords.length};
    }).filter(x=>x.queryWords.length>=2&&x.overlap.length>=2&&x.score>=0.66)
      .sort((a,b)=>b.score-a.score)[0];
    if(!match)return {copy,matchedQuery:null,changed:false};
    const next={...copy,searchTitle:fit(copy.searchTitle||copy.title,match.query,150),
      seoTitle:fit(copy.seoTitle||copy.title,match.query,70)};
    const phrase='Aktuell gesucht: '+match.query+'.';
    if(!String(next.seoDescription||'').toLocaleLowerCase('de-DE').includes(match.query.toLocaleLowerCase('de-DE'))){
      const desc=String(next.seoDescription||copy.description||'').trim();
      const base=desc.slice(0,Math.max(0,160-phrase.length-2)).replace(/[\s.!?,;:–—-]+$/,'');
      next.seoDescription=(base?base+'. ':'')+phrase;
    }
    const changed=['searchTitle','seoTitle','seoDescription'].some(k=>next[k]!==copy[k]);
    return {copy:next,matchedQuery:match.query,changed};
  }
}

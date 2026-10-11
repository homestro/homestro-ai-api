import {fail} from './core.js';

const WINDOWS=new Set([7,14,30,90]);
export function reportWindow(value) {
  if(value===undefined || value===null || value==='') return 30;
  const days=Number(value);
  if(!Number.isInteger(days) || !WINDOWS.has(days)) fail('INVALID_REPORT_WINDOW');
  return days;
}

const countMap=rows=>Object.fromEntries((rows||[]).map(row=>[row.status,Number(row.count)||0]));
export function buildGrowthReport({days=30,products=[],posts=[],pendingReasons=[],generatedAt=new Date().toISOString()}={}) {
  const productCounts=countMap(products);
  const productTotal=Object.values(productCounts).reduce((n,x)=>n+x,0);
  const readyProducts=Number(products.find(x=>x.status==='ready')?.count)||0;
  const seoCopyReady=Number(products.find(x=>x.status==='ready')?.seo_copy_ready)||0;
  const seoCopyMissing=Number(products.find(x=>x.status==='ready')?.seo_copy_missing)||0;
  const byChannel={};
  let confirmedPublications=0, publishedRows=0;
  for(const row of posts||[]) {
    const channel=String(row.channel||'unknown');
    byChannel[channel] ||= {published:0,confirmedPermalink:0,draftQueued:0,approved:0,other:0};
    const n=Number(row.count)||0;
    if(row.status==='published') {
      byChannel[channel].published+=n;
      publishedRows+=n;
      const linked=Number(row.confirmed_permalink_count)||0;
      byChannel[channel].confirmedPermalink+=linked;
      confirmedPublications+=linked;
    } else if(row.status==='draft_queued') byChannel[channel].draftQueued+=n;
    else if(row.status==='approved') byChannel[channel].approved+=n;
    else byChannel[channel].other+=n;
  }
  return {
    generatedAt,windowDays:days,adSpendEUR:0,
    catalog:{total:productTotal,byStatus:productCounts,readyProducts,seoCopyReady,seoCopyMissing},
    organic:{publishedRows,confirmedPublications,byChannel,pendingReasons},
    attribution:{connected:false,sessions:null,clicks:null,orders:null,revenueEUR:null,
      searchImpressions:null,searchClicks:null,
      missing:['Shopify session/order attribution','Search Console impressions and clicks','social-platform reach and clicks']},
    recommendations:[
      ...(readyProducts===0?['No products are currently ready for organic promotion.']:[]),
      ...(seoCopyMissing>0?[`${seoCopyMissing} ready products are missing prepared SEO title or description.`]:[]),
      ...(publishedRows>confirmedPublications?[`${publishedRows-confirmedPublications} recorded publications have no confirmed public permalink.`]:[]),
      'Connect verified analytics sources before treating reach, visits, or orders as campaign results.'
    ]
  };
}

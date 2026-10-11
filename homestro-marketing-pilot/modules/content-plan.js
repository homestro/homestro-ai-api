import {fail,productURL} from './core.js';

const clean=value=>String(value??'').replace(/[<>\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,180);
const unique=items=>[...new Set(items.map(clean).filter(Boolean))];

export function buildSeoContentPlan({product,status,reasons=[]}={}) {
  if(!product||typeof product!=='object')fail('PRODUCT_NOT_FOUND');
  const localized=product.localized||{};
  const title=clean(localized.searchTitle||localized.seoTitle||localized.title||product.title);
  const productType=clean(product.productType||'');
  const url=(()=>{try{return productURL(product.url).toString();}catch{return null;}})();
  const facts=unique([
    ...(Array.isArray(localized.benefits)?localized.benefits.map(x=>x?.text):[]),
    ...(Array.isArray(product.facts)?product.facts.map(x=>x?.text):[])
  ]).slice(0,8);
  const seed=title||productType;
  if(!seed)fail('SEO_PLAN_SOURCE_REQUIRED');
  const category=productType||seed;
  const topics=[
    {type:'product_guide',title:`Produkt-Guide: ${seed}`,intent:'informational',basis:'verified_product_title'},
    {type:'features',title:`Eigenschaften und Anwendung: ${seed}`,intent:'commercial',basis:facts.length?'verified_product_facts':'verified_product_title'},
    {type:'buying_guide',title:`Kaufberatung: Worauf bei ${category} achten?`,intent:'commercial',basis:'verified_product_category'}
  ];
  return {
    product:{id:product.id||null,title:seed,url,status:status||'unknown'},
    language:'de',
    primaryKeywordHypothesis:seed,
    relatedKeywordHypotheses:unique([productType,localized.title,localized.searchTitle]).filter(x=>x!==seed).slice(0,5),
    topics,
    outline:[
      {heading:`Was ist ${seed}?`,source:'product_title'},
      {heading:'Bestätigte Eigenschaften',source:facts.length?'product_facts':'needs_review',facts},
      {heading:'Auswahl und Anwendung',source:'editorial_guidance'},
      {heading:'Häufige Fragen',source:'questions_only',questions:[
        `Welche Eigenschaften hat ${seed}?`,
        `Worauf sollte man bei ${category} achten?`
      ]}
    ],
    evidence:{verifiedFactCount:facts.length,productPageAvailable:Boolean(url),pendingReasons:Array.isArray(reasons)?reasons:[]},
    searchMetrics:{connected:false,searchVolume:null,difficulty:null,source:null},
    publication:{createsPage:false,requiresReviewedCopy:true,draftEndpoint:'/api/marketing/v2/seo/articles/draft'},
    claims:'Topic and keyword suggestions are hypotheses derived from catalog text; search volume and rankings are not measured.'
  };
}

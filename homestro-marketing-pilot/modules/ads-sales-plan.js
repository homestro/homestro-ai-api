import {ACCESS_SCOPES} from './performance.js';
import {productURL} from './core.js';

const SALES_QUERY = `query PilotProductSales($query: String!) {
  shopifyqlQuery(query: $query) {
    tableData { columns { name dataType } rows }
    parseErrors
  }
}`;
const TITLE_QUERY = `FROM sales SHOW gross_sales, net_sales, orders GROUP BY product_title ORDER BY net_sales DESC LIMIT 500 SINCE -90d UNTIL today`;
const LANDING_QUERY = `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout WHERE human_or_bot_session = 'human' SINCE -90d UNTIL today GROUP BY landing_page_path ORDER BY sessions DESC LIMIT 1000`;
const money = value => {
  const n=Number(value);
  return Number.isFinite(n)?n:null;
};
const titleKey = value => String(value||'').normalize('NFKC').trim().toLocaleLowerCase('de-DE');
const pathKey = value => {
  let path=String(value||'').trim();
  try { path=decodeURIComponent(path); } catch {}
  return path.normalize('NFKC').toLocaleLowerCase('de-DE').replace(/\/$/,'')||'/';
};
const shopUrl = value => { try { return productURL(value).origin==='https://homestro.de'; } catch { return false; } };

export async function readProductSales(graphql,{days=90}={}) {
  const scopes=await graphql(ACCESS_SCOPES,{});
  const granted=new Set((scopes?.currentAppInstallation?.accessScopes||[]).map(x=>x.handle));
  if(!granted.has('read_reports')) return {status:'permission_required',missingScopes:['read_reports'],days,byTitle:{}};
  const query=TITLE_QUERY.replace('-90d',`-${Math.max(1,Math.min(365,Number(days)||90))}d`);
  const landingQuery=LANDING_QUERY.replace('-90d',`-${Math.max(1,Math.min(365,Number(days)||90))}d`);
  const [salesResult,landingResult]=await Promise.allSettled([
    graphql(SALES_QUERY,{query}),graphql(SALES_QUERY,{query:landingQuery})
  ]);
  const parse=(settled,required)=>{
    if(settled.status!=='fulfilled')return null;
    const report=settled.value?.shopifyqlQuery;
    if(!report || report.parseErrors?.length || !Array.isArray(report.tableData?.columns) || !Array.isArray(report.tableData?.rows))return null;
    const names=report.tableData.columns.map(c=>c.name),indexes=Object.fromEntries(required.map(key=>[key,names.indexOf(key)]));
    if(Object.values(indexes).some(i=>i<0))return null;
    return report.tableData.rows.map(row=>Object.fromEntries(required.map(key=>[key,Array.isArray(row)?row[indexes[key]]:row?.[names[indexes[key]]]])));
  };
  const salesRows=parse(salesResult,['product_title','gross_sales','net_sales','orders']);
  const landingRows=parse(landingResult,['landing_page_path','sessions','sessions_with_cart_additions','sessions_that_reached_checkout']);
  if(!salesRows&&!landingRows)return {status:'unavailable',missingScopes:[],days,byTitle:{},byPath:{}};
  const byTitle={};
  for(const row of salesRows||[]) {
    const title=String(row.product_title||'').trim(),key=titleKey(title),gross=money(row.gross_sales),net=money(row.net_sales),orders=money(row.orders);
    if(!key || gross===null || net===null || orders===null || orders<0) continue;
    const item=byTitle[key]||{title,orders:0,grossSalesEUR:0,netSalesEUR:0};
    item.orders+=orders; item.grossSalesEUR+=gross; item.netSalesEUR+=net; byTitle[key]=item;
  }
  const byPath={};
  for(const row of landingRows||[]) {
    const key=pathKey(row.landing_page_path),sessions=money(row.sessions),carts=money(row.sessions_with_cart_additions),checkouts=money(row.sessions_that_reached_checkout);
    if(!key || sessions===null || carts===null || checkouts===null)continue;
    byPath[key]={sessions,carts,checkouts};
  }
  return {status:salesRows&&landingRows?'connected':'partial',missingScopes:[],days,byTitle,byPath,
    availableSignals:{productOrders:Boolean(salesRows),productSessions:Boolean(landingRows)}};
}

export async function refreshProductSales({pool,graphql,enabled=true,now=new Date()}={}) {
  if(!enabled)return {status:'disabled',days:90,byTitle:{},byPath:{}};
  await pool.query(`CREATE TABLE IF NOT EXISTS marketing_product_sales (
    id integer PRIMARY KEY CHECK (id=1), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  const cached=(await pool.query('SELECT payload,updated_at FROM marketing_product_sales WHERE id=1')).rows[0];
  if(cached && now.getTime()-new Date(cached.updated_at).getTime()<60*60*1000)return cached.payload;
  let result;
  try { result=await readProductSales(graphql,{days:90}); }
  catch { result={status:'unavailable',missingScopes:[],days:90,byTitle:{},byPath:{}}; }
  await pool.query(`INSERT INTO marketing_product_sales(id,payload,updated_at) VALUES(1,$1,now())
    ON CONFLICT(id) DO UPDATE SET payload=$1,updated_at=now()`,[result]);
  return result;
}

function productFacts(p) {
  const localized=p?.localized||p?.germanCopy||{};
  if(localized.language!=='de')return [];
  const values=[...(Array.isArray(localized?.benefits)?localized.benefits.map(x=>x?.text):[])];
  return [...new Set(values.map(x=>String(x||'').replace(/\s+/g,' ').trim()).filter(x=>x.length>=8))].slice(0,5);
}

export function buildSalesPlan({products=[],productSales={status:'unavailable',byTitle:{}},checkedAt=new Date(),minimumNetMarginEUR=10}={}) {
  const keyed=new Map();
  for(const row of products) {
    const k=titleKey(row?.document?.title);
    if(!k) continue;
    const prev=keyed.get(k);
    if(prev) prev.ambiguous=true;
    else keyed.set(k,{...productSales.byTitle?.[k],ambiguous:false});
  }
  const rows=products.map(row=>{
    const p=row?.document||{}, reasons=[];
    if(row?.status!=='ready')reasons.push('MARKETING_CONTENT_NOT_READY');
    if(p.status!=='ACTIVE')reasons.push('PRODUCT_NOT_ACTIVE');
    if(p.rejected===true)reasons.push('PRODUCT_REJECTED');
    const variants=Array.isArray(p.variants)?p.variants.filter(v=>v?.available===true && money(v.price)>0):[];
    if(!variants.length)reasons.push('NO_AVAILABLE_VARIANT');
    if(!shopUrl(p.url))reasons.push('NO_PUBLIC_PRODUCT_URL');
    const media=(p.media||[]).filter(m=>m?.mediaContentType==='IMAGE' && m?.status==='READY' && m?.image?.url);
    const hasImage=media.length>0 || Boolean(p.asset?.imageURLs?.length);
    if(!hasImage)reasons.push('PRODUCT_IMAGE_MISSING');
    const pricing=p.pricing||{};
    const margin=pricing.costVerified===true?money(pricing.marginEUR):null;
    if(margin===null)reasons.push('PRODUCT_MARGIN_UNVERIFIED');
    else if(margin<minimumNetMarginEUR)reasons.push('MINIMUM_MARGIN_NOT_MET');
    if(p.priceReviewed!==true)reasons.push('SELLING_PRICE_NOT_REVIEWED');
    const sales=keyed.get(titleKey(p.title));
    const path=(()=>{try{return pathKey(new URL(p.url).pathname);}catch{return '';}})();
    const demand=productSales.byPath?.[path]||null;
    const orders=sales&&!sales.ambiguous&&Number.isFinite(Number(sales.orders))?Number(sales.orders):0;
    const sessions=Number(demand?.sessions||0),carts=Number(demand?.carts||0),checkouts=Number(demand?.checkouts||0);
    if(productSales.status==='unavailable' || productSales.status==='permission_required')reasons.push('PRODUCT_DEMAND_DATA_UNAVAILABLE');
    else if(sales?.ambiguous)reasons.push('PRODUCT_TITLE_AMBIGUOUS');
    else if(!(orders>0 || carts>0 || checkouts>0 || sessions>=10))reasons.push('NO_DEMAND_SIGNAL');
    const facts=productFacts(p);
    if(!facts.length)reasons.push('VERIFIED_PRODUCT_FACTS_MISSING');
    const eligibleForTest=reasons.length===0;
    const price=variants.length?Math.min(...variants.map(v=>Number(v.price))):null;
    const localized=p.localized||p.germanCopy||{};
    const adCopy=eligibleForTest?{
      language:'de',
      hook:String(localized.hook||facts[0]).trim(),
      offer:`${p.title} für ${new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(price)}${facts[1]?` – ${facts[1]}`:''}`,
      cta:'Jetzt bei Homestro kaufen',
      destination:p.url,
      imageURL:media[0]?.image?.url||p.asset?.imageURLs?.[0]||null,
      factualBasis:facts.slice(0,2)
    }:null;
    const demandEvidence=orders>0?'confirmed_orders':checkouts>0?'checkout_sessions':carts>0?'cart_sessions':sessions>=10?'qualified_human_product_sessions':null;
    return {id:p.id||null,title:p.title||null,shopifyStatus:p.status||null,marketingStatus:row?.status||null,
      category:p.categoryKey||'other',priceEUR:price,verifiedMarginEUR:margin,
      maxCPAAfterMinimumProfitEUR:margin===null?null:Math.max(0,Number((margin-minimumNetMarginEUR).toFixed(2))),
      demandEvidence,
      orders90d:sales&&!sales.ambiguous&&Number.isFinite(Number(sales.orders))?orders:null,sessions90d:demand?sessions:null,
      cartSessions90d:demand?carts:null,checkoutSessions90d:demand?checkouts:null,
      netSales90dEUR:sales&&!sales.ambiguous&&Number.isFinite(Number(sales.netSalesEUR))?Number(sales.netSalesEUR):null,
      eligibleForTest,blockedBy:[...new Set(reasons)],adCopy};
  });
  rows.sort((a,b)=>Number(b.orders90d||0)-Number(a.orders90d||0)||Number(b.checkoutSessions90d||0)-Number(a.checkoutSessions90d||0)||Number(b.cartSessions90d||0)-Number(a.cartSessions90d||0)||Number(b.sessions90d||0)-Number(a.sessions90d||0)||Number(b.verifiedMarginEUR||0)-Number(a.verifiedMarginEUR||0));
  const eligible=rows.filter(x=>x.eligibleForTest);
  return {mode:'read_only_sales_plan',checkedAt:checkedAt instanceof Date?checkedAt.toISOString():new Date(checkedAt).toISOString(),
    salesWindowDays:productSales.days||90,productSalesStatus:productSales.status||'unavailable',
    productCounts:{catalog:products.length,eligibleForTest:eligible.length,blocked:rows.length-eligible.length},
    recommendedProductId:eligible[0]?.id||null,recommendedProduct:eligible[0]||null,
    products:rows,executionEnabled:false,adSpendEUR:0,
    budgetPolicy:{maxDailyEUR:5,maxDays:7,maxCampaigns:1,automaticScalingAboveCap:false},
    blockers:eligible.length?[]:['NO_PRODUCT_HAS_VERIFIED_DEMAND_AND_MARGIN'],
    safety:'Plans and factual copy only. No ad account writes, campaign activation, budget change, or spend.'};
}

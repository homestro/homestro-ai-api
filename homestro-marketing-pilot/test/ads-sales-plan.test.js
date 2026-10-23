import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSalesPlan,readProductSales,refreshProductSales} from '../modules/ads-sales-plan.js';

const product=(overrides={})=>({status:'ready',document:{
  id:'gid://shopify/Product/1',title:'Faltbare Reisetasche',status:'ACTIVE',
  url:'https://homestro.de/products/faltbare-reisetasche',categoryKey:'reise',
  variants:[{available:true,price:39.9}],
  media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/bag.jpg'}}],
  pricing:{costVerified:true,marginEUR:14.2},
  priceReviewed:true,
  facts:[{id:'f1',text:'Faltbar mit zusätzlichem Stauraum'}],
  localized:{language:'de',hook:'Mehr Platz auf Reisen: faltbar mit zusätzlichem Stauraum.',
    benefits:[{factId:'f1',text:'Faltbar mit zusätzlichem Stauraum'}]},
  ...overrides
}});

test('sales plan prioritizes verified product demand, margin, and factual copy without spending',()=>{
  const plan=buildSalesPlan({products:[product()],productSales:{status:'connected',days:90,
    byTitle:{'faltbare reisetasche':{orders:0,netSalesEUR:0}},
    byPath:{'/products/faltbare-reisetasche':{sessions:13,carts:1,checkouts:0}}}});
  assert.equal(plan.recommendedProductId,'gid://shopify/Product/1');
  assert.equal(plan.recommendedProduct.eligibleForTest,true);
  assert.equal(plan.recommendedProduct.adCopy.hook,'Mehr Platz auf Reisen: faltbar mit zusätzlichem Stauraum.');
  assert.equal(plan.recommendedProduct.adCopy.cta,'Jetzt bei Homestro kaufen');
  assert.equal(plan.executionEnabled,false);
  assert.equal(plan.adSpendEUR,0);
  assert.deepEqual(plan.budgetPolicy,{maxDailyEUR:5,maxDays:7,maxCampaigns:1,automaticScalingAboveCap:false});
});

test('archived, unprofitable, and unsupported products never qualify for an ad test',()=>{
  const archived=product({id:'gid://shopify/Product/2',status:'ARCHIVED'});
  const lowMargin=product({id:'gid://shopify/Product/3',pricing:{costVerified:true,marginEUR:4}});
  const plan=buildSalesPlan({products:[archived,lowMargin],productSales:{status:'connected',byTitle:{
    'faltbare reisetasche':{orders:2,netSalesEUR:79.8}},byPath:{'/products/faltbare-reisetasche':{sessions:20,carts:2,checkouts:1}}}});
  assert.equal(plan.recommendedProductId,null);
  assert.ok(plan.products[0].blockedBy.includes('PRODUCT_NOT_ACTIVE'));
  assert.ok(plan.products[1].blockedBy.includes('MINIMUM_MARGIN_NOT_MET'));
});

test('missing sales permission and absent demand remain explicit blockers',()=>{
  const plan=buildSalesPlan({products:[product()],productSales:{status:'permission_required',missingScopes:['read_reports'],byTitle:{},byPath:{}}});
  assert.equal(plan.recommendedProduct,null);
  assert.ok(plan.products[0].blockedBy.includes('PRODUCT_DEMAND_DATA_UNAVAILABLE'));
});

test('Shopify product reports read both product orders and human landing-page intent',async()=>{
  const calls=[];
  const graphql=async(_query,variables={})=>{
    calls.push(variables.query||'scopes');
    if(!variables.query)return {currentAppInstallation:{accessScopes:[{handle:'read_reports'}]}};
    if(variables.query.includes('FROM sales'))return {shopifyqlQuery:{parseErrors:[],tableData:{
      columns:[{name:'product_title'},{name:'gross_sales'},{name:'net_sales'},{name:'orders'}],
      rows:[['Faltbare Reisetasche','79.80','75.00','2']]}}};
    return {shopifyqlQuery:{parseErrors:[],tableData:{
      columns:[{name:'landing_page_path'},{name:'sessions'},{name:'sessions_with_cart_additions'},{name:'sessions_that_reached_checkout'}],
      rows:[['/products/faltbare-reisetasche','13','1','0']]}}};
  };
  const report=await readProductSales(graphql,{days:90});
  assert.equal(report.status,'connected');
  assert.equal(report.byTitle['faltbare reisetasche'].orders,2);
  assert.equal(report.byPath['/products/faltbare-reisetasche'].sessions,13);
  assert.equal(calls.length,3);
});

test('scheduled product-demand refresh caches permission state instead of retrying every minute',async()=>{
  const queries=[];let saved;
  const pool={query:async(sql,args=[])=>{
    queries.push(sql);
    if(sql.startsWith('SELECT payload'))return {rows:[]};
    if(sql.startsWith('INSERT INTO marketing_product_sales')){saved=args[0];return {rows:[]};}
    return {rows:[]};
  }};
  const result=await refreshProductSales({pool,graphql:async()=>({currentAppInstallation:{accessScopes:[{handle:'read_products'}]}})});
  assert.equal(result.status,'permission_required');
  assert.deepEqual(saved.missingScopes,['read_reports']);
  assert.ok(queries.some(q=>q.includes('CREATE TABLE IF NOT EXISTS marketing_product_sales')));
});

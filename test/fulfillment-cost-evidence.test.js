'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {fulfillmentCostEvidence}=require('../fulfillment-cost-evidence');
const url='https://www.aliexpress.com/item/123456789.html';
const variants=[{id:'gid://shopify/ProductVariant/1',inventoryItem:{unitCost:{amount:'15',currencyCode:'EUR'}}}];
const payload={currency:'EUR',destinationCountry:'DE',quotedAt:new Date().toISOString(),variants:[{variantId:variants[0].id,sourceUrl:url,supplierCostEur:15,shippingEur:2,procurementTaxEur:0}]};
test('explicit variant quote verifies real destination landed components',()=>{
 const result=fulfillmentCostEvidence(JSON.stringify(payload),variants,url);
 assert.equal(result.verified,true);assert.equal(result.landedByVariant[variants[0].id],17);
});
test('unknown shipping, absent source, cost mismatch and wrong destination cannot verify',()=>{
 for(const change of [{shippingEur:undefined},{sourceUrl:''},{supplierCostEur:14},{shippingEur:-1},{shippingEur:'0'}]) {
  assert.equal(fulfillmentCostEvidence({...payload,variants:[{...payload.variants[0],...change}]},variants,url).verified,false);
 }
 for(const change of [{quotedAt:''},{currency:'USD'},{destinationCountry:'CN'}, {variants:[]}]) assert.equal(fulfillmentCostEvidence({...payload,...change},variants,url).verified,false);
 assert.equal(fulfillmentCostEvidence(undefined,variants,url).verified,false);
});

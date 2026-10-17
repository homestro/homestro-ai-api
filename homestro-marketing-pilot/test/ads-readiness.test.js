import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAdsReadiness} from '../modules/ads-readiness.js';

const active=(id,categoryKey='home')=>({status:'ready',document:{
  id,status:'ACTIVE',categoryKey,rejected:false,url:`https://homestro.de/products/${id}`,
  variants:[{available:true,price:19.99}]
}});

test('planner is read-only and always keeps spend and campaign execution at zero',()=>{
  const plan=buildAdsReadiness({products:[active('a')]});
  assert.equal(plan.mode,'read_only_plan');
  assert.equal(plan.adSpendEUR,0);
  assert.equal(plan.spendCapEUR,0);
  assert.equal(plan.executionEnabled,false);
  assert.equal(plan.campaignCreationEnabled,false);
  assert.ok(plan.channels.every(c=>c.spendCapEUR===0&&c.executionEnabled===false));
});

test('only active, ready, available, Homestro products enter campaign ideas',()=>{
  const plan=buildAdsReadiness({products:[
    active('good','pet'),{...active('pending'),status:'pending_marketing'},
    {...active('rejected'),document:{...active('rejected').document,rejected:true}},
    {...active('out'),document:{...active('out').document,variants:[{available:false,price:20}]}},
    {...active('external'),document:{...active('external').document,url:'https://example.com/products/x'}}
  ]});
  assert.equal(plan.productCounts.catalog,5);
  assert.equal(plan.productCounts.marketingReadyCandidates,1);
  assert.deepEqual(plan.productCounts.byCategory,{pet:1});
});

test('Google never appears approved from feed readiness alone',()=>{
  const plan=buildAdsReadiness({products:[active('a')],feedEnabled:true,merchantApprovalConfirmed:false});
  assert.equal(plan.googleFreeListings.eligibleToSubmit,false);
  assert.equal(plan.googleFreeListings.paidAdsReady,false);
  assert.ok(plan.blockers.includes('MERCHANT_CENTER_NOT_APPROVED'));
});

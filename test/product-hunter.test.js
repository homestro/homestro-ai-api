'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getProductRules, validateProductEconomics } = require('../homestro-rules');
const { catalogCandidateRejection, externalCandidateRejection, targetSellingPrice } = require('../product-hunter');

test('central rules provide one set of defaults and environment overrides', () => {
  assert.deepEqual(getProductRules({}), {
    maxCost: 15, minSellingPrice: 34.9, minRatio: 3, minSold: 1000, minNetProfit: 12,
    headphoneMinCost: 10, headphoneMaxCost: 27, headphoneMinRatio: 2.9, amazonMinMatchConfidence: 0.85
  });
  assert.equal(getProductRules({ MAX_PRODUCT_COST: '9' }).maxCost, 9);
  assert.equal(validateProductEconomics({ cost: 10, sellingPrice: 35 }, {}).valid, true);
  assert.equal(validateProductEconomics({ cost: 16, sellingPrice: 60 }, {}).valid, false);
});

test('Product Hunter accepts a genuine qualifying EU supplier candidate', () => {
  const rules = getProductRules({});
  const candidate = {
    id: '1005001234567890', source_url: 'https://www.aliexpress.com/item/1005001234567890.html',
    title: 'Kitchen cleaning stain remover tool', cost: 10, sold: 2500, euWarehouse: true
  };
  const reason = catalogCandidateRejection(candidate, rules, () => ({ estimatedProfitEur: 15 }));
  assert.equal(reason, '');
  assert.equal(targetSellingPrice(candidate.cost, false, rules), 34.9);
});

test('Product Hunter consistently rejects candidates outside central limits', () => {
  const rules = getProductRules({});
  const base = { id: '12345678', source_url: 'https://example.test/item', title: 'Kitchen cleaning tool', cost: 10, sold: 2500 };
  assert.match(catalogCandidateRejection({ ...base, sold: 999 }, rules, () => ({ estimatedProfitEur: 20 })), /^sold-under-1000/);
  assert.match(catalogCandidateRejection({ ...base, cost: 16 }, rules, () => ({ estimatedProfitEur: 20 })), /^cost-outside-range/);
  assert.match(catalogCandidateRejection(base, rules, () => ({ estimatedProfitEur: 11 })), /^profit-under-12/);
});

test('configured API and feed source shapes preserve their real cost field', () => {
  const rules = getProductRules({});
  const common = { id: '1005001234567890', sold: 2000, euWarehouse: true };
  assert.equal(externalCandidateRejection({ ...common, cost: 9.5, source_type: 'aliexpress-affiliate-api' }, rules), '');
  assert.equal(externalCandidateRejection({ ...common, cost: 8, source_type: 'cj-api' }, rules), '');
  assert.equal(externalCandidateRejection({ ...common, cost: 7, source_type: 'homestro-feed' }, rules), '');
  assert.equal(externalCandidateRejection({ ...common, costEur: 6, source_type: 'aliexpress-apify' }, rules), '');
});

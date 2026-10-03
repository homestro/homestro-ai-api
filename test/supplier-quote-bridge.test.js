'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateQuote, saveSupplierQuote, registerSupplierQuoteBridge, PRODUCT_QUERY, DEFINITIONS_QUERY, DEFINITION_MUTATION, SAVE_MUTATION } = require('../supplier-quote-bridge');
const now = Date.parse('2026-10-03T20:00:00Z');
const sourceUrl = 'https://www.aliexpress.com/item/1005001234567.html';
function fixture(combined = false) {
  const product = { id: 'gid://shopify/Product/1', status: 'DRAFT', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/2', sku: '200000182:193#White', inventoryItem: { unitCost: { amount: combined ? '17' : '15', currencyCode: 'EUR' } } }], pageInfo: { hasNextPage: false } }, metafields: { nodes: [] } };
  const input = { sourceUrl, currency: 'EUR', destinationCountry: 'DE', quotedAt: '2026-10-03T19:00:00Z', shopifyUnitCostBasis: combined ? 'PRODUCT_AND_SHIPPING' : 'PRODUCT_ONLY', variants: [{ variantId: product.variants.nodes[0].id, shopifySku: product.variants.nodes[0].sku, supplierVariantId: 'supplier-white', sourceUrl, supplierCostEur: 15, shippingEur: 2, procurementTaxEur: 0 }] };
  return { product, input };
}
test('DSers combined cost is reconciled once, without double counting shipping', () => {
  for (const combined of [false, true]) {
    const { product, input } = fixture(combined);
    assert.equal(validateQuote(product, input, now).evidence.landedByVariant[product.variants.nodes[0].id], 17);
  }
});
test('missing shipping, stale quotes, wrong supplier, wrong SKU and partial variants fail closed', () => {
  for (const mutate of [
    input => { delete input.variants[0].shippingEur; },
    input => { input.quotedAt = '2026-10-01T00:00:00Z'; },
    input => { input.quotedAt = '2026-10-03T21:00:00Z'; },
    input => { input.variants[0].sourceUrl = 'https://www.aliexpress.com/item/999999.html'; },
    input => { input.variants[0].shopifySku = 'Black'; },
    input => { input.variants[0].supplierVariantId = ''; },
    input => { input.variants = []; },
    input => { delete input.shopifyUnitCostBasis; },
    input => { input.variants[0].supplierCostEur = 14; },
    input => { input.destinationCountry = 'US'; }
  ]) {
    const { product, input } = fixture(); mutate(input);
    assert.throws(() => validateQuote(product, input, now));
  }
});
function fakeStore(product, options = {}) {
  const calls = []; let reads = 0;
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    if (query === PRODUCT_QUERY) {
      reads++;
      if (options.activateOnSecondRead && reads === 2) product.status = 'ACTIVE';
      return { product: structuredClone(product) };
    }
    if (query === DEFINITIONS_QUERY) return { metafieldDefinitions: { nodes: [], pageInfo: { hasNextPage: false } } };
    if (query === DEFINITION_MUTATION) return { metafieldDefinitionCreate: { createdDefinition: { id: 'definition' }, userErrors: [] } };
    if (query === SAVE_MUTATION) {
      if (options.conflict) return { metafieldsSet: { userErrors: [{ message: 'compareDigest conflict' }] } };
      if (!options.badReadback) product.metafields.nodes = variables.metafields.map(field => ({ ...field, compareDigest: 'saved' }));
      return { metafieldsSet: { userErrors: [] } };
    }
    throw new Error('Unexpected operation');
  };
  return { graphql, calls };
}
test('bridge creates definitions, atomically stores evidence and verifies actual readback', async () => {
  const { product, input } = fixture(true); const store = fakeStore(product);
  const result = await saveSupplierQuote({ graphql: store.graphql, token: 'test', productId: product.id, input, now });
  assert.equal(result.status, 'DRAFT'); assert.equal(result.landedCostVerified, true);
  assert.equal(result.pricesChanged, false); assert.equal(result.published, false);
  const save = store.calls.find(call => call.query === SAVE_MUTATION);
  assert.equal(save.variables.metafields.length, 3);
  assert.ok(save.variables.metafields.every(field => field.compareDigest === null));
  assert.ok(store.calls.findIndex(call => call.query === DEFINITION_MUTATION) < store.calls.indexOf(save));
  assert.equal(store.calls.filter(call => call.query === PRODUCT_QUERY).length, 3);
  assert.ok(store.calls.every(call => !/productUpdate|publishablePublish|inventoryItemUpdate/.test(call.query)));
});
test('rejects ACTIVE products, concurrent activation, compare-and-set failures and bad readback', async () => {
  for (const options of [{ initiallyActive: true }, { activateOnSecondRead: true }, { conflict: true }, { badReadback: true }]) {
    const { product, input } = fixture(); if (options.initiallyActive) product.status = 'ACTIVE';
    const store = fakeStore(product, options);
    await assert.rejects(saveSupplierQuote({ graphql: store.graphql, productId: product.id, input, now }));
    if (options.initiallyActive || options.activateOnSecondRead) assert.ok(!store.calls.some(call => call.query === SAVE_MUTATION));
  }
});
test('both bridge routes require the existing API-key middleware', () => {
  const routes = []; const apiKey = () => {};
  registerSupplierQuoteBridge({ get: (...args) => routes.push(args), post: (...args) => routes.push(args) }, { apiKey, graphql: () => {}, getToken: () => {} });
  assert.equal(routes.length, 2); assert.ok(routes.every(route => route[1] === apiKey));
});

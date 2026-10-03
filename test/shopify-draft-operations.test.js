'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { collectionAssignmentRequest, optionNameUpdateRequest } = require('../shopify-draft-operations');

test('collection assignment uses the Admin API collectionAddProducts schema', () => {
  const request = collectionAssignmentRequest('gid://shopify/Collection/20', 'gid://shopify/Product/10');
  assert.match(request.query, /collectionAddProducts\(id:\$id,productIds:\$productIds\)/);
  assert.doesNotMatch(request.query, /collectionsAddProducts|collectionIds/);
  assert.deepEqual(request.variables, {
    id: 'gid://shopify/Collection/20',
    productIds: ['gid://shopify/Product/10']
  });
});

test('option normalization updates option values in place without recreating variants', () => {
  const request = optionNameUpdateRequest(
    'gid://shopify/Product/10',
    'gid://shopify/ProductOption/30',
    'Farbe',
    [{ id: 'gid://shopify/ProductOptionValue/40', name: 'Schwarz' }]
  );
  assert.match(request.query, /\$option:OptionUpdateInput!/);
  assert.match(request.query, /\$optionValuesToUpdate:\[OptionValueUpdateInput!\]/);
  assert.match(request.query, /variantStrategy:LEAVE_AS_IS/);
  assert.doesNotMatch(request.query, /productVariantsBulkCreate|productOptionsDelete/);
  assert.deepEqual(request.variables.option, { id: 'gid://shopify/ProductOption/30', name: 'Farbe' });
  assert.deepEqual(request.variables.optionValuesToUpdate, [{ id: 'gid://shopify/ProductOptionValue/40', name: 'Schwarz' }]);
});

test('collection and option failures are optional pending steps in the DRAFT processor', () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const processor = source.slice(source.indexOf('async function processExistingDraftProduct'), source.indexOf('\nasync function processExistingDrafts'));
  assert.match(processor, /optionalDraftOperation\('option-normalization'/);
  assert.match(processor, /optionalDraftOperation\('collection-assignment'/);
  assert.match(processor, /assertDraftProduct\(verified\)/);
  assert.doesNotMatch(processor, /status\s*:\s*['"]ACTIVE['"]|publishablePublish|publication/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('merged draft autopilot retains supplier pending and current Shopify mutations', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const operations = fs.readFileSync(require.resolve('../shopify-draft-operations.js'), 'utf8');

  assert.doesNotMatch(server + operations, /^(?:<<<<<<<|=======|>>>>>>>)/m);
  assert.match(server, /supplierProcessingState\(reference\)/);
  assert.match(server, /processed:true,skipped:false,reason:supplierState\.reason/);
  assert.match(operations, /collectionAddProducts\(id:\$id,productIds:\$productIds\)/);
  assert.match(operations, /productOptionUpdate\(productId:\$productId,option:\$option,optionValuesToUpdate:\$optionValuesToUpdate,variantStrategy:LEAVE_AS_IS\)/);
  assert.match(server, /optionalDraftOperation\('option-normalization'/);
  assert.match(server, /optionalDraftOperation\('collection-assignment'/);
});

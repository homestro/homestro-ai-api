'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSelectedDraftId } = require('../selected-draft');
test('targeted draft request accepts exactly one Shopify Product GID', () => {
  assert.equal(normalizeSelectedDraftId('gid://shopify/Product/123'), 'gid://shopify/Product/123');
  assert.equal(normalizeSelectedDraftId(undefined), null);
  for (const value of ['', '123', 'gid://shopify/Product/0', 'gid://shopify/ProductVariant/123', ['gid://shopify/Product/1','gid://shopify/Product/2']]) {
    assert.throws(() => normalizeSelectedDraftId(value), { status: 400 });
  }
});

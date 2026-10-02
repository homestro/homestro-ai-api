'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { assertDraftProduct, isDraftProduct } = require('../shopify-safety');

test('server-side Shopify safety accepts DRAFT and rejects ACTIVE', () => {
  assert.equal(isDraftProduct({ status: 'DRAFT' }), true);
  assert.doesNotThrow(() => assertDraftProduct({ status: 'DRAFT' }));
  assert.throws(() => assertDraftProduct({ status: 'ACTIVE' }), /only DRAFT/);
});

test('automatic mutation paths use the shared DRAFT guard', () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(source, /assertDraftProduct\(p\)/);
  assert.match(source, /isDraftProduct\(p\).*homestro-ai-processed-existing/);
  assert.match(source, /async function updateVariants[\s\S]*?assertDraftProduct\(safety\.product\)/);
});

test('Sidekick mutation safety accepts DRAFT and rejects ACTIVE', async () => {
  const { assertDraftStatus } = await import('../extensions/homestro-sidekick/src/safety.mjs');
  assert.doesNotThrow(() => assertDraftStatus({ status: 'DRAFT' }));
  assert.throws(() => assertDraftStatus({ status: 'ACTIVE' }), /only DRAFT/);
});

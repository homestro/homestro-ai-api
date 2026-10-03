'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { contentReadiness } = require('../content-readiness');
const ready = { aiSucceeded: true, imagesVerified: true };
test('low margin and unverified costs do not block completed content', () => {
  const qa = { ok: false, reasons: ['variant-margin:0', 'landed-cost-unverified'] };
  assert.equal(contentReadiness(qa, ready).complete, true);
  assert.deepEqual(contentReadiness(qa, ready).advisoryReasons, qa.reasons);
  assert.equal(qa.ok, false);
});
test('content defects, invalid prices and missing images still block content readiness', () => {
  for (const reason of ['seo','german-content','variant-label:0','variant-price:0','variant-image:0','draft-only']) {
    assert.equal(contentReadiness({reasons:[reason]},ready).complete,false);
  }
  assert.equal(contentReadiness({reasons:[]},{...ready,imagesVerified:false}).complete,false);
  assert.equal(contentReadiness({reasons:[]},{...ready,aiSucceeded:false}).complete,false);
  assert.equal(contentReadiness({reasons:[]},{...ready,optionalPending:['collection-assignment']}).complete,false);
});
test('existing draft processor preserves DSers prices regardless of verified costs', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
  const processor = source.slice(source.indexOf('async function processExistingDraftProduct('),source.indexOf('async function processExistingDrafts('));
  assert.doesNotMatch(processor,/homestroAutoPriceVariants\(/);
  assert.match(processor,/pricingPolicy:'PRESERVE_DSERS'/);
});

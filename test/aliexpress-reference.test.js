'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aliExpressReference, aliExpressReferenceFromProduct } = require('../aliexpress-reference');

test('recovers the supplier link and ID from DSers-style HTML descriptions', () => {
  const result = aliExpressReference({ description: '<p>Quelle: <a href="https://www.aliexpress.com/item/1005010173633196.html?sku=42&amp;source=dsers">Produkt</a></p>' });
  assert.equal(result.productId, '1005010173633196');
  assert.equal(result.url, 'https://www.aliexpress.com/item/1005010173633196.html?sku=42&source=dsers');
});
test('uses explicit source metadata and corrects a stale product ID', () => {
  assert.deepEqual(aliExpressReference({ url: 'https://aliexpress.com/item/123456789.html', productId: '111', description: 'https://aliexpress.com/item/222.html' }), { url: 'https://aliexpress.com/item/123456789.html', productId: '123456789' });
});
test('does not accept a different host, credentials trick, or non-item path', () => {
  for (const url of ['https://aliexpress.com.evil.example/item/123.html', 'https://aliexpress.com@evil.example/item/123.html', 'https://aliexpress.com/category/123.html', 'javascript:alert(1)']) {
    assert.deepEqual(aliExpressReference({ url }), { url: '', productId: '' });
  }
});
test('missing supplier data stays missing rather than inventing a source', () => {
  assert.deepEqual(aliExpressReference({ description: 'Ein Produkt ohne Quellenlink' }), { url: '', productId: '' });
});

test('discovers a validated AliExpress URL in accessible DSers-style metadata', () => {
  const result=aliExpressReferenceFromProduct({
    description:'Importierter Artikel',tags:['DSers'],
    metafields:{nodes:[{namespace:'dsers',key:'supplier_url',value:'https://www.aliexpress.com/item/1005010173633196.html?source=dsers'}]},
    variants:{nodes:[{sku:'SKU-42',metafields:{nodes:[]}}]}
  });
  assert.equal(result.productId,'1005010173633196');
  assert.match(result.url,/aliexpress\.com\/item\/1005010173633196\.html/);
});

test('does not fabricate supplier identity from DSers tags, numeric IDs or SKUs', () => {
  assert.deepEqual(aliExpressReferenceFromProduct({tags:['DSers','1005010173633196'],metafields:{nodes:[{namespace:'dsers',key:'product_id',value:'1005010173633196'}]},variants:{nodes:[{sku:'ALI-1005010173633196'}]}}),{url:'',productId:''});
});

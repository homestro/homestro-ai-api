'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { supplierReferenceMetafields } = require('../supplier-reference');
const { validateProductEconomics } = require('../homestro-rules');
test('retains imported real source URL before supplier description is overwritten', () => {
 const product={id:'gid://shopify/Product/1',status:'DRAFT',description:'<a href="https://www.aliexpress.com/item/123456789.html">Supplier</a>'};
 const fields=supplierReferenceMetafields(product);
 assert.equal(fields.length,2);
 const saved=Object.fromEntries(fields.map(f=>[f.key,f.value]));
 assert.deepEqual(supplierReferenceMetafields({...product,description:'German content without source'},saved),[]);
 assert.equal(saved.aliexpress_product_id,'123456789');
 assert.throws(()=>supplierReferenceMetafields({...product,status:'ACTIVE'}),/only DRAFT/);
 assert.deepEqual(supplierReferenceMetafields({...product,description:'DSers product 123456789'},{}),[]);
});
test('validation accepts profitable ratios below 3 but keeps shipping pending', () => {
 const result=validateProductEconomics({cost:15,sellingPrice:39},{});
 assert.equal(result.valid,true); assert.equal(result.sellReady,false);
 assert.equal(validateProductEconomics({cost:15,sellingPrice:35},{}).valid,false);
});

test('Sidekick preserves legitimate source and rejects ACTIVE and spoofed URLs', async () => {
 const { sourceMetafieldsBeforeRewrite }=await import('../extensions/homestro-sidekick/src/safety.mjs');
 const product={id:'gid://shopify/Product/1',status:'DRAFT',descriptionHtml:'<a href="https://www.aliexpress.com/item/123456789.html">Source</a>'};
 assert.equal(sourceMetafieldsBeforeRewrite(product).length,2);
 assert.throws(()=>sourceMetafieldsBeforeRewrite({...product,status:'ACTIVE'}),/only DRAFT/);
 assert.deepEqual(sourceMetafieldsBeforeRewrite({...product,descriptionHtml:'https://evil.test/item/123.html'}),[]);
});

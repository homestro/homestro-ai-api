'use strict';
const { aliExpressReference } = require('./aliexpress-reference');
const { assertDraftProduct } = require('./shopify-safety');
function supplierReferenceMetafields(product, existing = {}, verifiedReference) {
  assertDraftProduct(product);
  const candidate = verifiedReference || { url: existing.aliexpress_url, productId: existing.aliexpress_product_id, description: product.description };
  const reference = aliExpressReference(candidate);
  if (!reference.url || !reference.productId) return [];
  return [
    { ownerId: product.id, namespace: 'homestro', key: 'aliexpress_url', type: 'single_line_text_field', value: reference.url },
    { ownerId: product.id, namespace: 'homestro', key: 'aliexpress_product_id', type: 'single_line_text_field', value: reference.productId }
  ].filter(field => String(existing[field.key] || '') !== field.value);
}
module.exports = { supplierReferenceMetafields };

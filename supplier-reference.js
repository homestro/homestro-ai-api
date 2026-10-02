'use strict';
const { aliExpressReference } = require('./aliexpress-reference');
const { assertDraftProduct } = require('./shopify-safety');
function supplierReferenceMetafields(product, existing = {}) {
  assertDraftProduct(product);
  const reference = aliExpressReference({ url: existing.aliexpress_url, productId: existing.aliexpress_product_id, description: product.description });
  if (!reference.url || !reference.productId) return [];
  return [
    { ownerId: product.id, namespace: 'homestro', key: 'aliexpress_url', type: 'single_line_text_field', value: reference.url },
    { ownerId: product.id, namespace: 'homestro', key: 'aliexpress_product_id', type: 'single_line_text_field', value: reference.productId }
  ].filter(field => String(existing[field.key] || '') !== field.value);
}
module.exports = { supplierReferenceMetafields };

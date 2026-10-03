'use strict';

function aliExpressReference({ url = '', productId = '', description = '' } = {}) {
  const candidate = String(url).trim() || String(description).match(/https?:\/\/(?:www\.)?aliexpress\.com\/item\/\d+\.html[^\s<>"']*/i)?.[0] || '';
  if (!candidate) return { url: '', productId: String(productId || '').trim() };
  try {
    const parsed = new URL(candidate.replace(/&amp;/g, '&'));
    if (!['http:', 'https:'].includes(parsed.protocol) || !/^(?:www\.)?aliexpress\.com$/i.test(parsed.hostname)) return { url: '', productId: '' };
    const id = parsed.pathname.match(/^\/item\/(\d+)\.html$/)?.[1];
    if (!id) return { url: '', productId: '' };
    // A real URL determines the identity; stale IDs must not point to another item.
    return { url: parsed.href, productId: id };
  } catch {
    return { url: '', productId: '' };
  }
}

function aliExpressReferenceFromProduct(product = {}, existing = {}) {
  const explicitValues = [
    existing.aliexpress_url,
    product.description,
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(product.metafields?.nodes || []).map(field => field?.value),
    ...(product.variants?.nodes || []).flatMap(variant => [
      variant?.sku,
      ...(variant?.metafields?.nodes || []).map(field => field?.value)
    ])
  ];
  // Only a literal, validated AliExpress item URL is evidence. Numeric SKUs,
  // tags, titles and standalone IDs are intentionally insufficient.
  for (const value of explicitValues) {
    const reference = aliExpressReference({ description: String(value || '') });
    if (reference.url && reference.productId) return reference;
  }
  return aliExpressReference({ productId: existing.aliexpress_product_id });
}

module.exports = { aliExpressReference, aliExpressReferenceFromProduct };

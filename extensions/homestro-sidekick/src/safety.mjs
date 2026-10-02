export function assertDraftStatus(product) {
  if (String(product?.status || '').toUpperCase() !== 'DRAFT') {
    throw new Error('Safety guard: only DRAFT products may be modified.');
  }
  return product;
}

export function sourceMetafieldsBeforeRewrite(product) {
  assertDraftStatus(product);
  const existing = Object.fromEntries((product?.metafields?.nodes || []).map(m => [m.key, m.value]));
  const raw = String(existing.aliexpress_url || '').trim() || String(product.descriptionHtml || '').match(/https?:\/\/(?:www\.)?aliexpress\.com\/item\/\d+\.html[^\s<>"']*/i)?.[0];
  if (!raw) return [];
  let url;
  try { url = new URL(raw.replace(/&amp;/g, '&')); } catch { return []; }
  const id = url.pathname.match(/^\/item\/(\d+)\.html$/)?.[1];
  if (!id || !['http:', 'https:'].includes(url.protocol) || !/^(?:www\.)?aliexpress\.com$/i.test(url.hostname)) return [];
  return [
    { ownerId: product.id, namespace: 'homestro', key: 'aliexpress_url', type: 'single_line_text_field', value: url.href },
    { ownerId: product.id, namespace: 'homestro', key: 'aliexpress_product_id', type: 'single_line_text_field', value: id }
  ].filter(m => existing[m.key] !== m.value);
}

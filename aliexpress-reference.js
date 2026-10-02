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

module.exports = { aliExpressReference };

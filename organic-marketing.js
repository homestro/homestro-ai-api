'use strict';

// Pure planning: no external calls, paid ads, or automatic publishing.
function buildOrganicDraft(product, channel = 'facebook') {
  if (!['facebook', 'instagram'].includes(channel)) throw new Error('Unsupported channel');
  if (product.status !== 'ACTIVE') throw new Error('Only ACTIVE products are eligible');
  if (product.reviewPending || (product.tags || []).some(tag => /(?:manual-review|ai-qa)-pending/.test(tag))) {
    throw new Error('Product requires review');
  }
  const title = String(product.title || '').trim();
  if (!title) throw new Error('Product title is required');
  const url = new URL(product.url);
  if (url.protocol !== 'https:' || !['homestro.de', 'www.homestro.de'].includes(url.hostname) || !url.pathname.startsWith('/products/')) {
    throw new Error('A Homestro product URL is required');
  }
  const price = Number(product.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Verified positive price is required');
  if (product.available !== true) throw new Error('Availability must be confirmed');
  if (!product.imageUrl) throw new Error('Product image is required');
  const image = new URL(product.imageUrl);
  if (image.protocol !== 'https:') throw new Error('HTTPS image is required');
  url.searchParams.set('utm_source', channel);
  url.searchParams.set('utm_medium', 'organic_social');
  url.searchParams.set('utm_campaign', 'homestro_organic_pilot');
  url.searchParams.set('utm_content', String(product.id || product.handle || 'product'));
  const formatted = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(price);
  return {
    productId: String(product.id || ''), channel, status: 'DRAFT',
    caption: `${title}\n\nJetzt bei Homestro entdecken: ${formatted}\nDetails und Versandkosten im Shop.\n\n${channel === 'instagram' ? 'Zum Shop über den Link im Profil.' : url.href}`,
    trackedUrl: url.href, imageUrl: image.href,
    requiresReview: true, published: false, paidAds: false, aiRequests: 0,
    note: channel === 'instagram' ? 'The tracked product URL must be made accessible from the profile; caption links are not the intended click path.' : null
  };
}

module.exports = { buildOrganicDraft };

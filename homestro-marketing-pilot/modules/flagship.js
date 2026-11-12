export const PRIORITY_PRODUCT_TITLE = 'Erazer XP6';
export const PRIORITY_PRODUCT_HANDLE = 'erazer-xp6';
export const PRIORITY_PRODUCT_PRICE_EUR = 47.99;

const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('de-DE');
export function isPriorityProduct(product) {
  const title = normalize(product?.title || product?.localized?.title || product?.germanCopy?.title);
  const handle = normalize(product?.handle);
  let path = '';
  try { path = normalize(new URL(product?.url || product?.onlineStoreUrl || '').pathname); } catch {}
  return /\\berazer[\\s-]+xp6\\b/.test(title) ||
    handle === PRIORITY_PRODUCT_HANDLE ||
    path.endsWith('/products/' + PRIORITY_PRODUCT_HANDLE);
}

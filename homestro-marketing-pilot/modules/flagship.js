import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const priorityConfig=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../../jarvis_agents/erazer_priority.json'),'utf8'));
export const PRIORITY_PRODUCT_CONFIG=priorityConfig;
export const PRIORITY_PRODUCT_TITLE=priorityConfig.title;
export const PRIORITY_PRODUCT_HANDLE=priorityConfig.handle;
export const PRIORITY_PRODUCT_PRICE_EUR=priorityConfig.referencePriceEUR;

const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('de-DE');
export function isPriorityProduct(product) {
  const title = normalize(product?.title || product?.localized?.title || product?.germanCopy?.title);
  const handle = normalize(product?.handle);
  let path = '';
  try { path = normalize(new URL(product?.url || product?.onlineStoreUrl || '').pathname); } catch {}
  const handles=[PRIORITY_PRODUCT_HANDLE,...priorityConfig.legacyHandles].map(normalize);
  return /\berazer[\s-]+xp6\b/.test(title) || handles.includes(handle) ||
    handles.some(candidate=>path.endsWith('/products/'+candidate));
}

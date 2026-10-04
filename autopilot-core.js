'use strict';

const RAW_VARIANT = /^(?:[A-Z]|as\s*(?:picture|shown)|default(?:\s+title)?|type\s*[A-Z0-9]+|style\s*[A-Z0-9]+)$/i;
const DIRTY_VARIANT = /(?:^|\s|\/)(?:china|mainland china|cn)(?:$|\s|\/)|\bausführung\s+(?:xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)\b|\bas\s*(?:picture|shown)\b|\b(?:elbow[- ]*\d+\s*pairs?|\d+\s*pcs?)\b/i;
const GERMAN_SIGNAL = /\b(?:der|die|das|und|mit|für|aus|eine?|Produkt|Anwendung|Eigenschaften|Vorteile|Technische|Daten)\b/i;
const FOREIGN_COMMERCE = /\b(?:add to cart|buy now|ships? from|supplier|wholesale|mainland china)\b/i;

function text(value) { return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp);/gi, ' ').replace(/\s+/g, ' ').trim(); }

function normalizeOptionName(value) {
  const name = String(value || '').trim();
  const names = { color: 'Farbe', colors: 'Farbe', colour: 'Farbe', colours: 'Farbe', 'color name': 'Farbe', 'colour name': 'Farbe', size: 'Größe', style: 'Ausführung', model: 'Modell', quantity: 'Menge', material: 'Material', 'ships from': 'Versandlager' };
  return names[name.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')] || name;
}

function normalizeVariantValue(value, { optionName = '', position = 0, imageAlt = '' } = {}) {
  let raw = String(value || '').trim().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
  const alt = String(imageAlt || '').trim();
  if (/^as\s*(?:picture|shown)$/i.test(raw) && alt && !/^image|produktbild$/i.test(alt)) raw = alt;
  const colors = { black: 'Schwarz', white: 'Weiß', red: 'Rot', blue: 'Blau', green: 'Grün', grey: 'Grau', gray: 'Grau', pink: 'Rosa', beige: 'Beige', brown: 'Braun', silver: 'Silber', gold: 'Gold', orange: 'Orange', yellow: 'Gelb', purple: 'Violett' };
  if (colors[raw.toLowerCase()]) return colors[raw.toLowerCase()];
  // Keep standard clothing/product sizes clean for customers. Do not turn
  // S/M/L into labels such as "Ausführung S".
  if (/^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)$/i.test(raw)) return raw.toUpperCase();
  const elbow = raw.match(/^elbow[- ]*(\d+)\s*pairs?$/i);
  if (elbow) return `Ellbogenbandage – ${elbow[1]} Paar`;
  const count = raw.match(/^(\d+)\s*(?:pcs?|pieces?)$/i);
  if (count) return `${count[1]} Stück`;
  if (/^default(?:\s+title)?$/i.test(raw)) return 'Standardausführung';
  if (/^[A-Z]$/i.test(raw)) return `${normalizeOptionName(optionName) || 'Ausführung'} ${raw.toUpperCase()}`;
  raw = raw.replace(/\bas picture\b/gi, `Ausführung ${position + 1}`)
    .replace(/\bwith\b/gi, 'mit').replace(/\bwithout\b/gi, 'ohne')
    .replace(/\bpair\b/gi, 'Paar').replace(/\bpcs?\b/gi, 'Stück');
  return raw || `Ausführung ${position + 1}`;
}

function priceForCost(cost, currentPrice, rules = {}) {
  const landed = Number(cost);
  if (!Number.isFinite(landed) || landed <= 0) return null;
  const minPrice = Number(rules.minSellingPrice ?? 34.9);
  const minProfit = Number(rules.minNetProfit ?? 10);
  const commission = Number(rules.commissionRate ?? 0.14) * (1 + Number(rules.feeVatRate ?? 0.19));
  const ad = Number(rules.adRate ?? 0.15);
  const orderFee = Number(rules.orderFee ?? 0.45) * (1 + Number(rules.feeVatRate ?? 0.19));
  const denominator = 1 - commission - ad;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const profitFloor = (landed + orderFee + minProfit) / denominator;
  const target = Math.max(minPrice, profitFloor, Number(currentPrice) || 0);
  return Number((Math.ceil((target - 1e-9) * 10) / 10).toFixed(2));
}

function canonicalImageUrl(url) {
  try { const u = new URL(String(url)); u.search = ''; return `${u.origin}${u.pathname}`.replace(/_(?:\d+x\d+|small|medium|large)(?=\.)/i, ''); } catch { return String(url || '').split('?')[0]; }
}

function selectImages(images = [], { max = 7 } = {}) {
  const seen = new Set();
  return images.filter(image => {
    const url = image?.url || image?.image?.url || '';
    const key = canonicalImageUrl(url).toLowerCase();
    if (!url || seen.has(key)) return false;
    seen.add(key);
    const alt = String(image?.alt || image?.altText || '').toLowerCase();
    const width = Number(image?.width || image?.image?.width || 0), height = Number(image?.height || image?.image?.height || 0);
    return !/logo|banner|sprite|size[-_ ]?chart|zahlung|payment|versand|shipping/.test(`${url} ${alt}`) && (!width || width >= 600) && (!height || height >= 600);
  }).sort((a, b) => {
    const score = x => { const w = Number(x?.width || x?.image?.width || 0), h = Number(x?.height || x?.image?.height || 0); return (w && h ? Math.min(w, h) : 0) - Math.abs(w - h) * .2; };
    return score(b) - score(a);
  }).slice(0, max);
}

function categoryKey(value) {
  const v = text(value).toLowerCase();
  if (/küche|messer|kochen|besteck/.test(v)) return 'kueche';
  if (/reinig|haushalt|organizer|wohnen/.test(v)) return 'haushalt';
  if (/hund|katze|haustier/.test(v)) return 'haustiere';
  if (/fitness|sport|training|yoga/.test(v)) return 'sport';
  if (/garten|werkzeug/.test(v)) return 'garten';
  if (/beauty|pflege|nagel|kosmetik/.test(v)) return 'beauty';
  if (/kopfhörer|elektronik|bluetooth/.test(v)) return 'elektronik';
  return 'haushalt';
}

function variantMediaAssociations(variants = [], media = []) {
  const normalizedMedia = media.map(m => ({ id: m?.id, haystack: text([m?.alt, m?.image?.altText].join(' ')).toLowerCase() })).filter(m => m.id && m.haystack);
  return variants.map(variant => {
    if (variant?.image?.id || variant?.image?.url) return null;
    const values = (variant.selectedOptions || []).map(o => normalizeVariantValue(o.value, { optionName: o.name }).toLowerCase()).filter(v => v.length > 2);
    const matches = normalizedMedia.filter(m => values.some(value => m.haystack.includes(value)));
    return matches.length === 1 ? { variantId: variant.id, mediaIds: [matches[0].id] } : null;
  }).filter(Boolean);
}

function qaProduct(product = {}) {
  const reasons = [];
  const body = text(product.description || product.descriptionHtml);
  if (!text(product.title) || text(product.title).length < 12) reasons.push('title');
  if (body.length < 900 || !GERMAN_SIGNAL.test(body) || FOREIGN_COMMERCE.test(body)) reasons.push('german-content');
  const seoTitle = text(product.seo?.title || product.seoTitle), seoDescription = text(product.seo?.description || product.seoDescription);
  if (!seoTitle || !seoDescription || seoTitle.length < 20 || seoTitle.length > 70 || seoDescription.length < 80 || seoDescription.length > 320) reasons.push('seo');
  const variants = product.variants?.nodes || product.variants || [];
  if (!variants.length) reasons.push('variants');
  variants.forEach((v, index) => {
    if ((v.selectedOptions || []).some(o => normalizeOptionName(o.name) !== String(o.name || '').trim())) reasons.push(`variant-option-name:${index}`);
    const values = (v.selectedOptions || []).map(o => o.value);
    if (values.some((value, i) => {
      const label = String(value).trim(), name = normalizeOptionName(v.selectedOptions[i].name);
      if (name === 'Größe' && /^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[1-6]XL)$/i.test(label)) return false;
      if (/^(?:curl|schwung)$/i.test(name) && /^[CD]$/i.test(label)) return false;
      return RAW_VARIANT.test(label) || DIRTY_VARIANT.test(label);
    })) reasons.push(`variant-label:${index}`);
    const normalizedValues = values.map(v => normalizeVariantValue(v));
    if (new Set(normalizedValues.map(v => String(v).toLowerCase())).size !== normalizedValues.length) reasons.push(`variant-duplicate:${index}`);
    if (!(Number(v.price) > 0)) reasons.push(`variant-price:${index}`);
    const cost = Number(v.cost ?? v.inventoryItem?.unitCost?.amount);
    const required = priceForCost(cost, v.price, product.rules);
    if (!(cost > 0) || required === null || required > Number(v.price)) reasons.push(`variant-margin:${index}`);
    if (variants.length > 1 && !v.image?.url && !v.image?.id) reasons.push(`variant-image:${index}`);
  });
  if (product.landedCostVerified !== true) reasons.push('landed-cost-unverified');
  const images = product.media?.nodes || product.images || [];
  if (selectImages(images).length < 1) reasons.push('images');
  const imageNodes = images.filter(x => x?.image?.url || x?.url || String(x?.mediaContentType || '') === 'IMAGE');
  if (imageNodes.some(x => !text(x?.alt || x?.altText || x?.image?.altText))) reasons.push('image-alt');
  const collections = product.collections?.nodes || product.collections || [];
  const meaningfulCollections = collections.filter(x => !/^(?:alle produkte|all products)/i.test(text(x?.title || x)));
  if (!meaningfulCollections.length) reasons.push('collection');
  if (String(product.status || '').toUpperCase() !== 'DRAFT') reasons.push('draft-only');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

module.exports = { RAW_VARIANT, DIRTY_VARIANT, text, normalizeOptionName, normalizeVariantValue, priceForCost, canonicalImageUrl, selectImages, categoryKey, variantMediaAssociations, qaProduct };

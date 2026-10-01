// Pure helpers for the DRAFT-only Shopify repair flow. This module has no Shopify side effects.
const FORBIDDEN_CUSTOMER_TEXT = /(?:Quelldaten|Herstellerangaben|laut\s+Herstellerangaben|Electronic\s*:|Power\s*Supply|Is\s*Batteries\s*Included|Mainland\s*China|China\s*\(Festland\))/i;
const FUNCTIONAL_VARIANT = /\b(?:heat|hot|heating|massage|traction)\b/i;

function germanVariantLabel(value) {
  return String(value || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b(?:HOT|HEAT|HEATING)\b/gi, 'Wärme')
    .replace(/\bMASSAGE\b/gi, 'Massage')
    .replace(/\bTRACTION\b/gi, 'Traktion')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .join(' + ');
}

function optionNameForValues(name, values = []) {
  const current = String(name || '').trim();
  const looksLikeColor = /^(?:farbe|color|colour|colors|colours)$/i.test(current);
  return looksLikeColor && values.some(value => FUNCTIONAL_VARIANT.test(String(value || '')))
    ? 'Ausführung'
    : current;
}

// Shopify requires values inside one option to remain unique. Normalize functional values,
// then give genuine source collisions a stable, customer-readable discriminator.
function repairVariantOptions(variants = []) {
  const source = Array.isArray(variants) ? variants : [];
  const valuesByOption = new Map();
  for (const variant of source) {
    for (const option of variant.selectedOptions || []) {
      const key = String(option.name || '');
      if (!valuesByOption.has(key)) valuesByOption.set(key, []);
      valuesByOption.get(key).push(option.value);
    }
  }
  const rawToLabel = new Map();
  for (const [optionName, values] of valuesByOption) {
    const used = new Set();
    for (const rawValue of values) {
      const rawKey = `${optionName}\u0000${String(rawValue || '')}`;
      if (rawToLabel.has(rawKey)) continue;
      const base = germanVariantLabel(rawValue);
      let label = base;
      let ordinal = 2;
      while (used.has(label.toLocaleLowerCase('de-DE'))) label = `${base} – Variante ${ordinal++}`;
      used.add(label.toLocaleLowerCase('de-DE'));
      rawToLabel.set(rawKey, label);
    }
  }
  return source.map(variant => ({
    ...variant,
    selectedOptions: (variant.selectedOptions || []).map(option => ({
      name: optionNameForValues(option.name, valuesByOption.get(String(option.name || '')) || []),
      value: rawToLabel.get(`${String(option.name || '')}\u0000${String(option.value || '')}`) || String(option.value || '')
    }))
  }));
}

function qualityCheck(product = {}) {
  const title = String(product.title || '');
  const description = String(product.description || '');
  const seoTitle = String(product.seoTitle || product.seo?.title || '');
  const seoDescription = String(product.seoDescription || product.seo?.description || '');
  const combined = [title, description, seoTitle, seoDescription].join(' ');
  const variants = product.variants || [];
  const variantOptions = variants.flatMap(variant => variant.selectedOptions || []);
  const reasons = [];
  if (!title.trim()) reasons.push('missing-title');
  const plainDescription = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plainDescription) reasons.push('missing-description');
  else if (plainDescription.length < 900) reasons.push('description-too-short');
  if (!seoTitle.trim() || !seoDescription.trim()) reasons.push('missing-seo');
  if (FORBIDDEN_CUSTOMER_TEXT.test(combined)) reasons.push('raw-source-text');
  if (variantOptions.some(option => /\b(?:HOT|HEAT|HEATING|TRACTION|Default Title|As picture)\b/i.test(String(option.value || '')))) reasons.push('raw-variant-label');
  if (variantOptions.some(option => /^(?:Farbe|Color|Colour)$/i.test(String(option.name || '')) && FUNCTIONAL_VARIANT.test(String(option.value || '')))) reasons.push('functional-variant-as-color');
  for (const variant of variants) {
    const keys = (variant.selectedOptions || []).map(option => `${option.name}\u0000${option.value}`.toLocaleLowerCase('de-DE'));
    if (new Set(keys).size !== keys.length) reasons.push('duplicate-variant-option');
  }
  return {ok: reasons.length === 0, reasons: [...new Set(reasons)]};
}

module.exports = {FORBIDDEN_CUSTOMER_TEXT, FUNCTIONAL_VARIANT, germanVariantLabel, optionNameForValues, repairVariantOptions, qualityCheck};

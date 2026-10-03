'use strict';
const { aliExpressReference } = require('./aliexpress-reference');
function fulfillmentCostEvidence(raw, variants, supplierUrl, now = Date.now()) {
  const pending = { verified: false, landedByVariant: {}, reason: 'fulfillment-cost-evidence-missing-or-invalid' };
  let payload; try { payload = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return pending; }
  const expected = aliExpressReference({ url: supplierUrl });
  if (!expected.url || !payload || payload.currency !== 'EUR' || payload.destinationCountry !== 'DE' || !Number.isFinite(Date.parse(payload.quotedAt))) return pending;
  const age = now - Date.parse(payload.quotedAt);
  if (age < -300000 || age > 86400000) return { ...pending, reason: 'fulfillment-cost-evidence-expired' };
  const basis = payload.shopifyUnitCostBasis || 'PRODUCT_ONLY';
  if (!['PRODUCT_ONLY', 'PRODUCT_AND_SHIPPING'].includes(basis)) return pending;
  if (!Array.isArray(payload.variants) || payload.variants.length !== variants.length || !variants.length) return pending;
  const landedByVariant = {};
  for (const v of variants) {
    const rows = payload.variants.filter(row => row.variantId === v.id);
    if (rows.length !== 1) return pending;
    const row = rows[0], ref = aliExpressReference({ url: row.sourceUrl });
    if (!ref.url || ref.productId !== expected.productId) return pending;
    const amounts = [row.supplierCostEur, row.shippingEur, row.procurementTaxEur];
    if (amounts.some(value => typeof value !== 'number' || !Number.isFinite(value)) || row.supplierCostEur <= 0 || row.shippingEur < 0 || row.procurementTaxEur < 0) return pending;
    const recorded = Number(v.inventoryItem?.unitCost?.amount);
    const expectedRecorded = row.supplierCostEur + (basis === 'PRODUCT_AND_SHIPPING' ? row.shippingEur : 0);
    if (!Number.isFinite(recorded) || Math.abs(recorded - expectedRecorded) > .005) return pending;
    if (v.inventoryItem?.unitCost?.currencyCode && v.inventoryItem.unitCost.currencyCode !== 'EUR') return pending;
    if (payload.schemaVersion === 2 && (row.shopifySku !== v.sku || !String(row.supplierVariantId || '').trim())) return pending;
    landedByVariant[v.id] = amounts.reduce((sum, amount) => sum + amount, 0);
  }
  return { verified: true, landedByVariant, reason: '', quotedAt: payload.quotedAt };
}
module.exports = { fulfillmentCostEvidence };

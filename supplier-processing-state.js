'use strict';

const SUPPLIER_PENDING_CHECKS = Object.freeze([
  'actual-dsers-supplier-link',
  'supplier-verification',
  'variant-landed-cost',
  'destination-shipping',
  'matched-market-price'
]);

function supplierProcessingState(reference = {}) {
  const available = Boolean(String(reference.url || '').trim() && String(reference.productId || '').trim());
  return {
    available,
    reason: available ? null : 'verified-supplier-reference-missing',
    pendingChecks: available ? [] : [...SUPPLIER_PENDING_CHECKS]
  };
}

module.exports = { SUPPLIER_PENDING_CHECKS, supplierProcessingState };

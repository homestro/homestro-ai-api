'use strict';

function isDraftProduct(product) {
  return String(product?.status || '').toUpperCase() === 'DRAFT';
}

function assertDraftProduct(product) {
  if (!isDraftProduct(product)) throw new Error('Safety guard: only DRAFT products may be modified');
  return product;
}

module.exports = { isDraftProduct, assertDraftProduct };

export function assertDraftStatus(product) {
  if (String(product?.status || '').toUpperCase() !== 'DRAFT') {
    throw new Error('Safety guard: only DRAFT products may be modified.');
  }
  return product;
}

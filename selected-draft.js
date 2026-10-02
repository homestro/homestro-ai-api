'use strict';
function normalizeSelectedDraftId(value) {
  if (value === undefined || value === null) return null;
  const id = String(value);
  if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(id)) {
    throw Object.assign(new Error('productId must be a Shopify Product GID.'), { status: 400 });
  }
  return id;
}
module.exports = { normalizeSelectedDraftId };

export default () => {
  shopify.tools.register('homestro_product_search', async ({ query = '', limit = 20 }) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const queryPart = query ? `query: ${JSON.stringify(query)}` : '';
    const gql = `query HomestroProducts {
      products(first: ${safeLimit}${queryPart ? `, ${queryPart}` : ''}) {
        nodes {
          id title handle status vendor productType tags totalInventory
          priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
          variants(first: 20) { nodes { id title price sku inventoryQuantity } }
          seo { title description }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    return shopify.query(gql);
  });

  shopify.tools.register('homestro_price_check', async ({ cost, selling_price }) => {
    const c = Number(cost);
    const p = Number(selling_price);
    const ratio = c > 0 ? p / c : 0;
    return {
      valid: Number.isFinite(c) && Number.isFinite(p) && c <= 10 && p >= 34.9 && ratio >= 3,
      cost_eur: c,
      selling_price_eur: p,
      ratio: Number(ratio.toFixed(2)),
      rules: { max_cost_eur: 10, min_selling_price_eur: 34.9, min_ratio: 3 }
    };
  });
};

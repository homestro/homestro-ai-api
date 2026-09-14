export default () => {
  shopify.tools.register('homestro_product_search', async ({ query = '', limit = 20 }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const response = await fetch(`/api/sidekick/products?${params.toString()}`);
    return response.json();
  });

  shopify.tools.register('homestro_price_check', async ({ cost, selling_price }) => {
    const response = await fetch('/api/sidekick/price-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cost, selling_price })
    });
    return response.json();
  });
};
